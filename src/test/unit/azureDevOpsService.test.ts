import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AzureDevOpsService, ConnectionSource, HttpClient } from '../../services/azureDevOpsService';
import { MetadataCache } from '../../utils/metadataCache';

type Handler = (url: string, params: Record<string, unknown>, body?: unknown) => any;

/** A fake HTTP client that answers from `handler` and records every request. */
function fakeHttp(handler: Handler) {
    const calls: Array<{ method: string; url: string; params: Record<string, unknown>; body?: unknown }> = [];
    const http: HttpClient = {
        async get(url, config) {
            const params = config?.params ?? {};
            calls.push({ method: 'GET', url, params });
            return { data: await handler(url, params) };
        },
        async post(url, body, config) {
            const params = config?.params ?? {};
            calls.push({ method: 'POST', url, params, body });
            return { data: await handler(url, params, body) };
        }
    };
    return { http, calls };
}

function service(handler: Handler, config: ReturnType<ConnectionSource['getConfig']> = {
    organizationUrl: 'https://dev.azure.com/org',
    defaultProject: 'Proj',
    defaultTeam: 'Team A'
}) {
    const { http, calls } = fakeHttp(handler);
    const connection: ConnectionSource = { getAxiosInstance: () => http, getConfig: () => config };
    return { svc: new AzureDevOpsService(connection, new MetadataCache()), calls, config };
}

const member = (name: string, unique: string) => ({ identity: { id: unique, displayName: name, uniqueName: unique } });

test('team members are sorted, incomplete identities dropped, and cached', async () => {
    const { svc, calls } = service(() => ({
        value: [member('Zoe', 'zoe@x'), member('Adam', 'adam@x'), { identity: { displayName: 'No unique name' } }]
    }));
    const first = await svc.getTeamMembers();
    const second = await svc.getTeamMembers();
    assert.deepEqual(first.map(m => m.displayName), ['Adam', 'Zoe']);
    assert.equal(second, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/_apis/projects/Proj/teams/Team%20A/members');
});

test('concurrent callers share one request', async () => {
    const { svc, calls } = service(() => ({ value: [member('Adam', 'adam@x')] }));
    await Promise.all([svc.getTeamMembers(), svc.getTeamMembers(), svc.getTeamMembers()]);
    assert.equal(calls.length, 1);
});

test('invalidate forgets cached metadata', async () => {
    const { svc, calls } = service(() => ({ value: [] }));
    await svc.getTeamIterations();
    svc.invalidate();
    await svc.getTeamIterations();
    assert.equal(calls.length, 2);
});

test('a failed request is not cached', async () => {
    let fail = true;
    const { svc } = service(() => {
        if (fail) {
            throw new Error('boom');
        }
        return { value: [member('Adam', 'adam@x')] };
    });
    await assert.rejects(svc.getTeamMembers(), /boom/);
    fail = false;
    assert.equal((await svc.getTeamMembers()).length, 1);
});

test('cache keys include the organization, project and team', async () => {
    const { svc, calls, config } = service(() => ({ value: [] }));
    await svc.getTeamMembers();
    config!.defaultTeam = 'Team B';
    await svc.getTeamMembers();
    config!.defaultProject = 'Other';
    await svc.getTeamMembers();
    assert.equal(calls.length, 3);
});

test('project members merge teams without duplicates and skip teams that fail', async () => {
    const { svc } = service(url => {
        if (url === '/_apis/projects/Proj/teams') {
            return { value: [{ id: 't1' }, { id: 't2' }] };
        }
        if (url.endsWith('/teams/t2/members')) {
            throw new Error('forbidden');
        }
        if (url.endsWith('/teams/t1/members')) {
            return { value: [member('Adam', 'adam@x'), member('Bea', 'bea@x')] };
        }
        return { value: [member('Adam', 'adam@x'), member('Cal', 'cal@x')] };
    });
    const members = await svc.getProjectMembers();
    assert.deepEqual(members.map(m => m.uniqueName), ['adam@x', 'bea@x', 'cal@x']);
});

test('iterations keep their dates and time frame, and the current one is found', async () => {
    const { svc } = service(() => ({
        value: [
            { id: '1', name: 'S1', path: 'P\\S1', attributes: { timeFrame: 'past' } },
            { id: '2', name: 'S2', path: 'P\\S2', attributes: { timeFrame: 'current', startDate: '2026-11-01' } },
            { id: '3', name: 'S3', path: 'P\\S3' }
        ]
    }));
    const iterations = await svc.getTeamIterations();
    assert.equal(iterations[1].startDate, '2026-11-01');
    assert.equal(iterations[2].timeFrame, 'unknown');
    assert.equal(await svc.getCurrentIterationPath(), 'P\\S2');
});

test('team area path prefers the default value, then the first area', async () => {
    const withDefault = service(() => ({ defaultValue: 'P\\Default', values: [{ value: 'P\\First' }] }));
    assert.equal(await withDefault.svc.getTeamAreaPath(), 'P\\Default');
    const withoutDefault = service(() => ({ values: [{ value: 'P\\First' }, { value: '' }] }));
    assert.equal(await withoutDefault.svc.getTeamAreaPath(), 'P\\First');
    assert.deepEqual((await withoutDefault.svc.getTeamFieldValues()).areaPaths, ['P\\First']);
});

test('states and state categories come from the states endpoint', async () => {
    const { svc } = service(() => ({
        value: [{ name: 'New', category: 'Proposed' }, { name: 'Active', category: 'InProgress' }, { name: '' }]
    }));
    assert.deepEqual(await svc.getWorkItemTypeStates('Bug'), ['New', 'Active']);
    const categories = await svc.getStateCategories('Bug');
    assert.equal(categories.get('active'), 'InProgress');
});

test('without a team, team lookups return empty without a request', async () => {
    const { svc, calls } = service(() => ({ value: [] }), { organizationUrl: 'o', defaultProject: 'Proj' });
    assert.deepEqual(await svc.getTeamMembers(), []);
    assert.deepEqual(await svc.getTeamIterations(), []);
    assert.equal(await svc.getTeamAreaPath(), null);
    assert.equal(calls.length, 0);
});

test('work items load in batches of 200, in id order, from the organization endpoint', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 450 - i);
    const { svc, calls } = service((_url, params) => ({
        value: String(params.ids).split(',').map(id => ({ id: Number(id) })).reverse()
    }));
    const items = await svc.getWorkItems(ids, { fields: ['System.Title'] });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, '/_apis/wit/workitems');
    assert.equal(calls[0].params.fields, 'System.Title');
    assert.equal(calls[0].params.errorPolicy, 'omit');
    assert.deepEqual(items.map(i => i.id), ids);
});

