/**
 * State machine behind the onboarding wizard. It owns the wizard state, talks to Azure DevOps
 * through injected dependencies and pushes the whole state to the webview after every change.
 * Nothing here imports `vscode`; `onboardingPanel.ts` supplies the real dependencies.
 */
import {
    decodeJwtClaims,
    describeReason,
    domainFromClaims,
    fetchOrganizations,
    fetchProjects,
    fetchTeams,
    Hints,
    HttpGet,
    normalizeOrganizationUrl,
    normalizeTenantInput,
    Organization,
    organizationNameFromUrl,
    sameOrganization,
    parseTenants,
    Project,
    suggestOrganization,
    suggestProject,
    suggestTeams,
    Team,
    Tenant
} from './discovery';

export type AuthMethod = 'microsoft' | 'pat';
export type Step = 'welcome' | 'signingIn' | 'pat' | 'review' | 'saving' | 'done';

export interface MicrosoftSession {
    id: string;
    accessToken: string;
    accountLabel: string;
}

export interface OnboardingResult {
    authMethod: AuthMethod;
    /** Microsoft sign-in only: the VS Code session id. */
    sessionId?: string;
    /** Microsoft sign-in only: set when the user picked a tenant other than their home tenant. */
    tenantId?: string;
    /** PAT only. */
    pat?: string;
    organizationUrl: string;
    project: string;
    /** Selected team names, primary first. */
    teams: string[];
}

export interface OnboardingDeps {
    /** Microsoft (Entra ID) sign-in for Azure DevOps; `tenant` undefined means the home tenant. */
    signInMicrosoft(tenant: string | undefined): Promise<MicrosoftSession | undefined>;
    /** Token for Azure Resource Manager, used only to list tenants. Interactive may prompt for consent. */
    getArmToken(interactive: boolean): Promise<string | undefined>;
    /** An HTTP getter that sends this Authorization header. */
    createHttp(authorization: string): HttpGet;
    /** Values detected from the workspace and settings. */
    getHints(): Promise<Hints>;
    save(result: OnboardingResult): Promise<void>;
    dismiss(): void;
    post(state: OnboardingState): void;
    log(message: string): void;
}

export interface OnboardingState {
    step: Step;
    authMethod?: AuthMethod;
    account?: string;
    error?: string;
    /** What is loading right now, e.g. 'projects'. */
    loading?: 'organizations' | 'projects' | 'teams' | 'tenants';
    tenants: Tenant[];
    tenantId?: string;
    canFindTenants: boolean;
    organizations: Organization[];
    organizationUrl?: string;
    organizationNote?: string;
    projects: Project[];
    projectId?: string;
    projectNote?: string;
    teams: Team[];
    selectedTeamIds: string[];
    primaryTeamId?: string;
    teamsNote?: string;
    /** The team lookup failed; the user must retry before finishing. */
    teamsFailed?: boolean;
    /** PAT step: the token could not list organizations, so ask for the URL. */
    patNeedsOrganization: boolean;
    patOrganizationHint?: string;
}

export function initialState(): OnboardingState {
    return {
        step: 'welcome',
        tenants: [],
        canFindTenants: false,
        organizations: [],
        projects: [],
        teams: [],
        selectedTeamIds: [],
        patNeedsOrganization: false
    };
}

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'chooseAuth'; method: AuthMethod }
    | { type: 'submitPat'; pat: string; organizationUrl?: string }
    | { type: 'back' }
    | { type: 'selectTenant'; tenantId: string }
    | { type: 'findTenants' }
    | { type: 'addTenant'; value: string }
    | { type: 'selectOrganization'; url: string }
    | { type: 'addOrganization'; url: string }
    | { type: 'selectProject'; projectId: string }
    | { type: 'setTeams'; teamIds: string[]; primaryTeamId?: string }
    | { type: 'finish' }
    | { type: 'dismiss' };

function errorMessage(error: unknown): string {
    const anyError = error as any;
    const status = anyError?.response?.status;
    if (status === 401 || status === 403) {
        return 'Azure DevOps rejected the credentials. Check that you have access and try again.';
    }
    if (status === 404) {
        return 'Azure DevOps could not find that organization.';
    }
    const message = anyError?.response?.data?.message || anyError?.message;
    return typeof message === 'string' && message ? message : 'Something went wrong.';
}

