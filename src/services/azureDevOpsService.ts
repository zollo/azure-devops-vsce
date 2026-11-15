import { METADATA_TTL_MS, MetadataCache, metadataKey, sharedMetadataCache } from '../utils/metadataCache';
import { fetchWorkItemsInBatches } from '../utils/workItemBatches';
import { log } from '../utils/logger';

/**
 * One place for the Azure DevOps lookups that views and panels share: team members,
 * iterations, area paths, work item type states, and batched work item loads.
 *
 * Team and project metadata is cached for 10 minutes per organization, project and team, and
 * callers that ask at the same time share one request. Failed requests are not cached.
 * Call `invalidate()` when the connection settings change or the person asks for a refresh.
 */

/** The parts of an axios instance this service uses, so tests can pass a fake. */
export interface HttpClient {
    get(url: string, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
    post(url: string, data?: unknown, config?: { params?: Record<string, unknown> }): Promise<{ data: any }>;
}

export interface ConnectionSource {
    getAxiosInstance(): HttpClient | null;
    getConfig(): { organizationUrl?: string; defaultProject?: string; defaultTeam?: string } | null | undefined;
}

export interface TeamMember {
    id: string;
    displayName: string;
    uniqueName: string;
}

export interface TeamIteration {
    id: string;
    name: string;
    path: string;
    startDate?: string;
    finishDate?: string;
    /** 'past', 'current', 'future', or 'unknown' when Azure DevOps doesn't say. */
    timeFrame: string;
    /** The iteration as Azure DevOps returned it, for views that show more of it. */
    raw: any;
}

export interface TeamFieldValues {
    /** The team's default area path, if it has one. */
    defaultValue?: string;
    /** Every area path the team owns, in Azure DevOps order. */
    areaPaths: string[];
}

export interface WorkItemLoadOptions {
    /** Field reference names to return. Cannot be combined with `expand`. */
    fields?: readonly string[];
    /** 'relations' to include links to parents, children and attachments. */
    expand?: 'relations' | 'all';
    /**
     * Project for the request URL. Left out, the organization-wide endpoint is used, which also
     * returns linked items and children that live in other projects.
     */
    project?: string;
}

const NO_TEAM = '';

function toMember(member: any): TeamMember | undefined {
    const identity = member?.identity;
    const displayName = identity?.displayName || '';
    const uniqueName = identity?.uniqueName || '';
    if (!displayName || !uniqueName) {
        return undefined;
    }
    return { id: identity?.id || '', displayName, uniqueName };
}

function byDisplayName(a: TeamMember, b: TeamMember): number {
    return a.displayName.localeCompare(b.displayName);
}

export class AzureDevOpsService {
    constructor(
        private readonly connection: ConnectionSource,
        private readonly cache: MetadataCache = sharedMetadataCache
    ) {}

    private http(): HttpClient {
        const http = this.connection.getAxiosInstance();
        if (!http) {
            throw new Error('Not connected to Azure DevOps');
        }
        return http;
    }

    private scope(): { org: string; project: string; team: string } {
        const config = this.connection.getConfig();
        return {
            org: config?.organizationUrl ?? '',
            project: config?.defaultProject ?? '',
            team: config?.defaultTeam ?? NO_TEAM
        };
    }

    private requireProject(): string {
        const { project } = this.scope();
        if (!project) {
            throw new Error('No Azure DevOps project is selected');
        }
        return project;
    }

    /** Forgets all cached team and project metadata. */
    invalidate(): void {
        this.cache.invalidate();
    }

    /** Members of one team (the configured team by default), sorted by name. Empty when no team is set. */
    getTeamMembers(team?: string): Promise<TeamMember[]> {
        const { org, project, team: configuredTeam } = this.scope();
        const teamName = team ?? configuredTeam;
        if (!project || !teamName) {
            return Promise.resolve([]);
        }
        return this.cache.getOrLoad(metadataKey('team-members', org, project, teamName), METADATA_TTL_MS, async () => {
            const response = await this.http().get(
                `/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(teamName)}/members`,
                { params: { 'api-version': '7.0' } }
            );
            return (response.data?.value || [])
                .map(toMember)
                .filter((m: TeamMember | undefined): m is TeamMember => !!m)
                .sort(byDisplayName);
        });
    }

    /**
     * People to offer as assignees: the configured team's members plus the members of the
     * project's first `maxTeams` teams, without duplicates, sorted by name. A team that can't be
     * read is skipped.
     */
    getProjectMembers(maxTeams = 5): Promise<TeamMember[]> {
        const { org, project, team } = this.scope();
        if (!project) {
            return Promise.resolve([]);
        }
        return this.cache.getOrLoad(metadataKey('project-members', org, project, team, String(maxTeams)), METADATA_TTL_MS, async () => {
            const http = this.http();
            const teamsResponse = await http.get(
                `/_apis/projects/${encodeURIComponent(project)}/teams`,
                { params: { 'api-version': '7.0', '$top': maxTeams } }
            ).catch(error => {
                log.warn('[AzureDevOps] Could not list project teams:', error);
                return { data: { value: [] } };
            });
            const teamIds: string[] = (teamsResponse.data?.value || []).slice(0, maxTeams).map((t: any) => String(t.id));

            const lists = await Promise.all([
                team ? this.getTeamMembers(team).catch(() => [] as TeamMember[]) : Promise.resolve([] as TeamMember[]),
                ...teamIds.map(id => this.getTeamMembers(id).catch(() => [] as TeamMember[]))
            ]);
            const byName = new Map<string, TeamMember>();
            for (const member of lists.flat()) {
                if (!byName.has(member.uniqueName)) {
                    byName.set(member.uniqueName, member);
                }
            }
            return [...byName.values()].sort(byDisplayName);
        });
    }

