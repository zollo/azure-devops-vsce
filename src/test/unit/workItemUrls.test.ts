import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractWorkItemIdFromUrl } from '../../utils/workItemUrls';

test('extracts IDs from dev.azure.com and visualstudio.com URLs', () => {
    assert.equal(extractWorkItemIdFromUrl('https://dev.azure.com/org/_apis/wit/workItems/123'), '123');
    assert.equal(extractWorkItemIdFromUrl('https://dev.azure.com/org/Project/_apis/wit/workitems/45'), '45');
    assert.equal(extractWorkItemIdFromUrl('https://org.visualstudio.com/0eab1257-guid/_apis/wit/workItems/678'), '678');
    assert.equal(extractWorkItemIdFromUrl('https://org.visualstudio.com/_apis/wit/WORKITEMS/9?api-version=7.0'), '9');
});

test('falls back to a trailing numeric segment', () => {
    assert.equal(extractWorkItemIdFromUrl('https://example.test/items/42'), '42');
});

test('returns undefined when there is no ID', () => {
    assert.equal(extractWorkItemIdFromUrl('https://dev.azure.com/org/_apis/wit/workitems/'), undefined);
    assert.equal(extractWorkItemIdFromUrl(''), undefined);
    assert.equal(extractWorkItemIdFromUrl(undefined), undefined);
});