export class OnboardingController {
    private state: OnboardingState = initialState();
    private hints: Promise<Hints>;
    private http: HttpGet | undefined;
    private session: MicrosoftSession | undefined;
    private homeTenantId: string | undefined;
    private pat: string | undefined;
    /** Increments on every org/project change so late responses for an old selection are dropped. */
    private generation = 0;
    /** Increments on every sign-in attempt and on Back, so a sign-in that finishes late is ignored. */
    private authAttempt = 0;

    constructor(private readonly deps: OnboardingDeps) {
        this.hints = deps.getHints().catch(error => {
            deps.log(`Could not read workspace hints: ${errorMessage(error)}`);
            return { remotes: [] };
        });
    }

    public getState(): OnboardingState {
        return this.state;
    }

    private update(patch: Partial<OnboardingState>): void {
        this.state = { ...this.state, ...patch };
        this.deps.post(this.state);
    }

    public async handle(message: WebviewMessage): Promise<void> {
        try {
            switch (message.type) {
                case 'ready': this.deps.post(this.state); return;
                case 'chooseAuth': return await this.chooseAuth(message.method);
                case 'submitPat': return await this.submitPat(message.pat, message.organizationUrl);
                case 'back': return this.back();
                case 'selectTenant': return await this.selectTenant(message.tenantId);
                case 'findTenants': return await this.loadTenants(true);
                case 'addTenant': return await this.addTenant(message.value);
                case 'selectOrganization': return await this.selectOrganization(message.url);
                case 'addOrganization': return await this.addOrganization(message.url);
                case 'selectProject': return await this.selectProject(message.projectId);
                case 'setTeams': return this.setTeams(message.teamIds, message.primaryTeamId);
                case 'finish': return await this.finish();
                case 'dismiss': this.deps.dismiss(); return;
            }
        } catch (error) {
            this.deps.log(`Onboarding: ${errorMessage(error)}`);
            this.update({ error: errorMessage(error), loading: undefined });
        }
    }

    private back(): void {
        this.generation++;
        this.authAttempt++;
        this.http = undefined;
        this.session = undefined;
        this.pat = undefined;
        this.state = initialState();
        this.deps.post(this.state);
    }

    // -----------------------------------------------------------------------------------------
    // Authentication
    // -----------------------------------------------------------------------------------------

    private async chooseAuth(method: AuthMethod): Promise<void> {
        if (method === 'pat') {
            const hints = await this.hints;
            const hint = hints.remotes[0]?.organizationUrl || hints.organizationUrl || undefined;
            this.update({ step: 'pat', authMethod: 'pat', error: undefined, patNeedsOrganization: false, patOrganizationHint: hint });
            return;
        }

        const attempt = ++this.authAttempt;
        this.update({ step: 'signingIn', authMethod: 'microsoft', error: undefined });
        let session: MicrosoftSession | undefined;
        try {
            session = await this.deps.signInMicrosoft(undefined);
        } catch (error) {
            if (attempt !== this.authAttempt) {
                return;
            }
            this.update({ step: 'welcome', error: `Sign-in failed: ${errorMessage(error)}` });
            return;
        }
        if (attempt !== this.authAttempt) {
            return;
        }
        if (!session) {
            this.update({ step: 'welcome', error: 'Sign-in was cancelled.' });
            return;
        }

        const claims = decodeJwtClaims(session.accessToken);
        this.homeTenantId = claims.tid?.toLowerCase();
        this.useMicrosoftSession(session);
        const tenants = parseTenants(undefined, this.homeTenantId, domainFromClaims(claims));
        this.update({
            step: 'review',
            account: session.accountLabel,
            tenants,
            tenantId: this.homeTenantId,
            canFindTenants: true
        });
        // Listing other tenants needs an ARM token; try silently so we don't ask for more consent.
        void this.loadTenants(false);
        await this.loadOrganizations();
    }

    private useMicrosoftSession(session: MicrosoftSession): void {
        this.session = session;
        this.http = this.deps.createHttp(`Bearer ${session.accessToken}`);
    }

