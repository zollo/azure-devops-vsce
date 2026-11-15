import { mock, resetMock } from './vscodeMock';
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    BOARD_VIEW_TYPE,
    WORK_ITEMS_LIST_VIEW_TYPE,
    WORK_ITEM_VIEW_TYPE,
    boardFromState,
    registerPanelSerializers,
    workItemIdFromState
} from '../../views/panelSerializers';

function fakePanel() {
    return {
        disposed: false,
        webview: { options: {} as Record<string, unknown> },
        dispose() { this.disposed = true; }
    };
}

function setup(workItemResult: boolean | Error = true) {
    const revived: unknown[][] = [];
    const logs: string[] = [];
    registerPanelSerializers({ path: '/ext' } as any, {
        board: (_panel, id, name) => { revived.push(['board', id, name]); },
        workItemsList: () => { revived.push(['list']); },
        workItem: async (_panel, id) => {
            revived.push(['workItem', id]);
            if (workItemResult instanceof Error) {
                throw workItemResult;
            }
            return workItemResult;
        }
    }, message => logs.push(message));
    return { revived, logs };
}

beforeEach(resetMock);

test('state parsing accepts what the webviews record and rejects anything else', () => {
    assert.deepEqual(boardFromState({ boardId: 'b1', boardName: 'Stories' }), { boardId: 'b1', boardName: 'Stories' });
    assert.deepEqual(boardFromState({ boardId: 'b1' }), { boardId: 'b1', boardName: 'Board' });
    assert.equal(boardFromState({ views: {} }), undefined);
    assert.equal(boardFromState(null), undefined);
    assert.equal(workItemIdFromState({ workItemId: 42 }), 42);
    assert.equal(workItemIdFromState({ workItemId: '42' }), 42);
    assert.equal(workItemIdFromState({ workItemId: 'x' }), undefined);
    assert.equal(workItemIdFromState({ workItemId: -1 }), undefined);
    assert.equal(workItemIdFromState(undefined), undefined);
});

test('restored tabs are rebuilt with scripts enabled and the right content', async () => {
    const { revived } = setup();
    const board = fakePanel();
    await mock.serializers.get(BOARD_VIEW_TYPE)!.deserializeWebviewPanel(board, { boardId: 'b1', boardName: 'Stories', views: {} });
    const list = fakePanel();
    await mock.serializers.get(WORK_ITEMS_LIST_VIEW_TYPE)!.deserializeWebviewPanel(list, undefined);
    const detail = fakePanel();
    await mock.serializers.get(WORK_ITEM_VIEW_TYPE)!.deserializeWebviewPanel(detail, { workItemId: 7 });
    assert.deepEqual(revived, [['board', 'b1', 'Stories'], ['list'], ['workItem', 7]]);
    for (const panel of [board, list, detail]) {
        assert.equal(panel.webview.options.enableScripts, true);
        assert.equal(panel.disposed, false);
    }
});

test('tabs that cannot be restored are closed instead of left blank', async () => {
    const { revived, logs } = setup(false);
    const board = fakePanel();
    await mock.serializers.get(BOARD_VIEW_TYPE)!.deserializeWebviewPanel(board, {});
    const missing = fakePanel();
    await mock.serializers.get(WORK_ITEM_VIEW_TYPE)!.deserializeWebviewPanel(missing, { workItemId: 9 });
    assert.equal(board.disposed, true);
    assert.equal(missing.disposed, true);
    assert.deepEqual(revived, [['workItem', 9]]);
    assert.equal(logs.length, 1);

    resetMock();
    const failing = setup(new Error('offline'));
    const detail = fakePanel();
    await mock.serializers.get(WORK_ITEM_VIEW_TYPE)!.deserializeWebviewPanel(detail, { workItemId: 3 });
    assert.equal(detail.disposed, true);
    assert.match(failing.logs[0], /offline/);
});

test('package.json activates the extension for every restorable tab', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    for (const viewType of [BOARD_VIEW_TYPE, WORK_ITEMS_LIST_VIEW_TYPE, WORK_ITEM_VIEW_TYPE]) {
        assert.ok(pkg.activationEvents.includes(`onWebviewPanel:${viewType}`), viewType);
    }
});

test('the board and detail webviews record what they show', () => {
    const media = path.join(__dirname, '..', '..', '..', 'media');
    assert.match(fs.readFileSync(path.join(media, 'board', 'board.js'), 'utf8'), /vscode\.setState\(.*boardId: BOARD_DATA\.boardKey/);
    assert.match(fs.readFileSync(path.join(media, 'workItem', 'workItem.js'), 'utf8'), /vscode\.setState\(.*workItemId: WORK_ITEM_DATA\.workItemId/);
});
