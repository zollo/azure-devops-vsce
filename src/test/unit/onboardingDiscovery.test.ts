import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    decodeJwtClaims,
    domainFromClaims,
    fetchProjects,
    fetchTeams,
    HttpGet,
    mergeTeams,
    normalizeOrganizationUrl,
    normalizeTenantInput,
    organizationNameFromUrl,
    parseAzureReposRemote,
    parseOrganizations,
    parseTenants,
    remoteUrlsFromGitConfig,
    suggestOrganization,
    suggestProject,
    suggestTeams,
    Team
} from '../../onboarding/discovery';

function jwt(claims: object): string {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

test('reads tenant and domain from an access token', () => {
    const claims = decodeJwtClaims(jwt({ tid: 'ABC', upn: 'joe@Contoso.com' }));
    assert.equal(claims.tid, 'ABC');
    assert.equal(domainFromClaims(claims), 'contoso.com');
    assert.deepEqual(decodeJwtClaims('not-a-jwt'), {});
    assert.deepEqual(decodeJwtClaims('a.!!!.c'), {});
});

test('lists the home tenant first, even when ARM did not return it', () => {
    const tenants = parseTenants({
        value: [
            { tenantId: 'BBBB', displayName: 'Zeta Corp', defaultDomain: 'zeta.com' },
            { tenantId: 'cccc', displayName: 'Alpha Ltd', domains: ['alpha.io'] },
            { tenantId: 'bbbb', displayName: 'duplicate' },
            { displayName: 'no id' }
        ]
    }, 'HOME', 'contoso.com');
    assert.deepEqual(tenants.map(t => [t.id, t.name, t.isHome]), [
        ['home', 'contoso.com', true],
        ['cccc', 'Alpha Ltd', false],
        ['bbbb', 'Zeta Corp', false]
    ]);
    assert.equal(tenants[1].domain, 'alpha.io');
});

test('marks the home tenant when ARM does return it', () => {
    const tenants = parseTenants({ value: [{ tenantId: 'h', displayName: 'Contoso' }, { tenantId: 'a', displayName: 'Apple' }] }, 'h');
    assert.deepEqual(tenants.map(t => [t.name, t.isHome]), [['Contoso', true], ['Apple', false]]);
});

test('accepts tenant GUIDs and domains only', () => {
    assert.equal(normalizeTenantInput(' 72F988BF-86F1-41AF-91AB-2D7CD011DB47 '), '72f988bf-86f1-41af-91ab-2d7cd011db47');
    assert.equal(normalizeTenantInput('Contoso.onmicrosoft.com'), 'contoso.onmicrosoft.com');
    assert.equal(normalizeTenantInput('not a tenant'), undefined);
    assert.equal(normalizeTenantInput('https://evil.example/x'), undefined);
});

test('normalizes organization URLs', () => {
    assert.equal(normalizeOrganizationUrl('myorg'), 'https://dev.azure.com/myorg');
    assert.equal(normalizeOrganizationUrl('https://dev.azure.com/myorg/My%20Project/_git/repo'), 'https://dev.azure.com/myorg');
    assert.equal(normalizeOrganizationUrl('https://vssps.dev.azure.com/myorg/'), 'https://dev.azure.com/myorg');
    assert.equal(normalizeOrganizationUrl('https://MyOrg.visualstudio.com/DefaultCollection'), 'https://myorg.visualstudio.com');
    assert.equal(normalizeOrganizationUrl('https://myorg.vssps.visualstudio.com/'), 'https://myorg.visualstudio.com');
    assert.equal(normalizeOrganizationUrl('https://tfs.example.com/tfs/Collection/'), 'https://tfs.example.com/tfs/Collection');
    assert.equal(normalizeOrganizationUrl('https://dev.azure.com/'), undefined);
    assert.equal(normalizeOrganizationUrl(''), undefined);
});

test('names organizations only from their own host', () => {
    assert.equal(organizationNameFromUrl('https://contoso.visualstudio.com'), 'contoso');
    assert.equal(organizationNameFromUrl('https://dev.azure.com/contoso'), 'contoso');
    assert.equal(organizationNameFromUrl('https://contoso.visualstudio.com.evil.example/x'), 'x');
    assert.equal(parseAzureReposRemote('git@evil.example:v3/vs-ssh.visualstudio.com/p/r'), undefined);
});

test('parses organizations from the accounts API', () => {
    const orgs = parseOrganizations({
        count: 3,
        value: [
            { accountId: '2', accountName: 'zeta', accountUri: 'https://vssps.dev.azure.com/zeta/' },
            { accountId: '1', accountName: 'Alpha', accountUri: 'https://alpha.vssps.visualstudio.com/' },
            { accountId: '3', accountName: 'beta' },
            { accountId: '4', accountName: 'zeta', accountUri: 'https://dev.azure.com/zeta' }
        ]
    });
    assert.deepEqual(orgs.map(o => [o.name, o.url]), [
        ['Alpha', 'https://alpha.visualstudio.com'],
        ['beta', 'https://dev.azure.com/beta'],
        ['zeta', 'https://dev.azure.com/zeta']
    ]);
    assert.deepEqual(parseOrganizations(undefined), []);
});

test('recognizes Azure Repos remotes', () => {
    const cases: [string, string, string][] = [
        ['https://dev.azure.com/contoso/Fabrikam%20Web/_git/web', 'https://dev.azure.com/contoso', 'Fabrikam Web'],
        ['https://joe@dev.azure.com/contoso/App/_git/App', 'https://dev.azure.com/contoso', 'App'],
        ['https://dev.azure.com/contoso/_git/App', 'https://dev.azure.com/contoso', 'App'],
        ['https://Contoso.visualstudio.com/DefaultCollection/App/_git/api', 'https://contoso.visualstudio.com', 'App'],
        ['https://contoso.visualstudio.com/App/_git/api', 'https://contoso.visualstudio.com', 'App'],
        ['git@ssh.dev.azure.com:v3/contoso/My%20Project/repo', 'https://dev.azure.com/contoso', 'My Project'],
        ['ssh://git@ssh.dev.azure.com:22/v3/contoso/App/repo', 'https://dev.azure.com/contoso', 'App'],
        ['contoso@vs-ssh.visualstudio.com:v3/contoso/App/repo', 'https://contoso.visualstudio.com', 'App']
    ];
    for (const [remote, orgUrl, project] of cases) {
        const info = parseAzureReposRemote(remote);
        assert.ok(info, remote);
        assert.equal(info.organizationUrl, orgUrl, remote);
        assert.equal(info.project, project, remote);
    }
    assert.equal(parseAzureReposRemote('https://github.com/zollo/azure-devops-vsce.git'), undefined);
    assert.equal(parseAzureReposRemote('git@github.com:zollo/repo.git'), undefined);
    assert.equal(parseAzureReposRemote('nonsense'), undefined);
});

test('reads remote URLs from .git/config', () => {
    const config = [
        '[core]',
        '\turl = not-a-remote',
        '[remote "origin"]',
        '\turl = https://dev.azure.com/contoso/App/_git/App',
        '\tfetch = +refs/heads/*:refs/remotes/origin/*',
        '[branch "main"]',
        '[remote "upstream"]',
        '    url = git@github.com:x/y.git'
    ].join('\r\n');
    assert.deepEqual(remoteUrlsFromGitConfig(config), ['https://dev.azure.com/contoso/App/_git/App', 'git@github.com:x/y.git']);
});

const orgs = [
    { id: '1', name: 'alpha', url: 'https://dev.azure.com/alpha' },
    { id: '2', name: 'contoso', url: 'https://contoso.visualstudio.com' }
];

test('suggests the organization from the Git remote, then settings', () => {
    const remote = { organization: 'contoso', organizationUrl: 'https://dev.azure.com/contoso', project: 'App' };
    assert.deepEqual(suggestOrganization(orgs, { remotes: [remote] }), { value: orgs[1], reason: 'gitRemote' });
    assert.deepEqual(suggestOrganization(orgs, { remotes: [], organizationUrl: 'https://dev.azure.com/alpha/' }), { value: orgs[0], reason: 'settings' });
    assert.deepEqual(suggestOrganization([orgs[1]], { remotes: [] }), { value: orgs[1], reason: 'onlyOne' });
    assert.deepEqual(suggestOrganization(orgs, { remotes: [] }), { value: orgs[0], reason: 'first' });
    assert.deepEqual(suggestOrganization([], { remotes: [] }), { value: undefined, reason: 'none' });
});

test('suggests the project from the Git remote, settings, or the most recently updated', () => {
    const projects = [
        { id: 'a', name: 'App', lastUpdateTime: '2026-01-01T00:00:00Z' },
        { id: 'b', name: 'Billing', lastUpdateTime: '2026-06-01T00:00:00Z' },
        { id: 'c', name: 'Core' }
    ];
    const org = 'https://dev.azure.com/contoso';
    const remote = { organization: 'contoso', organizationUrl: org, project: 'app' };
    assert.equal(suggestProject(projects, org, { remotes: [remote] }).value?.id, 'a');
    // A remote for another organization is ignored.
    assert.equal(suggestProject(projects, 'https://dev.azure.com/other', { remotes: [remote] }).reason, 'recent');
    assert.deepEqual(suggestProject(projects, org, { remotes: [], organizationUrl: org, project: 'Core' }), { value: projects[2], reason: 'settings' });
    // Saved project from a different organization is ignored.
    assert.equal(suggestProject(projects, org, { remotes: [], organizationUrl: 'https://dev.azure.com/x', project: 'Core' }).value?.id, 'b');
    assert.deepEqual(suggestProject(projects, org, { remotes: [] }), { value: projects[1], reason: 'recent' });
    assert.deepEqual(suggestProject([projects[2]], org, { remotes: [] }), { value: projects[2], reason: 'onlyOne' });
});

function team(id: string, name: string, isMember = false, isDefault = false): Team {
    return { id, name, isMember, isDefault };
}

test('merges team lists with membership and the default team', () => {
    const teams = mergeTeams(
        { value: [{ id: 'T1', name: 'Zebra' }, { id: 't2', name: 'App Team', description: 'default' }, { id: 't3', name: 'mobile' }, { name: 'bad' }] },
        { value: [{ id: 't1', name: 'Zebra' }, { id: 't4', name: 'Hidden' }] },
        'T2'
    );
    assert.deepEqual(teams.map(t => [t.name, t.isMember, t.isDefault]), [
        ['Hidden', true, false],
        ['Zebra', true, false],
        ['App Team', false, true],
        ['mobile', false, false]
    ]);
    assert.equal(teams[2].description, 'default');
});

test('preselects saved teams, then member teams, then the default team', () => {
    const teams = [team('1', 'A', true), team('2', 'B', true, true), team('3', 'C', false), team('4', 'D', false)];
    assert.deepEqual(suggestTeams(teams, { teams: ['d', 'A', 'gone'] }).value?.map(t => t.name), ['D', 'A']);
    const mine = suggestTeams(teams, {});
    assert.equal(mine.reason, 'membership');
    assert.deepEqual(mine.value?.map(t => t.name), ['B', 'A']);
    assert.deepEqual(suggestTeams([team('3', 'C'), team('4', 'D', false, true)], {}), { value: [team('4', 'D', false, true)], reason: 'defaultTeam' });
    assert.deepEqual(suggestTeams([team('3', 'C')], {}).reason, 'onlyOne');
    assert.deepEqual(suggestTeams([team('3', 'C'), team('4', 'D')], {}), { value: [], reason: 'none' });
});

/** A fake HttpGet that serves canned responses keyed by URL and records each request. */
function fakeHttp(handler: (url: string, params: Record<string, any>) => { data: any; headers?: Record<string, unknown> } | Error) {
    const calls: { url: string; params: Record<string, any> }[] = [];
    const get: HttpGet = async (url, params = {}) => {
        calls.push({ url, params });
        const result = handler(url, params);
        if (result instanceof Error) {
            throw result;
        }
        return result;
    };
    return { get, calls };
}

test('follows project continuation tokens', async () => {
    const { get, calls } = fakeHttp((_url, params) => params.continuationToken
        ? { data: { value: [{ id: '2', name: 'beta' }] } }
        : { data: { value: [{ id: '1', name: 'Gamma' }] }, headers: { 'X-MS-ContinuationToken': 'next' } });
    const projects = await fetchProjects(get, 'https://dev.azure.com/o');
    assert.deepEqual(projects.map(p => p.name), ['beta', 'Gamma']);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.continuationToken, 'next');
});