    private async submitPat(rawPat: string, rawOrgUrl: string | undefined): Promise<void> {
        const pat = rawPat.trim();
        if (!pat) {
            this.update({ error: 'Enter a personal access token.' });
            return;
        }
        const attempt = ++this.authAttempt;
        const stale = () => attempt !== this.authAttempt;
        this.pat = pat;
        this.http = this.deps.createHttp(`Basic ${Buffer.from(`:${pat}`).toString('base64')}`);
        this.update({ error: undefined, loading: 'organizations' });

        const typedUrl = rawOrgUrl?.trim();
        if (typedUrl) {
            const url = normalizeOrganizationUrl(typedUrl);
            if (!url) {
                this.update({ loading: undefined, error: 'That does not look like an organization URL.' });
                return;
            }
            try {
                await this.verifyOrganization(url);
            } catch (error) {
                if (!stale()) {
                    this.update({ loading: undefined, error: `Could not connect to that organization: ${errorMessage(error)}` });
                }
                return;
            }
            if (stale()) {
                return;
            }
            this.update({ step: 'review', account: 'Personal access token' });
            await this.applyOrganizations([{ id: url, name: organizationNameFromUrl(url), url }]);
            return;
        }

        try {
            const orgs = await fetchOrganizations(this.http);
            if (stale()) {
                return;
            }
            if (orgs.length) {
                this.update({ step: 'review', account: 'Personal access token' });
                await this.applyOrganizations(orgs);
                return;
            }
        } catch (error) {
            if (stale()) {
                return;
            }
            this.deps.log(`PAT could not list organizations: ${errorMessage(error)}`);
            const status = (error as any)?.response?.status;
            if (status === 401) {
                this.update({ loading: undefined, error: 'Azure DevOps rejected this token. Check that it is valid and has not expired.' });
                return;
            }
        }

        // The token may be scoped to one organization; try the detected one before asking.
        const hint = this.state.patOrganizationHint;
        if (hint) {
            try {
                await this.verifyOrganization(hint);
                if (stale()) {
                    return;
                }
                this.update({ step: 'review', account: 'Personal access token' });
                await this.applyOrganizations([{ id: hint, name: organizationNameFromUrl(hint), url: hint }]);
                return;
            } catch {
                // Fall through and ask.
            }
        }
        if (stale()) {
            return;
        }
        this.update({
            loading: undefined,
            patNeedsOrganization: true,
            error: "This token can't list your organizations (it may be limited to one). Enter the organization URL."
        });
    }

    private async verifyOrganization(url: string): Promise<void> {
        if (!this.http) {
            throw new Error('Not signed in.');
        }
        await this.http(`${url}/_apis/connectionData`, { 'api-version': '7.1-preview.1' });
    }

    // -----------------------------------------------------------------------------------------
    // Tenants (Microsoft sign-in only)
    // -----------------------------------------------------------------------------------------

    private async loadTenants(interactive: boolean): Promise<void> {
        if (interactive) {
            this.update({ loading: 'tenants', error: undefined });
        }
        try {
            const token = await this.deps.getArmToken(interactive);
            if (!token) {
                if (interactive) {
                    this.update({ loading: undefined, error: 'Could not list your directories. You can enter a tenant ID or domain instead.' });
                }
                return;
            }
            const response = await this.deps.createHttp(`Bearer ${token}`)('https://management.azure.com/tenants', { 'api-version': '2022-12-01' });
            const home = this.state.tenants.find(t => t.isHome);
            // Ignore a late answer after the user went back or switched to a PAT.
            if (this.state.authMethod !== 'microsoft' || this.state.step !== 'review') {
                return;
            }
            const tenants = parseTenants(response.data, this.homeTenantId, home?.domain);
            // Keep tenants the user typed in by hand.
            for (const existing of this.state.tenants) {
                if (!tenants.some(t => t.id === existing.id)) {
                    tenants.push(existing);
                }
            }
            this.update({ tenants, canFindTenants: false, loading: this.state.loading === 'tenants' ? undefined : this.state.loading });
        } catch (error) {
            this.deps.log(`Could not list tenants: ${errorMessage(error)}`);
            if (interactive) {
                this.update({ loading: undefined, error: 'Could not list your directories. You can enter a tenant ID or domain instead.' });
            }
        }
    }