    /** All of the configured team's iterations (past, current and future), in Azure DevOps order. */
    getTeamIterations(): Promise<TeamIteration[]> {
        const { org, project, team } = this.scope();
        if (!project || !team) {
            return Promise.resolve([]);
        }
        return this.cache.getOrLoad(metadataKey('team-iterations', org, project, team), METADATA_TTL_MS, async () => {
            const response = await this.http().get(
                `/${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations`,
                { params: { 'api-version': '7.1' } }
            );
            return (response.data?.value || []).map((iteration: any): TeamIteration => ({
                id: iteration.id,
                name: iteration.name,
                path: iteration.path,
                startDate: iteration.attributes?.startDate,
                finishDate: iteration.attributes?.finishDate,
                timeFrame: iteration.attributes?.timeFrame || 'unknown',
                raw: iteration
            }));
        });
    }

    /** The path of the team's current iteration, or null when there isn't one. */
    async getCurrentIterationPath(): Promise<string | null> {
        const iterations = await this.getTeamIterations();
        return iterations.find(i => i.timeFrame === 'current')?.path ?? null;
    }

    /** The configured team's area paths. */
    getTeamFieldValues(): Promise<TeamFieldValues> {
        const { org, project, team } = this.scope();
        if (!project || !team) {
            return Promise.resolve({ areaPaths: [] });
        }
        return this.cache.getOrLoad(metadataKey('team-field-values', org, project, team), METADATA_TTL_MS, async () => {
            const response = await this.http().get(
                `/${encodeURIComponent(project)}/${encodeURIComponent(team)}/_apis/work/teamsettings/teamfieldvalues`,
                { params: { 'api-version': '7.1' } }
            );
            const data = response.data || {};
            const areaPaths: string[] = (data.values || [])
                .map((v: any) => v?.value)
                .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
            return { defaultValue: data.defaultValue || undefined, areaPaths };
        });
    }

    /** The team's main area path: its default value, else its first area path. */
    async getTeamAreaPath(): Promise<string | null> {
        const values = await this.getTeamFieldValues();
        return values.defaultValue ?? values.areaPaths[0] ?? null;
    }

    /** The state names of a work item type, in workflow order. */
    getWorkItemTypeStates(workItemType: string): Promise<string[]> {
        const { org, project } = this.scope();
        if (!project || !workItemType) {
            return Promise.resolve([]);
        }
        return this.cache.getOrLoad(metadataKey('type-states', org, project, workItemType), METADATA_TTL_MS, async () => {
            const response = await this.http().get(
                `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states`,
                { params: { 'api-version': '7.1' } }
            );
            return (response.data?.value || [])
                .map((s: any) => s?.name)
                .filter((name: unknown): name is string => typeof name === 'string' && name.length > 0);
        });
    }

    /** State name (lower case) to state category (Proposed, InProgress, Resolved, Completed, Removed). */
    getStateCategories(workItemType: string): Promise<Map<string, string>> {
        const { org, project } = this.scope();
        if (!project || !workItemType) {
            return Promise.resolve(new Map());
        }
        return this.cache.getOrLoad(metadataKey('state-categories', org, project, workItemType), METADATA_TTL_MS, async () => {
            const response = await this.http().get(
                `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(workItemType)}/states`,
                { params: { 'api-version': '7.1' } }
            );
            const categories = new Map<string, string>();
            for (const state of response.data?.value || []) {
                if (state?.name && state?.category) {
                    categories.set(String(state.name).toLowerCase(), String(state.category));
                }
            }
            return categories;
        });
    }

    /**
     * Loads work items by id: 200 per request, 3 requests at a time, in the order of `ids`.
     * Deleted or unreadable items are left out. Throws only when every batch failed.
     */
    async getWorkItems<T extends { id: number } = any>(ids: readonly number[], options: WorkItemLoadOptions = {}): Promise<T[]> {
        if (ids.length === 0) {
            return [];
        }
        const http = this.http();
        const url = options.project ? `/${encodeURIComponent(options.project)}/_apis/wit/workitems` : '/_apis/wit/workitems';
        let firstError: unknown;
        const items = await fetchWorkItemsInBatches<T>(
            ids,
            async batch => {
                const params: Record<string, unknown> = { ids: batch.join(','), errorPolicy: 'omit' };
                if (options.fields && options.fields.length > 0) {
                    params.fields = options.fields.join(',');
                } else if (options.expand) {
                    params['$expand'] = options.expand;
                }
                const response = await http.get(url, { params });
                return (response.data?.value || []).filter((item: unknown) => item);
            },
            error => {
                log.error('[AzureDevOps] Failed to load a batch of work items:', error);
                firstError = firstError ?? error;
            }
        );
        if (items.length === 0 && firstError) {
            throw firstError;
        }
        return items;
    }

    /** Runs a WIQL query in the configured project and returns at most `top` work item ids. */
    async queryWorkItemIds(wiql: string, top: number): Promise<number[]> {
        const project = this.requireProject();
        const response = await this.http().post(
            `/${encodeURIComponent(project)}/_apis/wit/wiql`,
            { query: wiql },
            { params: { '$top': top } }
        );
        return (response.data?.workItems || [])
            .map((ref: any) => ref?.id)
            .filter((id: unknown): id is number => typeof id === 'number')
            .slice(0, top);
    }
}

let instance: AzureDevOpsService | undefined;

/** Creates the shared service; called once on activation. */
export function initAzureDevOpsService(connection: ConnectionSource): AzureDevOpsService {
    instance = new AzureDevOpsService(connection);
    return instance;
}

/** The shared service. Throws if the extension hasn't activated it yet. */
export function azureDevOps(): AzureDevOpsService {
    if (!instance) {
        throw new Error('Azure DevOps service is not initialised');
    }
    return instance;
}
