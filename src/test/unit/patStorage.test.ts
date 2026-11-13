import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getOrMigratePat, SecretStore } from '../../authentication/patStorage';

function fakeSecrets(initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        get: async (key: string) => data[key],
        store: async (key: string, value: string) => { data[key] = value; }
    };
}

test('returns the stored PAT without touching the legacy setting', async () => {
    const secrets = fakeSecrets({ 'ado-pat': '  stored-token  ' });
    let cleared = false;
    const pat = await getOrMigratePat(secrets, 'ado-pat', () => 'legacy', async () => { cleared = true; });
    assert.equal(pat, 'stored-token');
    assert.equal(cleared, false);
});

test('migrates a legacy PAT from settings into secret storage', async () => {
    const secrets = fakeSecrets();
    let cleared = false;
    const pat = await getOrMigratePat(secrets, 'ado-pat', () => ' legacy-token ', async () => { cleared = true; });
    assert.equal(pat, 'legacy-token');
    assert.equal(secrets.data['ado-pat'], 'legacy-token');
    assert.equal(cleared, true);
});

test('returns an empty string when no PAT exists anywhere', async () => {
    const secrets = fakeSecrets({ 'ado-pat': '   ' });
    let cleared = false;
    const pat = await getOrMigratePat(secrets, 'ado-pat', () => undefined, async () => { cleared = true; });
    assert.equal(pat, '');
    assert.equal(cleared, false);
    assert.equal(secrets.data['ado-pat'], '   ');
});
