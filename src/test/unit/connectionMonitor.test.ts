import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    classifyProbeStatus,
    ConnectionHealth,
    ConnectionMonitor,
    ConnectionMonitorDeps,
    ProbeResult
} from '../../authentication/connectionMonitor';

/** Lets the prompt's follow-up check (fire-and-forget) settle. */
const flush = () => new Promise(resolve => setImmediate(resolve));

interface Harness {
    monitor: ConnectionMonitor;
    probes: ProbeResult[];
    probeCalls: number;
    refreshCalls: number;
    promptCalls: number;
    changes: Array<[ConnectionHealth, ConnectionHealth]>;
    scheduled: number[];
    clock: { now: number };
    refreshResult: boolean;
    promptResult: () => Promise<boolean>;
    focused: boolean;
}

function createHarness(intervalMs = 120_000, overrides: Partial<ConnectionMonitorDeps> = {}): Harness {
    const h = {
        probes: [] as ProbeResult[],
        probeCalls: 0,
        refreshCalls: 0,
        promptCalls: 0,
        changes: [] as Array<[ConnectionHealth, ConnectionHealth]>,
        scheduled: [] as number[],
        clock: { now: 1_000_000 },
        refreshResult: false,
        promptResult: async () => false,
        focused: true
    } as Harness;

    h.monitor = new ConnectionMonitor(
        {
            probe: async () => {
                h.probeCalls++;
                return h.probes.shift() ?? 'ok';
            },
            refreshSilently: async () => {
                h.refreshCalls++;
                return h.refreshResult;
            },
            promptReauthentication: () => {
                h.promptCalls++;
                return h.promptResult();
            },
            onHealthChange: (health, previous) => h.changes.push([health, previous]),
            shouldCheck: () => h.focused,
            schedule: (_callback, delayMs) => {
                h.scheduled.push(delayMs);
                return { dispose: () => {} };
            },
            now: () => h.clock.now,
            ...overrides
        },
        { intervalMs, offlineRetryMs: 15_000, minCheckSpacingMs: 5_000 }
    );
    return h;
}

test('classifyProbeStatus maps HTTP statuses', () => {
    assert.equal(classifyProbeStatus(200), 'ok');
    assert.equal(classifyProbeStatus(404), 'ok');
    assert.equal(classifyProbeStatus(401), 'unauthorized');
    assert.equal(classifyProbeStatus(203), 'unauthorized');
    assert.equal(classifyProbeStatus(302), 'unauthorized');
    assert.equal(classifyProbeStatus(429), 'unreachable');
    assert.equal(classifyProbeStatus(503), 'unreachable');
    assert.equal(classifyProbeStatus(undefined), 'unreachable');
    assert.equal(classifyProbeStatus(0), 'unreachable');
});

test('a successful probe marks the connection as connected', async () => {
    const h = createHarness();
    assert.equal(await h.monitor.check(0), 'connected');
    assert.deepEqual(h.changes, [['connected', 'unknown']]);
    assert.equal(h.refreshCalls, 0);
    assert.equal(h.promptCalls, 0);
});

test('an expired token is refreshed silently without prompting', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'ok');
    h.refreshResult = true;
    assert.equal(await h.monitor.check(0), 'connected');
    assert.equal(h.refreshCalls, 1);
    assert.equal(h.probeCalls, 2);
    assert.equal(h.promptCalls, 0);
});

test('prompts to re-authenticate when the silent refresh fails', async () => {
    const h = createHarness();
    h.probes.push('unauthorized');
    assert.equal(await h.monitor.check(0), 'authExpired');
    assert.equal(h.refreshCalls, 1);
    assert.equal(h.promptCalls, 1);
});

test('prompts when the refreshed token is also rejected', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'unauthorized');
    h.refreshResult = true;
    assert.equal(await h.monitor.check(0), 'authExpired');
    assert.equal(h.probeCalls, 2);
    assert.equal(h.promptCalls, 1);
});

test('does not prompt again for the same expiry after the user dismisses it', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'unauthorized', 'unauthorized');
    await h.monitor.check(0);
    await flush();
    await h.monitor.check(0);
    h.monitor.reportAuthFailure();
    await flush();
    assert.equal(h.promptCalls, 1);
    assert.equal(h.monitor.getHealth(), 'authExpired');
});

test('never opens a second prompt while one is still showing', async () => {
    const h = createHarness();
    let resolvePrompt: (value: boolean) => void = () => {};
    h.promptResult = () => new Promise(resolve => { resolvePrompt = resolve; });
    h.probes.push('unauthorized', 'unauthorized');
    await h.monitor.check(0);
    // The user has not answered yet; reauthenticate() must not stack another prompt.
    await h.monitor.reauthenticate();
    assert.equal(h.promptCalls, 1);
    resolvePrompt(false);
    await flush();
});