test('work items use $expand when no fields are given, and the project URL when asked', async () => {
    const { svc, calls } = service(() => ({ value: [null, { id: 1 }] }));
    const items = await svc.getWorkItems([1, 2], { expand: 'relations', project: 'My Proj' });
    assert.equal(calls[0].url, '/My%20Proj/_apis/wit/workitems');
    assert.equal(calls[0].params['$expand'], 'relations');
    assert.deepEqual(items.map(i => i.id), [1]);
});

test('work item loads throw only when every batch failed', async () => {
    let call = 0;
    const partial = service(params => {
        call++;
        if (call === 1) {
            throw new Error('first batch failed');
        }
        return { value: [{ id: 300 }] };
    });
    const ids = Array.from({ length: 300 }, (_, i) => i + 1);
    assert.deepEqual((await partial.svc.getWorkItems(ids)).map(i => i.id), [300]);

    const failing = service(() => {
        throw new Error('down');
    });
    await assert.rejects(failing.svc.getWorkItems([1]), /down/);
});

test('WIQL queries post to the project and cap the result', async () => {
    const { svc, calls } = service(() => ({ workItems: [{ id: 3 }, { id: 1 }, { id: 2 }, { nope: true }] }));
    assert.deepEqual(await svc.queryWorkItemIds('SELECT [System.Id] FROM WorkItems', 2), [3, 1]);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/Proj/_apis/wit/wiql');
    assert.equal(calls[0].params['$top'], 2);
});

test('not being connected is an error, not an empty result', async () => {
    const connection: ConnectionSource = {
        getAxiosInstance: () => null,
        getConfig: () => ({ organizationUrl: 'o', defaultProject: 'Proj', defaultTeam: 'T' })
    };
    const svc = new AzureDevOpsService(connection, new MetadataCache());
    await assert.rejects(svc.getTeamMembers(), /Not connected/);
});
