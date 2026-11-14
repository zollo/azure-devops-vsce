import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Hints, HttpGet } from '../../onboarding/discovery';
import { MicrosoftSession, OnboardingController, OnboardingDeps, OnboardingResult, OnboardingState } from '../../onboarding/onboardingController';

function jwt(claims: object): string {
    const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${b64({})}.${b64(claims)}.x`;
}

const HOME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

interface Org {
    projects: { id: string; name: string; lastUpdateTime?: string }[];
    teams: Record<string, { all: { id: string; name: string }[]; mine: { id: string; name: string }[]; defaultTeam?: string }>;
}

/**
 * A fake Azure DevOps: organizations per credential, and projects and teams per organization.
 * Credentials are the Authorization header value.
 */
function fakeAzureDevOps(orgsByAuth: Record<string, string[] | Error>, orgs: Record<string, Org>) {
    const requests: { auth: string; url: string }[] = [];
    const createHttp = (auth: string): HttpGet => async (url, params = {}) => {
        requests.push({ auth, url });
        if (url.startsWith('https://management.azure.com/tenants')) {
            return { data: { value: [{ tenantId: OTHER, displayName: 'Partner' }, { tenantId: HOME, displayName: 'Contoso' }] } };
        }
        if (url.endsWith('/_apis/profile/profiles/me') || url.endsWith('/_apis/accounts')) {
            const names = orgsByAuth[auth];
            if (!names || names instanceof Error) {
                throw Object.assign(new Error('unauthorized'), { response: { status: names ? 403 : 401 } });
            }
            return url.endsWith('/me')
                ? { data: { id: 'member-1' } }
                : { data: { count: names.length, value: names.map(n => ({ accountId: n, accountName: n, accountUri: `https://vssps.dev.azure.com/${n}/` })) } };
        }
        const match = /^https:\/\/dev\.azure\.com\/([^/]+)\/_apis\/(.*)$/.exec(url);
        const org = match ? orgs[match[1]] : undefined;
        if (!match || !org) {
            throw Object.assign(new Error('not found'), { response: { status: 404 } });
        }
        const rest = match[2];
        if (rest === 'connectionData') {
            return { data: {} };
        }
        if (rest === 'projects') {
            return { data: { value: org.projects } };
        }
        const teamMatch = /^projects\/([^/]+)(\/teams)?$/.exec(rest);
        if (teamMatch) {
            const projectId = decodeURIComponent(teamMatch[1]);
            const teams = org.teams[projectId] ?? { all: [], mine: [] };
            if (!teamMatch[2]) {
                return { data: { id: projectId, defaultTeam: teams.defaultTeam ? { id: teams.defaultTeam } : undefined } };
            }
            const source = params.$mine ? teams.mine : teams.all;
            return { data: { value: source.slice(Number(params.$skip), Number(params.$skip) + Number(params.$top)) } };
        }
        throw new Error(`unexpected ${url}`);
    };
    return { createHttp, requests };
}

function harness(options: {
    hints?: Hints;
    sessions?: Record<string, MicrosoftSession | undefined>;
    orgsByAuth: Record<string, string[] | Error>;
    orgs: Record<string, Org>;
    armToken?: string;
}) {
    const ado = fakeAzureDevOps(options.orgsByAuth, options.orgs);
    const saved: OnboardingResult[] = [];
    const signIns: (string | undefined)[] = [];
    let dismissed = false;
    const deps: OnboardingDeps = {
        signInMicrosoft: async tenant => {
            signIns.push(tenant);
            return options.sessions?.[tenant ?? 'home'];
        },
        getArmToken: async () => options.armToken,
        createHttp: ado.createHttp,
        getHints: async () => options.hints ?? { remotes: [] },
        save: async result => { saved.push(result); },
        dismiss: () => { dismissed = true; },
        post: () => {},
        log: () => {}
    };
    const controller = new OnboardingController(deps);
    return { controller, saved, signIns, requests: ado.requests, isDismissed: () => dismissed, state: (): OnboardingState => controller.getState() };
}

const homeSession: MicrosoftSession = { id: 's-home', accessToken: jwt({ tid: HOME, upn: 'joe@contoso.com' }), accountLabel: 'joe@contoso.com' };
const otherSession: MicrosoftSession = { id: 's-other', accessToken: jwt({ tid: OTHER }), accountLabel: 'joe@contoso.com' };
const bearer = (s: MicrosoftSession) => `Bearer ${s.accessToken}`;