test('prompts again after the connection recovers and then expires again', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'ok', 'unauthorized');
    await h.monitor.check(0);
    await flush();
    await h.monitor.check(0);
    await h.monitor.check(0);
    await flush();
    assert.equal(h.promptCalls, 2);
});

test('re-checks right after the user signs in again', async () => {
    const h = createHarness();
    h.promptResult = async () => true;
    h.probes.push('unauthorized', 'ok');
    await h.monitor.check(0);
    await flush();
    assert.equal(h.monitor.getHealth(), 'connected');
    assert.deepEqual(h.changes.map(c => c[0]), ['authExpired', 'connected']);
});

test('reauthenticate() lets the user ask for the prompt again after dismissing it', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'ok');
    await h.monitor.check(0);
    await flush();
    h.promptResult = async () => true;
    assert.equal(await h.monitor.reauthenticate(), 'connected');
    assert.equal(h.promptCalls, 2);
});

test('network failures mark the connection offline without prompting', async () => {
    const h = createHarness(120_000, {
        probe: async () => { throw new Error('ENOTFOUND'); }
    });
    assert.equal(await h.monitor.check(0), 'offline');
    assert.equal(h.refreshCalls, 0);
    assert.equal(h.promptCalls, 0);
});

test('offline retries back off up to the normal interval', async () => {
    const h = createHarness(60_000);
    h.probes.push('unreachable', 'unreachable', 'unreachable', 'unreachable');
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
        await h.monitor.check(0);
        delays.push(h.monitor.nextDelayMs());
    }
    assert.deepEqual(delays, [15_000, 30_000, 60_000, 60_000]);
    await h.monitor.check(0);
    assert.equal(h.monitor.getHealth(), 'connected');
    assert.equal(h.monitor.nextDelayMs(), 60_000);
});

test('concurrent checks share one probe', async () => {
    const h = createHarness();
    const results = await Promise.all([h.monitor.check(0), h.monitor.check(0), h.monitor.check(0)]);
    assert.deepEqual(results, ['connected', 'connected', 'connected']);
    assert.equal(h.probeCalls, 1);
});

test('a check requested soon after the last one reuses its result', async () => {
    const h = createHarness();
    await h.monitor.check(0);
    h.clock.now += 1_000;
    await h.monitor.check();
    assert.equal(h.probeCalls, 1);
    h.clock.now += 10_000;
    await h.monitor.check();
    assert.equal(h.probeCalls, 2);
});

test('start() checks immediately and schedules the next check', async () => {
    const h = createHarness(90_000);
    h.monitor.start();
    await flush();
    assert.equal(h.probeCalls, 1);
    assert.equal(h.scheduled.at(-1), 90_000);
    h.monitor.stop();
});

test('background checks are skipped while shouldCheck() is false', async () => {
    const h = createHarness();
    h.focused = false;
    h.monitor.start();
    await flush();
    assert.equal(h.probeCalls, 0);
    assert.deepEqual(h.scheduled, [120_000]);
    h.monitor.stop();
});

test('an interval of 0 disables background checks', async () => {
    const h = createHarness(0);
    h.monitor.start();
    await flush();
    assert.equal(h.probeCalls, 1);
    assert.deepEqual(h.scheduled, []);
    h.monitor.stop();
});

test('reset() forgets the state so a new expiry prompts again', async () => {
    const h = createHarness();
    h.probes.push('unauthorized', 'unauthorized');
    await h.monitor.check(0);
    await flush();
    h.monitor.reset();
    assert.equal(h.monitor.getHealth(), 'unknown');
    await h.monitor.check(0);
    await flush();
    assert.equal(h.promptCalls, 2);
});

test('a manual check that finds an outage reschedules to the short offline retry', async () => {
    const h = createHarness(120_000);
    h.monitor.start();
    await flush();
    assert.equal(h.scheduled.at(-1), 120_000);
    h.probes.push('unreachable');
    await h.monitor.check(0);
    assert.equal(h.scheduled.at(-1), 15_000);
    h.monitor.stop();
});

test('a check still running when the user signs out cannot change state or prompt', async () => {
    let resolveProbe: (result: ProbeResult) => void = () => {};
    const h = createHarness(120_000, {
        probe: () => new Promise<ProbeResult>(resolve => { resolveProbe = resolve; })
    });
    const stale = h.monitor.check(0);
    h.monitor.reset();
    resolveProbe('unauthorized');
    await stale;
    await flush();
    assert.equal(h.monitor.getHealth(), 'unknown');
    assert.equal(h.refreshCalls, 0);
    assert.equal(h.promptCalls, 0);
});

test('after reset() a new check does not reuse the stale in-flight one', async () => {
    let calls = 0;
    const h = createHarness(120_000, {
        probe: () => {
            calls++;
            return calls === 1 ? new Promise<ProbeResult>(() => {}) : Promise.resolve('ok');
        }
    });
    void h.monitor.check(0);
    h.monitor.reset();
    assert.equal(await h.monitor.check(0), 'connected');
    assert.equal(calls, 2);
});