test('pages through teams and asks for the user\'s own teams', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` }));
    const { get, calls } = fakeHttp((url, params) => {
        if (url.endsWith('/_apis/projects/p%201')) {
            return { data: { id: 'p 1', defaultTeam: { id: 't0', name: 'Team 0' } } };
        }
        const source = params.$mine ? [all[3]] : all;
        return { data: { value: source.slice(params.$skip, params.$skip + params.$top) } };
    });
    const result = await fetchTeams(get, 'https://dev.azure.com/o', 'p 1', 2);
    assert.equal(result.membershipKnown, true);
    assert.equal(result.teams.length, 5);
    assert.deepEqual(result.teams.slice(0, 2).map(t => [t.name, t.isMember, t.isDefault]), [['Team 3', true, false], ['Team 0', false, true]]);
    const pages = calls.filter(c => c.url.endsWith('/teams') && !c.params.$mine).map(c => c.params.$skip);
    assert.deepEqual(pages, [0, 2, 4]);
    assert.ok(calls.every(c => c.params['api-version']));
});

test('still lists teams when the membership query fails', async () => {
    const { get } = fakeHttp((url, params) => {
        if (params.$mine) {
            return new Error('403');
        }
        if (url.endsWith('/teams')) {
            return { data: { value: [{ id: 'a', name: 'A' }] } };
        }
        return new Error('project lookup failed');
    });
    const result = await fetchTeams(get, 'https://dev.azure.com/o', 'p');
    assert.equal(result.membershipKnown, false);
    assert.deepEqual(result.teams, [{ id: 'a', name: 'A', description: undefined, isMember: false, isDefault: false }]);
});