const contoso: Org = {
    projects: [
        { id: 'p-app', name: 'App', lastUpdateTime: '2026-01-01T00:00:00Z' },
        { id: 'p-web', name: 'Web', lastUpdateTime: '2026-09-01T00:00:00Z' }
    ],
    teams: {
        'p-app': {
            all: [{ id: 't-app', name: 'App Team' }, { id: 't-mobile', name: 'Mobile' }, { id: 't-api', name: 'API' }],
            mine: [{ id: 't-mobile', name: 'Mobile' }, { id: 't-api', name: 'API' }],
            defaultTeam: 't-app'
        },
        'p-web': { all: [{ id: 't-web', name: 'Web Team' }], mine: [], defaultTeam: 't-web' }
    }
};

test('Microsoft sign-in fills in everything it can detect', async () => {
    const h = harness({
        hints: { remotes: [{ organization: 'contoso', organizationUrl: 'https://dev.azure.com/contoso', project: 'App' }] },
        sessions: { home: homeSession },
        orgsByAuth: { [bearer(homeSession)]: ['alpha', 'contoso'] },
        orgs: { contoso, alpha: { projects: [], teams: {} } },
        armToken: 'arm'
    });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });

    const s = h.state();
    assert.equal(s.step, 'review');
    assert.equal(s.account, 'joe@contoso.com');
    assert.equal(s.tenantId, HOME);
    assert.equal(s.tenants[0].id, HOME);
    assert.equal(s.tenants[0].isHome, true);
    assert.equal(s.organizationUrl, 'https://dev.azure.com/contoso');
    assert.match(s.organizationNote ?? '', /Git remote/);
    assert.equal(s.projectId, 'p-app');
    assert.deepEqual(s.selectedTeamIds, ['t-api', 't-mobile']);
    assert.equal(s.primaryTeamId, 't-api');
    assert.equal(s.teams.filter(t => t.isMember).length, 2);
    assert.equal(s.loading, undefined);

    await h.controller.handle({ type: 'setTeams', teamIds: ['t-api', 't-mobile', 't-app'], primaryTeamId: 't-mobile' });
    await h.controller.handle({ type: 'finish' });
    assert.equal(h.state().step, 'done');
    assert.deepEqual(h.saved, [{
        authMethod: 'microsoft',
        sessionId: 's-home',
        organizationUrl: 'https://dev.azure.com/contoso',
        project: 'App',
        teams: ['Mobile', 'API', 'App Team']
    }]);
});

test('falls back to the default team and the most recent project', async () => {
    const h = harness({
        sessions: { home: homeSession },
        orgsByAuth: { [bearer(homeSession)]: ['contoso'] },
        orgs: { contoso }
    });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    const s = h.state();
    assert.equal(s.projectId, 'p-web');
    assert.deepEqual(s.selectedTeamIds, ['t-web']);
    assert.match(s.teamsNote ?? '', /default team/);
    assert.equal(s.canFindTenants, true, 'no ARM token, so offer to look for other tenants');
});

test('switching tenant signs in to it, reloads organizations and saves the tenant', async () => {
    const h = harness({
        sessions: { home: homeSession, [OTHER]: otherSession },
        orgsByAuth: { [bearer(homeSession)]: ['contoso'], [bearer(otherSession)]: ['partner'] },
        orgs: { contoso, partner: { projects: [{ id: 'p-x', name: 'X' }], teams: { 'p-x': { all: [{ id: 't-x', name: 'X Team' }], mine: [{ id: 't-x', name: 'X Team' }] } } } },
        armToken: 'arm'
    });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    // Let the background tenant lookup finish.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.state().tenants.map(t => t.name), ['Contoso', 'Partner']);

    await h.controller.handle({ type: 'selectTenant', tenantId: OTHER });
    assert.deepEqual(h.signIns, [undefined, OTHER]);
    assert.equal(h.state().organizationUrl, 'https://dev.azure.com/partner');
    assert.deepEqual(h.state().selectedTeamIds, ['t-x']);

    await h.controller.handle({ type: 'finish' });
    assert.equal(h.saved[0].tenantId, OTHER);
    assert.equal(h.saved[0].sessionId, 's-other');

    // Back to the home tenant: no tenant is saved.
    await h.controller.handle({ type: 'selectTenant', tenantId: HOME });
    await h.controller.handle({ type: 'finish' });
    assert.equal(h.saved[1].tenantId, undefined);
});

