import './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { decorateWorkItemRow, hasChildLinks, OPEN_WORK_ITEM_COMMAND } from '../../views/workItemTreeItems';

const item = {
    id: 42,
    fields: { 'System.Title': 'Fix *it* <b>', 'System.WorkItemType': 'Bug', 'System.State': 'Active', 'System.AssignedTo': { displayName: 'Ann' } }
};

test('every work item row opens the item, including parents', () => {
    const row = decorateWorkItemRow(new vscode.TreeItem('', vscode.TreeItemCollapsibleState.Collapsed), item);
    assert.equal(row.command?.command, OPEN_WORK_ITEM_COMMAND);
    assert.deepEqual(row.command?.arguments, [42]);
    assert.equal(row.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.equal(row.label, '#42: Fix *it* <b>');
    assert.equal(row.description, 'Bug • Active');
    assert.equal(row.contextValue, 'workItem');
});

test('rows take a custom description and icon', () => {
    const icon = new vscode.ThemeIcon('bug');
    const row = decorateWorkItemRow(new vscode.TreeItem(''), item, { description: 'Active • Ann', iconPath: icon });
    assert.equal(row.description, 'Active • Ann');
    assert.equal(row.iconPath, icon);
});

test('tooltips add work item text as plain text, not markdown', () => {
    const row = decorateWorkItemRow(new vscode.TreeItem(''), item);
    const value = (row.tooltip as vscode.MarkdownString).value;
    assert.match(value, /Fix \\\*it\\\* \\<b\\>/);
    assert.match(value, /\*\*Assigned to:\*\* Ann/);
});

test('hasChildLinks finds hierarchy-forward relations', () => {
    assert.equal(hasChildLinks({ relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward' }] }), true);
    assert.equal(hasChildLinks({ relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse' }] }), false);
    assert.equal(hasChildLinks({}), false);
});
