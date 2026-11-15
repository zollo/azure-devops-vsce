import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MetadataCache, metadataKey } from '../../utils/metadataCache';

test('reuses a loaded value until it expires', async () => {
    let now = 1000;
    const cache = new MetadataCache(() => now);
    let loads = 0;
    const load = async () => ++loads;

    assert.equal(await cache.getOrLoad('k', 100, load), 1);
    assert.equal(await cache.getOrLoad('k', 100, load), 1);
    now += 101;
    assert.equal(await cache.getOrLoad('k', 100, load), 2);
});

test('callers that ask during a load share it', async () => {
    const cache = new MetadataCache();
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const load = async () => { loads++; await gate; return 'value'; };

    const first = cache.getOrLoad('k', 1000, load);
    const second = cache.getOrLoad('k', 1000, load);
    release();
    assert.deepEqual(await Promise.all([first, second]), ['value', 'value']);
    assert.equal(loads, 1);
});

test('does not cache failures', async () => {
    const cache = new MetadataCache();
    let calls = 0;
    await assert.rejects(cache.getOrLoad('k', 1000, async () => { calls++; throw new Error('offline'); }));
    assert.equal(await cache.getOrLoad('k', 1000, async () => { calls++; return 'ok'; }), 'ok');
    assert.equal(calls, 2);
});

test('invalidate drops entries by prefix', async () => {
    const cache = new MetadataCache();
    let loads = 0;
    const load = async () => ++loads;
    await cache.getOrLoad('tags|org|a', 1000, load);
    await cache.getOrLoad('states|org|a', 1000, load);
    cache.invalidate('tags|');
    assert.equal(await cache.getOrLoad('tags|org|a', 1000, load), 3);
    assert.equal(await cache.getOrLoad('states|org|a', 1000, load), 2);
});

test('keys keep organizations, projects and teams apart, ignoring case', () => {
    assert.equal(metadataKey('members', 'https://dev.azure.com/A', 'Proj', 'Team'), metadataKey('members', 'https://dev.azure.com/a', 'proj', 'team'));
    assert.notEqual(metadataKey('members', 'org', 'p1', 't'), metadataKey('members', 'org', 'p2', 't'));
    assert.notEqual(metadataKey('members', 'org', 'p', undefined), metadataKey('members', 'org', 'p', 't'));
});