test('a cancelled Microsoft sign-in returns to the welcome step', async () => {
    const h = harness({ sessions: {}, orgsByAuth: {}, orgs: {} });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    assert.equal(h.state().step, 'welcome');
    assert.match(h.state().error ?? '', /cancelled/);
});

test('rejects a bad tenant entry without signing in', async () => {
    const h = harness({ sessions: { home: homeSession }, orgsByAuth: { [bearer(homeSession)]: ['contoso'] }, orgs: { contoso } });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    await h.controller.handle({ type: 'addTenant', value: 'not a tenant' });
    assert.match(h.state().error ?? '', /tenant ID/);
    assert.deepEqual(h.signIns, [undefined]);
});

const patAuth = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

test('PAT that can list organizations goes straight to review', async () => {
    const h = harness({ orgsByAuth: { [patAuth('good')]: ['contoso'] }, orgs: { contoso } });
    await h.controller.handle({ type: 'chooseAuth', method: 'pat' });
    assert.equal(h.state().step, 'pat');
    await h.controller.handle({ type: 'submitPat', pat: '  good  ' });
    assert.equal(h.state().step, 'review');
    await h.controller.handle({ type: 'finish' });
    assert.equal(h.saved[0].authMethod, 'pat');
    assert.equal(h.saved[0].pat, 'good');
    assert.equal(h.saved[0].sessionId, undefined);
});

test('an organization-scoped PAT uses the Git remote, or asks for the URL', async () => {
    const remote = { organization: 'contoso', organizationUrl: 'https://dev.azure.com/contoso', project: 'App' };
    const scoped = harness({ hints: { remotes: [remote] }, orgsByAuth: { [patAuth('scoped')]: new Error('403') }, orgs: { contoso } });
    await scoped.controller.handle({ type: 'chooseAuth', method: 'pat' });
    assert.equal(scoped.state().patOrganizationHint, 'https://dev.azure.com/contoso');
    await scoped.controller.handle({ type: 'submitPat', pat: 'scoped' });
    assert.equal(scoped.state().step, 'review');
    assert.equal(scoped.state().projectId, 'p-app');

    const noHint = harness({ orgsByAuth: { [patAuth('scoped')]: new Error('403') }, orgs: { contoso } });
    await noHint.controller.handle({ type: 'chooseAuth', method: 'pat' });
    await noHint.controller.handle({ type: 'submitPat', pat: 'scoped' });
    assert.equal(noHint.state().step, 'pat');
    assert.equal(noHint.state().patNeedsOrganization, true);
    await noHint.controller.handle({ type: 'submitPat', pat: 'scoped', organizationUrl: 'contoso' });
    assert.equal(noHint.state().step, 'review');
    assert.equal(noHint.state().organizationUrl, 'https://dev.azure.com/contoso');
});

test('a rejected PAT shows an error and stays on the PAT step', async () => {
    const h = harness({ orgsByAuth: {}, orgs: { contoso } });
    await h.controller.handle({ type: 'chooseAuth', method: 'pat' });
    await h.controller.handle({ type: 'submitPat', pat: 'expired' });
    assert.equal(h.state().step, 'pat');
    assert.match(h.state().error ?? '', /rejected/);
    await h.controller.handle({ type: 'submitPat', pat: '   ' });
    assert.match(h.state().error ?? '', /Enter a personal access token/);
});

test('requires a team when the project has teams, and ignores unknown team ids', async () => {
    const h = harness({ sessions: { home: homeSession }, orgsByAuth: { [bearer(homeSession)]: ['contoso'] }, orgs: { contoso } });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    await h.controller.handle({ type: 'setTeams', teamIds: ['nope'] });
    assert.deepEqual(h.state().selectedTeamIds, []);
    await h.controller.handle({ type: 'finish' });
    assert.equal(h.saved.length, 0);
    assert.match(h.state().error ?? '', /at least one team/);
});

test('changing the project reloads its teams', async () => {
    const h = harness({ sessions: { home: homeSession }, orgsByAuth: { [bearer(homeSession)]: ['contoso'] }, orgs: { contoso } });
    await h.controller.handle({ type: 'chooseAuth', method: 'microsoft' });
    assert.equal(h.state().projectId, 'p-web');
    await h.controller.handle({ type: 'selectProject', projectId: 'p-app' });
    assert.deepEqual(h.state().teams.map(t => t.name), ['API', 'Mobile', 'App Team']);
});

test('dismiss is passed through', async () => {
    const h = harness({ orgsByAuth: {}, orgs: {} });
    await h.controller.handle({ type: 'dismiss' });
    assert.equal(h.isDismissed(), true);
});