    private async addTenant(value: string): Promise<void> {
        const tenant = normalizeTenantInput(value);
        if (!tenant) {
            this.update({ error: 'Enter a tenant ID (a GUID) or a domain such as contoso.onmicrosoft.com.' });
            return;
        }
        if (!this.state.tenants.some(t => t.id === tenant)) {
            this.update({ tenants: [...this.state.tenants, { id: tenant, name: tenant, isHome: false }] });
        }
        await this.selectTenant(tenant);
    }

    private async selectTenant(tenantId: string): Promise<void> {
        if (this.state.authMethod !== 'microsoft' || tenantId === this.state.tenantId) {
            return;
        }
        const attempt = ++this.authAttempt;
        const previous = this.state.tenantId;
        this.update({ tenantId, error: undefined, loading: 'organizations' });
        const isHome = tenantId === this.homeTenantId;
        let session: MicrosoftSession | undefined;
        try {
            session = await this.deps.signInMicrosoft(isHome ? undefined : tenantId);
        } catch (error) {
            if (attempt !== this.authAttempt) {
                return;
            }
            this.update({ tenantId: previous, loading: undefined, error: `Could not sign in to that directory: ${errorMessage(error)}` });
            return;
        }
        if (attempt !== this.authAttempt) {
            return;
        }
        if (!session) {
            this.update({ tenantId: previous, loading: undefined, error: 'Sign-in to that directory was cancelled.' });
            return;
        }
        this.useMicrosoftSession(session);
        this.update({ account: session.accountLabel });
        await this.loadOrganizations();
    }

    // -----------------------------------------------------------------------------------------
    // Organizations, projects, teams
    // -----------------------------------------------------------------------------------------

    private async loadOrganizations(): Promise<void> {
        if (!this.http) {
            return;
        }
        const generation = ++this.generation;
        this.update({ loading: 'organizations', organizations: [], projects: [], teams: [], selectedTeamIds: [], primaryTeamId: undefined });
        let orgs: Organization[];
        try {
            orgs = await fetchOrganizations(this.http);
        } catch (error) {
            if (generation !== this.generation) {
                return;
            }
            this.deps.log(`Could not list organizations: ${errorMessage(error)}`);
            orgs = [];
        }
        if (generation !== this.generation) {
            return;
        }
        if (!orgs.length) {
            this.update({
                loading: undefined,
                organizationUrl: undefined,
                organizationNote: 'No organizations found in this directory. Pick another directory, or enter an organization URL.'
            });
            return;
        }
        await this.applyOrganizations(orgs);
    }

    private async applyOrganizations(orgs: Organization[]): Promise<void> {
        const suggestion = suggestOrganization(orgs, await this.hints);
        this.update({ organizations: orgs });
        if (suggestion.value) {
            await this.selectOrganization(suggestion.value.url, describeReason(suggestion.reason, 'organization'));
        } else {
            this.update({ loading: undefined });
        }
    }

    private async addOrganization(rawUrl: string): Promise<void> {
        const url = normalizeOrganizationUrl(rawUrl);
        if (!url) {
            this.update({ error: 'That does not look like an organization URL.' });
            return;
        }
        this.update({ error: undefined, loading: 'organizations' });
        await this.verifyOrganization(url);
        const exists = this.state.organizations.some(o => o.url.toLowerCase() === url.toLowerCase());
        if (!exists) {
            this.update({ organizations: [...this.state.organizations, { id: url, name: organizationNameFromUrl(url), url }] });
        }
        await this.selectOrganization(url);
    }

    private async selectOrganization(url: string, note?: string): Promise<void> {
        if (!this.http) {
            return;
        }
        const generation = ++this.generation;
        this.update({
            organizationUrl: url,
            organizationNote: note,
            error: undefined,
            loading: 'projects',
            projects: [],
            projectId: undefined,
            projectNote: undefined,
            teams: [],
            selectedTeamIds: [],
            primaryTeamId: undefined,
            teamsNote: undefined
        });
        let projects: Project[];
        try {
            projects = await fetchProjects(this.http, url);
        } catch (error) {
            if (generation === this.generation) {
                this.update({ loading: undefined, error: `Could not load projects: ${errorMessage(error)}` });
            }
            return;
        }
        if (generation !== this.generation) {
            return;
        }
        if (!projects.length) {
            this.update({ loading: undefined, projects, projectNote: "You don't have access to any projects in this organization." });
            return;
        }
        const suggestion = suggestProject(projects, url, await this.hints);
        this.update({ projects });
        if (suggestion.value) {
            await this.selectProject(suggestion.value.id, describeReason(suggestion.reason, 'project'));
        }
    }

