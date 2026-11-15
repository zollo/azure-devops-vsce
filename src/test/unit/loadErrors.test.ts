import './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { describeLoadError } from '../../views/loadErrors';

test('401 and 403 point to signing in again', () => {
    const expired = describeLoadError({ response: { status: 401 }, message: 'Request failed with status code 401' }, 'sprints');
    assert.equal(expired.label, "Couldn't load sprints: sign-in expired");
    assert.equal(expired.signInAgain, true);
    assert.equal(describeLoadError({ response: { status: 403, data: { message: 'TF401019' } } }, 'boards').signInAgain, true);
});

test('uses the server message when there is one', () => {
    const info = describeLoadError({ response: { status: 400, data: { message: 'VS402337: too many items' } }, message: 'Bad request' }, 'work items');
    assert.equal(info.label, "Couldn't load work items");
    assert.equal(info.detail, 'VS402337: too many items');
    assert.equal(info.signInAgain, false);
});

test('network failures say Azure DevOps cannot be reached', () => {
    const info = describeLoadError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND dev.azure.com' }, 'queries');
    assert.equal(info.label, "Couldn't load queries: can't reach Azure DevOps");
    assert.equal(info.signInAgain, false);
});

test('handles plain values', () => {
    assert.equal(describeLoadError('boom', 'backlogs').detail, 'boom');
    assert.equal(describeLoadError(undefined, 'backlogs').detail, 'Unknown error');
});
