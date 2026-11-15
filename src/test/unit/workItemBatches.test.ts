import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { chunk, fetchWorkItemsInBatches, mapWithConcurrency, MAX_IDS_PER_REQUEST } from '../../utils/workItemBatches';

test('chunk splits into fixed-size groups', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 3), []);
    assert.throws(() => chunk([1], 0));
});

test('mapWithConcurrency keeps order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3], 2, async (n) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, n));
        running--;
        return n * 10;
    });
    assert.deepEqual(results, [50, 10, 40, 20, 30]);
    assert.ok(peak <= 2);
});

test('loads more than 200 ids in batches of at most 200, in the order asked', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 1000 - i);
    const batchSizes: number[] = [];
    const items = await fetchWorkItemsInBatches(ids, async batch => {
        batchSizes.push(batch.length);
        // The API returns items in its own order
        return [...batch].reverse().map(id => ({ id }));
    });
    assert.deepEqual(batchSizes.sort((a, b) => b - a), [MAX_IDS_PER_REQUEST, MAX_IDS_PER_REQUEST, 50]);
    assert.deepEqual(items.map(i => i.id), ids);
});

test('a failing batch is reported and skipped, duplicates are dropped', async () => {
    const ids = [...Array.from({ length: 250 }, (_, i) => i + 1), 1, 2];
    const failed: number[][] = [];
    const items = await fetchWorkItemsInBatches(
        ids,
        async batch => {
            if (batch.includes(1)) {
                throw new Error('boom');
            }
            return batch.map(id => ({ id }));
        },
        (_error, batch) => failed.push(batch)
    );
    assert.equal(failed.length, 1);
    assert.equal(items.length, 50);
    assert.equal(items[0].id, 201);
});
