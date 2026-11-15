import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { formatLogArg } from '../../utils/logger';

test('axios errors are summarised without request headers', () => {
    const error = {
        isAxiosError: true,
        message: 'Request failed with status code 401',
        config: { method: 'get', url: '/_apis/projects', headers: { Authorization: 'Bearer secret-token' } },
        response: { status: 401, data: { message: 'TF400813: not authorized' } }
    };
    const text = formatLogArg(error);
    assert.equal(text, 'Request failed with status code 401 (HTTP 401) GET /_apis/projects: TF400813: not authorized');
    assert.ok(!text.includes('secret-token'));
});

test('strings pass through, errors show their stack, objects become JSON', () => {
    assert.equal(formatLogArg('hello'), 'hello');
    assert.match(formatLogArg(new Error('boom')), /^Error: boom/);
    assert.equal(formatLogArg({ a: 1 }), '{"a":1}');
    assert.equal(formatLogArg(undefined), 'undefined');
});

test('long values are truncated', () => {
    const text = formatLogArg({ big: 'x'.repeat(5000) });
    assert.ok(text.length <= 2001);
});

test('circular values do not throw', () => {
    const value: any = {};
    value.self = value;
    assert.equal(formatLogArg(value), '[object Object]');
});
