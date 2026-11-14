/**
 * Background check that the connection to Azure DevOps still works.
 *
 * This module has no `vscode` import so it can be unit tested in plain Node. The
 * extension supplies the probe, the silent token refresh and the sign-in prompt.
 */

/** Result of one lightweight request to Azure DevOps. */
export type ProbeResult = 'ok' | 'unauthorized' | 'unreachable';

/** What the monitor last saw. `unknown` until the first check finishes. */
export type ConnectionHealth = 'unknown' | 'connected' | 'offline' | 'authExpired';

export interface Timer {
    dispose(): void;
}

export interface ConnectionMonitorDeps {
    /** One cheap authenticated request (for example `/_apis/connectionData`). */
    probe(): Promise<ProbeResult>;
    /** Try to get a fresh token without any UI. Returns true if a different token is now in use. */
    refreshSilently(): Promise<boolean>;
    /**
     * Ask the user to sign in again (or enter a new PAT). Returns true if they did.
     * The monitor calls this at most once per expiry, never while a prompt is open.
     */
    promptReauthentication(): Promise<boolean>;
    /** Called whenever the health changes. */
    onHealthChange?(health: ConnectionHealth, previous: ConnectionHealth): void;
    /** Whether a check should run now (for example, skip while the window is unfocused). */
    shouldCheck?(): boolean;
    /** Defaults to setTimeout. Injected by tests. */
    schedule?(callback: () => void, delayMs: number): Timer;
    /** Defaults to Date.now. Injected by tests. */
    now?(): number;
}

export interface ConnectionMonitorOptions {
    /** Time between checks while healthy. 0 or less disables background checks. */
    intervalMs: number;
    /** First retry delay while offline; doubles up to `intervalMs`. */
    offlineRetryMs?: number;
    /** A check requested within this long of the last one reuses its result. */
    minCheckSpacingMs?: number;
}

/**
 * Classifies an HTTP status from the probe. Azure DevOps answers an invalid PAT with
 * 401, or sometimes 203 or a redirect to an HTML sign-in page, so all count as unauthorized.
 * Server errors and throttling count as unreachable; any other answer means the
 * service is up and accepted the credentials.
 */
export function classifyProbeStatus(status: number | undefined): ProbeResult {
    if (status === undefined || status === 0) {
        return 'unreachable';
    }
    // A redirect from this API is a redirect to the sign-in page.
    if (status === 401 || status === 203 || (status >= 300 && status < 400)) {
        return 'unauthorized';
    }
    if (status === 429 || status >= 500) {
        return 'unreachable';
    }
    return 'ok';
}

export class ConnectionMonitor {
    private health: ConnectionHealth = 'unknown';
    private running = false;
    private timer: Timer | undefined;
    private inFlight: Promise<ConnectionHealth> | undefined;
    private lastCheckAt = Number.NEGATIVE_INFINITY;
    private offlineAttempts = 0;
    private promptOpen = false;
    /** Set once we have prompted for the current expiry; cleared when the connection works again. */
    private promptedForThisExpiry = false;
    /** Bumped by reset(), so checks and prompts from before a sign-out cannot change state. */
    private generation = 0;

    private readonly schedule: (callback: () => void, delayMs: number) => Timer;
    private readonly now: () => number;
    private readonly offlineRetryMs: number;
    private readonly minCheckSpacingMs: number;

    constructor(private readonly deps: ConnectionMonitorDeps, private options: ConnectionMonitorOptions) {
        this.schedule = deps.schedule ?? ((callback, delayMs) => {
            const handle = setTimeout(callback, delayMs);
            return { dispose: () => clearTimeout(handle) };
        });
        this.now = deps.now ?? Date.now;
        this.offlineRetryMs = options.offlineRetryMs ?? 15_000;
        this.minCheckSpacingMs = options.minCheckSpacingMs ?? 5_000;
    }

    public getHealth(): ConnectionHealth {
        return this.health;
    }

    /** Starts periodic checks. The first one runs right away. */
    public start(): void {
        if (this.running) {
            return;
        }
        this.running = true;
        void this.tick();
    }

    public stop(): void {
        this.running = false;
        this.timer?.dispose();
        this.timer = undefined;
    }

    /** Changes the interval and reschedules. */
    public setInterval(intervalMs: number): void {
        this.options = { ...this.options, intervalMs };
        if (this.running) {
            this.scheduleNext();
        }
    }

