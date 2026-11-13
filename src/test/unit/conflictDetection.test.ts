import { mock, resetMock } from './vscodeMock';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { detectOriginalExtensionConflict, ORIGINAL_EXTENSION_ID } from '../../utils/conflictDetection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const context = (id: string) => ({ extension: { id } }) as any;

beforeEach(() => resetMock());

test('no conflict when the original extension is not installed', () => {
    assert.equal(detectOriginalExtensionConflict(context('zollo.azure-devops-boards')), false);
    assert.equal(mock.errorMessages.length, 0);
});

test('reports a conflict and shows an error when the original is enabled', () => {
    mock.installedExtensions.add(ORIGINAL_EXTENSION_ID);
    assert.equal(detectOriginalExtensionConflict(context('zollo.azure-devops-boards')), true);
    assert.equal(mock.errorMessages.length, 1);
    assert.match(mock.errorMessages[0], /Damilola\.azure-devops-boards/);
});

test('the original extension does not flag itself', () => {
    mock.installedExtensions.add(ORIGINAL_EXTENSION_ID);
    assert.equal(detectOriginalExtensionConflict(context('damilola.azure-devops-boards')), false);
});
