/**
 * Azure DevOps and Entra ID discovery used by the onboarding wizard: listing tenants,
 * organizations, projects and teams, and guessing sensible defaults. Nothing here imports
 * `vscode`, so it runs (and is tested) in plain Node; callers pass in an HTTP getter.
 */

/** Azure DevOps resource id, used as the OAuth scope `${id}/.default`. */
export const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
export const AZURE_DEVOPS_SCOPE = `${AZURE_DEVOPS_RESOURCE}/.default`;
export const ARM_SCOPE = 'https://management.azure.com/.default';

export interface HttpResponse {
    data: any;
    headers?: Record<string, unknown>;
}

/** GET `url` with query `params`, already authenticated. Rejects on non-2xx. */
export type HttpGet = (url: string, params?: Record<string, string | number | boolean>) => Promise<HttpResponse>;

export interface Tenant {
    id: string;
    name: string;
    domain?: string;
    isHome: boolean;
}

export interface Organization {
    id: string;
    name: string;
    url: string;
}

export interface Project {
    id: string;
    name: string;
    description?: string;
    lastUpdateTime?: string;
}

export interface Team {
    id: string;
    name: string;
    description?: string;
    /** The signed-in user is a member of this team. */
    isMember: boolean;
    /** This is the project's default team. */
    isDefault: boolean;
}

/** Where a suggested value came from, so the UI can explain it. */
export type SuggestionReason = 'gitRemote' | 'settings' | 'onlyOne' | 'recent' | 'membership' | 'defaultTeam' | 'first' | 'none';

export interface Suggestion<T> {
    value: T | undefined;
    reason: SuggestionReason;
}

// ---------------------------------------------------------------------------------------------
// Tokens and tenants
// ---------------------------------------------------------------------------------------------

export interface TokenClaims {
    tid?: string;
    oid?: string;
    upn?: string;
    unique_name?: string;
    preferred_username?: string;
    name?: string;
}

/** Reads the payload of a JWT without verifying it (it only labels the UI; the server verifies). */
export function decodeJwtClaims(token: string): TokenClaims {
    const parts = token.split('.');
    if (parts.length < 2) {
        return {};
    }
    try {
        const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const claims = JSON.parse(json);
        return claims && typeof claims === 'object' ? claims : {};
    } catch {
        return {};
    }
}

/** The domain part of the signed-in user's name, e.g. contoso.com, used to label the home tenant. */
export function domainFromClaims(claims: TokenClaims): string | undefined {
    const name = claims.upn || claims.preferred_username || claims.unique_name || '';
    const at = name.lastIndexOf('@');
    return at > 0 ? name.slice(at + 1).toLowerCase() : undefined;
}

/**
 * Builds the tenant list from Azure Resource Manager's `GET /tenants` response, making sure the
 * home tenant (from the token) is present and listed first. The rest are sorted by name.
 */
