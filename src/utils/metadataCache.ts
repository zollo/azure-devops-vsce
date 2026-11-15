/**
 * Shared cache for Azure DevOps data that rarely changes while the extension runs, such as a
 * team's iterations, areas and members, a project's tags, or a work item type's states.
 *
 * Every panel and view used to fetch these on its own, every time it rendered. With this cache
 * they share one copy per key for `ttlMs`, and callers that ask while a load is still running
 * share that load instead of starting another. Failed loads are not cached.
 *
 * Keys should include the organization, project and team they belong to (see `metadataKey`),
 * so switching any of them never returns another project's data.
 */
export class MetadataCache {
    private readonly entries = new Map<string, { value: unknown; expires: number }>();
    private readonly pending = new Map<string, Promise<unknown>>();

    constructor(private readonly now: () => number = Date.now) {}

    /** Returns the cached value for `key`, or runs `load` once and caches its result. */
    getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
        const entry = this.entries.get(key);
        if (entry && entry.expires > this.now()) {
            return Promise.resolve(entry.value as T);
        }
        const inFlight = this.pending.get(key);
        if (inFlight) {
            return inFlight as Promise<T>;
        }
        const promise = (async () => {
            try {
                const value = await load();
                this.entries.set(key, { value, expires: this.now() + ttlMs });
                return value;
            } finally {
                this.pending.delete(key);
            }
        })();
        this.pending.set(key, promise);
        return promise;
    }

    /** Drops every entry whose key starts with `prefix` (all entries when it is empty). */
    invalidate(prefix = ''): void {
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
            }
        }
    }
}

/** Builds a cache key from its scope (organization, project, team...) and the kind of data. */
export function metadataKey(kind: string, ...scope: Array<string | undefined>): string {
    return [kind, ...scope.map(part => (part ?? '').toLowerCase())].join('|');
}

/** The cache shared by all views and panels. */
export const sharedMetadataCache = new MetadataCache();

/** How long team and project metadata is reused before it is fetched again. */
export const METADATA_TTL_MS = 10 * 60 * 1000;