    /** Forgets the current state, for example after the user signs out or signs in again. */
    public reset(): void {
        this.generation++;
        this.inFlight = undefined;
        this.offlineAttempts = 0;
        this.promptedForThisExpiry = false;
        this.lastCheckAt = Number.NEGATIVE_INFINITY;
        this.setHealth('unknown');
    }

    /**
     * Runs a check now, unless the last one finished less than `maxAgeMs` ago (pass 0 to
     * always check). Concurrent callers share one check.
     */
    public check(maxAgeMs = this.minCheckSpacingMs): Promise<ConnectionHealth> {
        if (this.inFlight) {
            return this.inFlight;
        }
        if (this.now() - this.lastCheckAt < maxAgeMs) {
            return Promise.resolve(this.health);
        }
        const check = this.runCheck().finally(() => {
            if (this.inFlight === check) {
                this.inFlight = undefined;
            }
            // Any check, not only a timer tick, restarts the timer, so an outage found by a
            // focus or manual check gets the short offline retry.
            this.scheduleNext();
        });
        this.inFlight = check;
        return check;
    }

    /** A regular request got a 401 that a silent refresh could not fix. */
    public reportAuthFailure(): void {
        void this.check(0);
    }

    private async tick(): Promise<void> {
        this.timer = undefined;
        if (!this.running) {
            return;
        }
        try {
            if (!this.deps.shouldCheck || this.deps.shouldCheck()) {
                await this.check();
            }
        } finally {
            this.scheduleNext();
        }
    }

    private scheduleNext(): void {
        this.timer?.dispose();
        this.timer = undefined;
        if (!this.running) {
            return;
        }
        const delay = this.nextDelayMs();
        if (delay > 0) {
            this.timer = this.schedule(() => void this.tick(), delay);
        }
    }

    /** Exposed for tests: how long until the next background check. 0 means none. */
    public nextDelayMs(): number {
        const interval = this.options.intervalMs;
        if (interval <= 0) {
            return 0;
        }
        if (this.health === 'offline' && this.offlineAttempts > 0) {
            const backoff = this.offlineRetryMs * 2 ** (this.offlineAttempts - 1);
            return Math.min(backoff, interval);
        }
        return interval;
    }

    private async runCheck(): Promise<ConnectionHealth> {
        const generation = this.generation;
        this.lastCheckAt = this.now();

        let result = await this.safeProbe();
        if (result === 'unauthorized' && generation === this.generation) {
            const refreshed = await this.safeRefresh();
            if (refreshed && generation === this.generation) {
                result = await this.safeProbe();
            }
        }
        if (generation !== this.generation) {
            // Signed out (or reset) while this check was running: drop its result.
            return this.health;
        }

        switch (result) {
            case 'ok':
                this.offlineAttempts = 0;
                this.promptedForThisExpiry = false;
                this.setHealth('connected');
                break;
            case 'unreachable':
                this.offlineAttempts++;
                this.setHealth('offline');
                break;
            case 'unauthorized':
                this.offlineAttempts = 0;
                this.setHealth('authExpired');
                this.maybePrompt();
                break;
        }
        return this.health;
    }

    private maybePrompt(): void {
        if (this.promptOpen || this.promptedForThisExpiry) {
            return;
        }
        const generation = this.generation;
        this.promptOpen = true;
        this.promptedForThisExpiry = true;
        this.deps.promptReauthentication()
            .catch(() => false)
            .then(async (reauthenticated) => {
                this.promptOpen = false;
                if (reauthenticated && generation === this.generation) {
                    await this.check(0);
                }
            });
    }

    /** Lets the user ask for the prompt again (for example from the status bar), bypassing the once-per-expiry rule. */
    public async reauthenticate(): Promise<ConnectionHealth> {
        if (this.promptOpen) {
            return this.health;
        }
        this.promptOpen = true;
        try {
            const reauthenticated = await this.deps.promptReauthentication().catch(() => false);
            this.promptedForThisExpiry = true;
            if (reauthenticated) {
                return await this.check(0);
            }
            return this.health;
        } finally {
            this.promptOpen = false;
        }
    }

    private async safeProbe(): Promise<ProbeResult> {
        try {
            return await this.deps.probe();
        } catch {
            return 'unreachable';
        }
    }

    private async safeRefresh(): Promise<boolean> {
        try {
            return await this.deps.refreshSilently();
        } catch {
            return false;
        }
    }

    private setHealth(health: ConnectionHealth): void {
        const previous = this.health;
        if (previous === health) {
            return;
        }
        this.health = health;
        this.deps.onHealthChange?.(health, previous);
    }
}