export function parseTenants(armResponse: any, homeTenantId: string | undefined, homeDomain?: string): Tenant[] {
    const byId = new Map<string, Tenant>();
    const values: any[] = Array.isArray(armResponse?.value) ? armResponse.value : [];
    for (const t of values) {
        const id = typeof t?.tenantId === 'string' ? t.tenantId.toLowerCase() : '';
        if (!id || byId.has(id)) {
            continue;
        }
        const domain: string | undefined = t.defaultDomain || (Array.isArray(t.domains) ? t.domains[0] : undefined);
        byId.set(id, {
            id,
            name: (t.displayName && String(t.displayName).trim()) || domain || id,
            domain,
            isHome: false
        });
    }

    const homeId = homeTenantId?.toLowerCase();
    if (homeId) {
        const home = byId.get(homeId) ?? { id: homeId, name: homeDomain || 'Home directory', domain: homeDomain, isHome: true };
        home.isHome = true;
        if (!home.domain && homeDomain) {
            home.domain = homeDomain;
        }
        byId.set(homeId, home);
    }

    return [...byId.values()].sort((a, b) =>
        a.isHome === b.isHome ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isHome ? -1 : 1
    );
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Accepts a tenant GUID or a verified domain (contoso.onmicrosoft.com); returns it normalized, or undefined. */
export function normalizeTenantInput(input: string): string | undefined {
    const value = input.trim().toLowerCase();
    if (GUID.test(value) || DOMAIN.test(value)) {
        return value;
    }
    return undefined;
}

// ---------------------------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------------------------

/** Turns any organization URL form into https://dev.azure.com/{org} or https://{org}.visualstudio.com. */
export function normalizeOrganizationUrl(input: string): string | undefined {
    let value = input.trim();
    if (!value) {
        return undefined;
    }
    if (!/^https?:\/\//i.test(value)) {
        // A bare organization name.
        if (/^[a-z0-9][a-z0-9-]{0,49}$/i.test(value)) {
            return `https://dev.azure.com/${value}`;
        }
        value = `https://${value}`;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split('/').filter(Boolean);
    if (host === 'dev.azure.com' || host === 'vssps.dev.azure.com') {
        return segments[0] ? `https://dev.azure.com/${segments[0]}` : undefined;
    }
    const legacy = /^([a-z0-9-]+)\.(?:vssps\.)?visualstudio\.com$/i.exec(host);
    if (legacy) {
        return `https://${legacy[1].toLowerCase()}.visualstudio.com`;
    }
    // Azure DevOps Server: keep the collection URL as given, without a trailing slash.
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Organization name from a normalized organization URL. */
export function organizationNameFromUrl(url: string): string {
    const legacy = /^https:\/\/([^.]+)\.visualstudio\.com/i.exec(url);
    if (legacy) {
        return legacy[1];
    }
    const segments = url.replace(/^https?:\/\/[^/]+/i, '').split('/').filter(Boolean);
    return segments[segments.length - 1] || url;
}

/** Parses `GET app.vssps.visualstudio.com/_apis/accounts?memberId=…`, sorted by name. */
export function parseOrganizations(accountsResponse: any): Organization[] {
    const values: any[] = Array.isArray(accountsResponse?.value) ? accountsResponse.value : [];
    const seen = new Set<string>();
    const orgs: Organization[] = [];
    for (const account of values) {
        const name = typeof account?.accountName === 'string' ? account.accountName : '';
        if (!name) {
            continue;
        }
        const url = (account.accountUri && normalizeOrganizationUrl(String(account.accountUri))) || `https://dev.azure.com/${name}`;
        const key = url.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        orgs.push({ id: String(account.accountId ?? name), name, url });
    }
    return orgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export async function fetchOrganizations(get: HttpGet): Promise<Organization[]> {
    const profile = await get('https://app.vssps.visualstudio.com/_apis/profile/profiles/me', { 'api-version': '7.1' });
    const memberId = profile.data?.id;
    if (!memberId) {
        throw new Error('Could not read your Azure DevOps profile.');
    }
    const accounts = await get('https://app.vssps.visualstudio.com/_apis/accounts', { memberId, 'api-version': '7.1' });
    return parseOrganizations(accounts.data);
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export function parseProjects(projectsResponse: any): Project[] {
    const values: any[] = Array.isArray(projectsResponse?.value) ? projectsResponse.value : [];
    return values
        .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string')
        .map(p => ({
            id: p.id,
            name: p.name,
            description: typeof p.description === 'string' && p.description ? p.description : undefined,
            lastUpdateTime: typeof p.lastUpdateTime === 'string' ? p.lastUpdateTime : undefined
        }));
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | undefined {
    if (!headers) {
        return undefined;
    }
    const key = Object.keys(headers).find(k => k.toLowerCase() === name);
    const value = key ? headers[key] : undefined;
    return typeof value === 'string' && value ? value : undefined;
}

/** All projects in the organization, following continuation tokens. Sorted by name. */
export async function fetchProjects(get: HttpGet, orgUrl: string, maxPages = 20): Promise<Project[]> {
    const projects: Project[] = [];
    let continuationToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
        const params: Record<string, string | number> = { 'api-version': '7.1', '$top': 500 };
        if (continuationToken) {
            params.continuationToken = continuationToken;
        }
        const response = await get(`${orgUrl}/_apis/projects`, params);
        projects.push(...parseProjects(response.data));
        continuationToken = headerValue(response.headers, 'x-ms-continuationtoken');
        if (!continuationToken) {
            break;
        }
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// ---------------------------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------------------------

interface RawTeam {
    id: string;
    name: string;
    description?: string;
}

function parseRawTeams(response: any): RawTeam[] {
    const values: any[] = Array.isArray(response?.value) ? response.value : [];
    return values
        .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string')
        .map(t => ({ id: t.id, name: t.name, description: typeof t.description === 'string' && t.description ? t.description : undefined }));
}

/**
 * Merges the project's teams with the user's own teams (`$mine=true`) and the project's default
 * team. Teams the user belongs to come first, then the rest, each group sorted by name.
 */
export function mergeTeams(allTeams: any, myTeams: any, defaultTeamId: string | undefined): Team[] {
    const mine = new Set(parseRawTeams(myTeams).map(t => t.id.toLowerCase()));
    const byId = new Map<string, Team>();
    // Include "mine" teams too, in case the full list was truncated.
    for (const raw of [...parseRawTeams(allTeams), ...parseRawTeams(myTeams)]) {
        const key = raw.id.toLowerCase();
        if (byId.has(key)) {
            continue;
        }
        byId.set(key, {
            ...raw,
            isMember: mine.has(key),
            isDefault: !!defaultTeamId && key === defaultTeamId.toLowerCase()
        });
    }
    return [...byId.values()].sort((a, b) =>
        a.isMember === b.isMember ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.isMember ? -1 : 1
    );
}

async function fetchTeamPages(get: HttpGet, url: string, extra: Record<string, string | boolean>, pageSize: number, maxPages: number): Promise<RawTeam[]> {
    const teams: RawTeam[] = [];
    for (let page = 0; page < maxPages; page++) {
        const response = await get(url, { ...extra, 'api-version': '7.1', '$top': pageSize, '$skip': page * pageSize });
        const batch = parseRawTeams(response.data);
        teams.push(...batch);
        if (batch.length < pageSize) {
            break;
        }
    }
    return teams;
}

export interface TeamsResult {
    teams: Team[];
    /** Whether membership could be determined (the `$mine` query succeeded). */
    membershipKnown: boolean;
}

/**
 * Lists the project's teams and works out which the signed-in user belongs to.
 * `$mine=true` returns only teams the caller is a member of; the project's `defaultTeam`
 * comes from `GET /_apis/projects/{id}`.
 */
export async function fetchTeams(get: HttpGet, orgUrl: string, projectId: string, pageSize = 100, maxPages = 20): Promise<TeamsResult> {
    const url = `${orgUrl}/_apis/projects/${encodeURIComponent(projectId)}/teams`;
    const [all, mine, project] = await Promise.all([
        fetchTeamPages(get, url, {}, pageSize, maxPages),
        fetchTeamPages(get, url, { '$mine': true }, pageSize, maxPages).then(v => v, () => undefined),
        get(`${orgUrl}/_apis/projects/${encodeURIComponent(projectId)}`, { 'api-version': '7.1' }).then(r => r.data, () => undefined)
    ]);
    const defaultTeamId: string | undefined = typeof project?.defaultTeam?.id === 'string' ? project.defaultTeam.id : undefined;
    return {
        teams: mergeTeams({ value: all }, { value: mine ?? [] }, defaultTeamId),
        membershipKnown: mine !== undefined
    };
}

// ---------------------------------------------------------------------------------------------
// Git remotes
// ---------------------------------------------------------------------------------------------

export interface RemoteInfo {
    organizationUrl: string;
    organization: string;
    project: string;
}

function decode(segment: string): string {
    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

/**
 * Recognizes Azure Repos remotes:
 *   https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 */
export function parseAzureReposRemote(remote: string): RemoteInfo | undefined {
    const value = remote.trim();

    const ssh = /^(?:ssh:\/\/)?[^@\s]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::22)?[:/]v3\/([^/]+)\/([^/]+)\/[^/]+$/i.exec(value);
    if (ssh) {
        const organization = decode(ssh[1]);
        const legacyHost = /vs-ssh\.visualstudio\.com/i.test(value);
        return {
            organization,
            organizationUrl: legacyHost ? `https://${organization.toLowerCase()}.visualstudio.com` : `https://dev.azure.com/${organization}`,
            project: decode(ssh[2])
        };
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    const gitIndex = segments.findIndex(s => s.toLowerCase() === '_git');
    if (gitIndex < 1) {
        return undefined;
    }
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com') {
        // /{org}/{project}/_git/{repo}; a repo named like its project may omit the project.
        const organization = decode(segments[0]);
        const project = gitIndex >= 2 ? decode(segments[gitIndex - 1]) : decode(segments[gitIndex + 1] ?? '');
        return project ? { organization, organizationUrl: `https://dev.azure.com/${organization}`, project } : undefined;
    }
    const legacy = /^([a-z0-9-]+)\.visualstudio\.com$/i.exec(host);
    if (legacy) {
        const organization = legacy[1].toLowerCase();
        const before = segments.slice(0, gitIndex).filter(s => s.toLowerCase() !== 'defaultcollection');
        const project = before.length ? decode(before[before.length - 1]) : decode(segments[gitIndex + 1] ?? '');
        return project ? { organization, organizationUrl: `https://${organization}.visualstudio.com`, project } : undefined;
    }
    return undefined;
}

/** Reads `url = …` lines from a .git/config file. */
export function remoteUrlsFromGitConfig(gitConfig: string): string[] {
    const urls: string[] = [];
    let inRemote = false;
    for (const line of gitConfig.split(/\r?\n/)) {
        const section = /^\s*\[([^\]]+)\]/.exec(line);
        if (section) {
            inRemote = /^remote\s+"/i.test(section[1].trim());
            continue;
        }
        const url = inRemote ? /^\s*url\s*=\s*(.+?)\s*$/i.exec(line) : null;
        if (url) {
            urls.push(url[1]);
        }
    }
    return urls;
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

export interface Hints {
    remotes: RemoteInfo[];
    organizationUrl?: string;
    project?: string;
    teams?: string[];
}

function sameOrg(a: string, b: string): boolean {
    return normalizeOrganizationUrl(a)?.toLowerCase() === normalizeOrganizationUrl(b)?.toLowerCase();
}

/** Picks the organization to preselect: Git remote, then saved settings, then the only one, then the first. */
export function suggestOrganization(orgs: Organization[], hints: Hints): Suggestion<Organization> {
    for (const remote of hints.remotes) {
        const match = orgs.find(o => sameOrg(o.url, remote.organizationUrl) || o.name.toLowerCase() === remote.organization.toLowerCase());
        if (match) {
            return { value: match, reason: 'gitRemote' };
        }
    }
    if (hints.organizationUrl) {
        const match = orgs.find(o => sameOrg(o.url, hints.organizationUrl!));
        if (match) {
            return { value: match, reason: 'settings' };
        }
    }
    if (orgs.length === 1) {
        return { value: orgs[0], reason: 'onlyOne' };
    }
    return orgs.length ? { value: orgs[0], reason: 'first' } : { value: undefined, reason: 'none' };
}

/** Picks the project: Git remote for this org, then saved settings, then the only one, then the most recently updated. */
export function suggestProject(projects: Project[], orgUrl: string, hints: Hints): Suggestion<Project> {
    const byName = (name: string) => projects.find(p => p.name.toLowerCase() === name.toLowerCase());
    for (const remote of hints.remotes) {
        if (sameOrg(remote.organizationUrl, orgUrl)) {
            const match = byName(remote.project);
            if (match) {
                return { value: match, reason: 'gitRemote' };
            }
        }
    }
    if (hints.project && (!hints.organizationUrl || sameOrg(hints.organizationUrl, orgUrl))) {
        const match = byName(hints.project);
        if (match) {
            return { value: match, reason: 'settings' };
        }
    }
    if (projects.length === 1) {
        return { value: projects[0], reason: 'onlyOne' };
    }
    const dated = projects.filter(p => p.lastUpdateTime && !isNaN(Date.parse(p.lastUpdateTime)));
    if (dated.length) {
        const latest = dated.reduce((a, b) => (Date.parse(b.lastUpdateTime!) > Date.parse(a.lastUpdateTime!) ? b : a));
        return { value: latest, reason: 'recent' };
    }
    return projects.length ? { value: projects[0], reason: 'first' } : { value: undefined, reason: 'none' };
}

/**
 * Picks the teams to preselect: teams saved in settings (if still present), else every team the
 * user belongs to, else the project's default team, else the only team.
 */
export function suggestTeams(teams: Team[], hints: { teams?: string[] }): Suggestion<Team[]> {
    if (hints.teams?.length) {
        const wanted = new Set(hints.teams.map(t => t.toLowerCase()));
        const saved = teams.filter(t => wanted.has(t.name.toLowerCase()));
        if (saved.length) {
            // Keep the saved order so the first (primary) team stays first.
            saved.sort((a, b) => hints.teams!.findIndex(n => n.toLowerCase() === a.name.toLowerCase())
                - hints.teams!.findIndex(n => n.toLowerCase() === b.name.toLowerCase()));
            return { value: saved, reason: 'settings' };
        }
    }
    const mine = teams.filter(t => t.isMember);
    if (mine.length) {
        // The default team first if the user is in it: it is usually the one they want as primary.
        return { value: [...mine.filter(t => t.isDefault), ...mine.filter(t => !t.isDefault)], reason: 'membership' };
    }
    const fallback = teams.find(t => t.isDefault);
    if (fallback) {
        return { value: [fallback], reason: 'defaultTeam' };
    }
    if (teams.length === 1) {
        return { value: [teams[0]], reason: 'onlyOne' };
    }
    return { value: [], reason: 'none' };
}

/** A short, human explanation for a suggestion, shown under the field. */
export function describeReason(reason: SuggestionReason, kind: 'organization' | 'project' | 'teams'): string | undefined {
    switch (reason) {
        case 'gitRemote': return 'Detected from the Git remote of the open workspace.';
        case 'settings': return 'From your existing settings.';
        case 'onlyOne': return kind === 'teams' ? 'This project has one team.' : `This is the only ${kind} you have access to.`;
        case 'recent': return 'Your most recently updated project.';
        case 'membership': return 'Teams you are a member of.';
        case 'defaultTeam': return "You aren't a member of any team here, so we picked the project's default team.";
        default: return undefined;
    }
}