    private async selectProject(projectId: string, note?: string): Promise<void> {
        const orgUrl = this.state.organizationUrl;
        if (!this.http || !orgUrl) {
            return;
        }
        const generation = ++this.generation;
        this.update({ projectId, projectNote: note, error: undefined, loading: 'teams', teams: [], selectedTeamIds: [], primaryTeamId: undefined, teamsNote: undefined, teamsFailed: false });
        let result;
        try {
            result = await fetchTeams(this.http, orgUrl, projectId);
        } catch (error) {
            if (generation === this.generation) {
                this.update({ loading: undefined, teamsFailed: true, teamsNote: `Could not load teams: ${errorMessage(error)}` });
            }
            return;
        }
        if (generation !== this.generation) {
            return;
        }
        const hints = await this.hints;
        // Saved teams only apply to the organization and project they were saved for.
        const sameProject = !!hints.organizationUrl && sameOrganization(hints.organizationUrl, orgUrl)
            && this.state.projects.find(p => p.id === projectId)?.name.toLowerCase() === hints.project?.toLowerCase();
        const suggestion = suggestTeams(result.teams, { teams: sameProject ? hints.teams : undefined });
        const selected = suggestion.value ?? [];
        let teamsNote = describeReason(suggestion.reason, 'teams');
        if (!result.membershipKnown && suggestion.reason !== 'settings') {
            teamsNote = "We couldn't check which teams you're in, so pick the ones you work with.";
        }
        if (!result.teams.length) {
            teamsNote = 'This project has no teams.';
        }
        this.update({
            loading: undefined,
            teams: result.teams,
            selectedTeamIds: selected.map(t => t.id),
            primaryTeamId: selected[0]?.id,
            teamsNote
        });
    }

    private setTeams(teamIds: string[], primaryTeamId: string | undefined): void {
        const known = new Set(this.state.teams.map(t => t.id));
        const selected = teamIds.filter(id => known.has(id));
        const primary = primaryTeamId && selected.includes(primaryTeamId) ? primaryTeamId : selected[0];
        this.update({ selectedTeamIds: selected, primaryTeamId: primary, error: undefined });
    }

    // -----------------------------------------------------------------------------------------
    // Finish
    // -----------------------------------------------------------------------------------------

    /** Selected team names with the primary team first, in list order otherwise. */
    public orderedTeamNames(): string[] {
        const { teams, selectedTeamIds, primaryTeamId } = this.state;
        const selected = teams.filter(t => selectedTeamIds.includes(t.id));
        selected.sort((a, b) => (a.id === primaryTeamId ? -1 : b.id === primaryTeamId ? 1 : 0));
        return selected.map(t => t.name);
    }

    private async finish(): Promise<void> {
        const { authMethod, organizationUrl, projectId, projects } = this.state;
        const project = projects.find(p => p.id === projectId);
        if (!authMethod || !organizationUrl || !project) {
            this.update({ error: 'Pick an organization and a project first.' });
            return;
        }
        if (this.state.teamsFailed || this.state.loading) {
            this.update({ error: 'Teams are still loading or could not be loaded. Retry before continuing.' });
            return;
        }
        const teams = this.orderedTeamNames();
        if (this.state.teams.length && !teams.length) {
            this.update({ error: 'Pick at least one team. Boards, backlogs and sprints are per team.' });
            return;
        }
        const result: OnboardingResult = {
            authMethod,
            organizationUrl,
            project: project.name,
            teams
        };
        if (authMethod === 'microsoft') {
            if (!this.session) {
                this.update({ error: 'Your sign-in was lost. Go back and sign in again.' });
                return;
            }
            result.sessionId = this.session.id;
            if (this.state.tenantId && this.state.tenantId !== this.homeTenantId) {
                result.tenantId = this.state.tenantId;
            }
        } else {
            result.pat = this.pat;
        }

        this.update({ step: 'saving', error: undefined });
        try {
            await this.deps.save(result);
            this.update({ step: 'done' });
        } catch (error) {
            this.update({ step: 'review', error: `Could not save your settings: ${errorMessage(error)}` });
        }
    }
}
