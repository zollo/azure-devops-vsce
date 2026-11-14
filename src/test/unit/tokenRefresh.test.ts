import { mock, resetMock } from './vscodeMock';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { AuthenticationManager } from '../../authentication/authenticationManager';

const ORG = 'https://dev.azure.com/contoso';

function fakeContext(secrets: Record<string, string>) {
    return {
        secrets: {
            get: async (key: string) => secrets[key],
            store: async (key: string, value: string) => { secrets[key] = value; },
            delete: async (key: string) => { delete secrets[key]; }
        }
    } as never;
}

function session(accessToken: string) {
    return { id: 'ms-session', accessToken, account: { id: 'user@contoso.com', label: 'User' }, scopes: [] };
}

/** Answers 200 for `validToken` and 401 for anything else, recording the Authorization headers it saw. */
function adapterAccepting(validToken: string, seen: string[]): AxiosAdapter {
    return async (config: InternalAxiosRequestConfig) => {
        const auth = String(config.headers?.Authorization ?? config.headers?.get?.('Authorization') ?? '');
        seen.push(auth);
        const ok = auth === `Bearer ${validToken}`;
        const response: AxiosResponse = {
            data: ok ? { value: [] } : {},
            status: ok ? 200 : 401,
            statusText: ok ? 'OK' : 'Unauthorized',
            headers: {},
            config
        };
        if (ok) {
            return response;
        }
        const error = Object.assign(new Error('Request failed with status code 401'), { config, response, isAxiosError: true });
        throw error;
    };
}

async function oauthManager(initialToken: string): Promise<AuthenticationManager> {
    mock.settings = { 'azureDevOps.authenticationMethod': 'oauth', 'azureDevOps.organizationUrl': ORG };
    mock.authSession = session(initialToken);
    const manager = new AuthenticationManager(fakeContext({ 'ado-session-id': 'ms-session' }));
    // The constructor loads configuration asynchronously.
    for (let i = 0; i < 20 && !manager.getAxiosInstance(); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(manager.getAxiosInstance(), 'manager should be configured');
    return manager;
}

beforeEach(() => resetMock());

test('a 401 triggers a silent refresh and one retry with the new token', async () => {
    const manager = await oauthManager('old-token');
    const seen: string[] = [];
    manager.getAxiosInstance()!.defaults.adapter = adapterAccepting('new-token', seen);
    let failures = 0;
    manager.onDidDetectAuthFailure(() => failures++);

    // VS Code now has a refreshed token for the same session.
    mock.authSession = session('new-token');
    const response = await manager.getAxiosInstance()!.get('/_apis/projects');

    assert.equal(response.status, 200);
    assert.deepEqual(seen, ['Bearer old-token', 'Bearer new-token']);
    assert.equal(manager.getConfig()?.personalAccessToken, 'new-token');
    assert.equal(failures, 0);
    assert.deepEqual(mock.errorMessages, []);
    const lastCall = mock.getSessionCalls.at(-1)!;
    assert.deepEqual(lastCall[2], { silent: true });
});

test('when no newer token exists the request fails once and reports an auth failure without a popup', async () => {
    const manager = await oauthManager('old-token');
    const seen: string[] = [];
    manager.getAxiosInstance()!.defaults.adapter = adapterAccepting('something-else', seen);
    let failures = 0;
    manager.onDidDetectAuthFailure(() => failures++);

    await assert.rejects(manager.getAxiosInstance()!.get('/_apis/projects'));

    assert.deepEqual(seen, ['Bearer old-token']);
    assert.equal(failures, 1);
    assert.deepEqual(mock.errorMessages, []);
    assert.equal(manager.isConnected(), false);
});

test('concurrent 401s share one silent refresh', async () => {
    const manager = await oauthManager('old-token');
    const seen: string[] = [];
    manager.getAxiosInstance()!.defaults.adapter = adapterAccepting('new-token', seen);
    mock.authSession = session('new-token');
    const before = mock.getSessionCalls.length;

    const results = await Promise.all([
        manager.getAxiosInstance()!.get('/a'),
        manager.getAxiosInstance()!.get('/b'),
        manager.getAxiosInstance()!.get('/c')
    ]);

    assert.ok(results.every(r => r.status === 200));
    assert.equal(mock.getSessionCalls.length - before, 1);
});

test('a PAT is not refreshable unless it was replaced in secret storage', async () => {
    mock.settings = { 'azureDevOps.authenticationMethod': 'pat', 'azureDevOps.organizationUrl': ORG };
    const secrets: Record<string, string> = { 'ado-pat': 'pat-1' };
    const manager = new AuthenticationManager(fakeContext(secrets));
    for (let i = 0; i < 20 && !manager.getAxiosInstance(); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(await manager.refreshSessionSilently(), false);
    secrets['ado-pat'] = 'pat-2';
    assert.equal(await manager.refreshSessionSilently(), true);
    assert.equal(manager.getConfig()?.personalAccessToken, 'pat-2');
    assert.equal(manager.getAuthorizationHeader(), `Basic ${Buffer.from(':pat-2').toString('base64')}`);
});
