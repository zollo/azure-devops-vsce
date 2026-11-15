import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { affectsConnectionSettings } from '../../utils/configChanges';

const keys = ['azureDevOps.organizationUrl', 'azureDevOps.defaultProject', 'azureDevOps.workItemsView.columns'];

/** A change event for the given setting keys, matching VS Code's prefix semantics. */
function changeOf(...changed: string[]) {
    return {
        affectsConfiguration: (section: string) =>
            changed.some(key => key === section || key.startsWith(section + '.'))
    };
}

test('a work items column change does not count as a connection change', () => {
    assert.equal(affectsConnectionSettings(changeOf('azureDevOps.workItemsView.columns'), keys), false);
});

test('connection settings still count, alone or alongside a view setting', () => {
    assert.equal(affectsConnectionSettings(changeOf('azureDevOps.defaultProject'), keys), true);
    assert.equal(affectsConnectionSettings(changeOf('azureDevOps.workItemsView.columns', 'azureDevOps.organizationUrl'), keys), true);
});

test('unrelated settings do not count', () => {
    assert.equal(affectsConnectionSettings(changeOf('editor.fontSize'), keys), false);
});
