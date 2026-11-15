/** Azure DevOps returns at most this many work items from one `_apis/wit/workitems?ids=` call. */
export const MAX_IDS_PER_REQUEST = 200;

/** The fields the work item lists and trees show. Asking for these instead of `$expand=all` keeps responses small. */
export const LIST_FIELDS = [
    'System.Id',
    'System.Title',
    'System.State',
    'System.WorkItemType',
    'System.AssignedTo',
    'System.CreatedDate',
    'System.ChangedDate',
    'System.IterationPath',
    'System.AreaPath',
    'System.Tags',
    'Microsoft.VSTS.Common.Priority'
];

/** Splits `items` into arrays of at most `size` items. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
    if (size < 1) {
        throw new RangeError('size must be at least 1');
    }
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

/**
 * Runs `worker` over `items` with at most `limit` calls in flight, and returns the results in
 * the order of `items`. Used to keep bulk edits and batched loads from tripping rate limits.
 */
export async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Loads work items by id in batches of 200, at most 3 batches at a time, and returns them in
 * the order of `ids` (duplicates dropped). `fetchBatch` gets one batch of ids and returns those work items. A batch
 * that fails is reported through `onBatchError` and skipped, so one bad batch doesn't empty
 * the whole list.
 */
export async function fetchWorkItemsInBatches<W extends { id: number }>(
    ids: readonly number[],
    fetchBatch: (batch: number[]) => Promise<W[]>,
    onBatchError?: (error: unknown, batch: number[]) => void
): Promise<W[]> {
    const uniqueIds = [...new Set(ids)];
    const batches = chunk(uniqueIds, MAX_IDS_PER_REQUEST);
    const results = await mapWithConcurrency(batches, 3, async batch => {
        try {
            return await fetchBatch(batch);
        } catch (error) {
            onBatchError?.(error, batch);
            return [] as W[];
        }
    });
    const byId = new Map<number, W>();
    for (const item of results.flat()) {
        byId.set(item.id, item);
    }
    return uniqueIds.map(id => byId.get(id)).filter((item): item is W => item !== undefined);
}
