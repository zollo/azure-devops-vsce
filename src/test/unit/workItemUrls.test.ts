import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { extractWorkItemIdFromUrl, isOrganizationUrl } from '../../utils/workItemUrls';

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

test('isOrganizationUrl accepts attachment URLs on the same organization only', () => {
    const org = 'https://dev.azure.com/contoso';
    assert.equal(isOrganizationUrl('https://dev.azure.com/contoso/abc/_apis/wit/attachments/1?fileName=a.txt', org), true);
    assert.equal(isOrganizationUrl('https://contoso.visualstudio.com/abc/_apis/wit/attachments/1', org), true);
    assert.equal(isOrganizationUrl('https://dev.azure.com/Contoso/_apis/wit/attachments/1', 'https://contoso.visualstudio.com/'), true);
    assert.equal(isOrganizationUrl('https://dev.azure.com/fabrikam/_apis/wit/attachments/1', org), false);
    assert.equal(isOrganizationUrl('https://evil.example/contoso/_apis/wit/attachments/1', org), false);
    assert.equal(isOrganizationUrl('https://dev.azure.com.evil.example/contoso/x', org), false);
    assert.equal(isOrganizationUrl('http://dev.azure.com/contoso/x', org), false);
    assert.equal(isOrganizationUrl('https://user:pw@dev.azure.com/contoso/x', org), false);
    assert.equal(isOrganizationUrl('not a url', org), false);
    assert.equal(isOrganizationUrl('https://dev.azure.com/contoso/x', undefined), false);
});

test('isOrganizationUrl matches Azure DevOps Server by host and collection path', () => {
    const org = 'https://tfs.corp.local/DefaultCollection/';
    assert.equal(isOrganizationUrl('https://tfs.corp.local/DefaultCollection/_apis/wit/attachments/1', org), true);
    assert.equal(isOrganizationUrl('https://tfs.corp.local/OtherCollection/_apis/wit/attachments/1', org), false);
    assert.equal(isOrganizationUrl('https://tfs.corp.local/DefaultCollectionX/_apis', org), false);
});
