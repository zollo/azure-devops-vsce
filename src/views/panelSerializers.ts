import * as vscode from 'vscode';

/**
 * Bring the Board, Work Items and work item detail tabs back after a window reload. Each
 * webview records what it shows with vscode.setState (the board id, the work item id); VS Code
 * hands that state back here and the matching panel is rebuilt around the restored tab.
 */

export const BOARD_VIEW_TYPE = 'azureDevOpsBoard';
export const WORK_ITEMS_LIST_VIEW_TYPE = 'workItemsList';
export const WORK_ITEM_VIEW_TYPE = 'azureDevOpsWorkItem';

/** The board a restored tab showed, or undefined when its state doesn't name one. */
export function boardFromState(state: unknown): { boardId: string; boardName: string } | undefined {
    const s = state as { boardId?: unknown; boardName?: unknown } | null | undefined;
    if (!s || typeof s.boardId !== 'string' || !s.boardId) {
        return undefined;
    }
    return { boardId: s.boardId, boardName: typeof s.boardName === 'string' && s.boardName ? s.boardName : 'Board' };
}

/** The work item a restored detail tab showed, or undefined. */
export function workItemIdFromState(state: unknown): number | undefined {
    const id = Number((state as { workItemId?: unknown } | null | undefined)?.workItemId);
    return Number.isInteger(id) && id > 0 ? id : undefined;
}

export interface PanelRevivers {
    board(panel: vscode.WebviewPanel, boardId: string, boardName: string): void;
    workItemsList(panel: vscode.WebviewPanel): void;
    /** Resolves false when the work item can't be loaded any more. */
    workItem(panel: vscode.WebviewPanel, workItemId: number): Promise<boolean>;
}

/** Options every restored panel needs again: scripts on, resources only from the extension. */
export function restoredWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return { enableScripts: true, localResourceRoots: [extensionUri] };
}

export function registerPanelSerializers(extensionUri: vscode.Uri, revive: PanelRevivers, log: (message: string) => void): vscode.Disposable[] {
    const prepare = (panel: vscode.WebviewPanel) => {
        panel.webview.options = restoredWebviewOptions(extensionUri);
    };
    return [
        vscode.window.registerWebviewPanelSerializer(BOARD_VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                const board = boardFromState(state);
                if (!board) {
                    log('Not restoring a board tab: it did not record which board it showed');
                    panel.dispose();
                    return;
                }
                prepare(panel);
                revive.board(panel, board.boardId, board.boardName);
            }
        }),
        vscode.window.registerWebviewPanelSerializer(WORK_ITEMS_LIST_VIEW_TYPE, {
            async deserializeWebviewPanel(panel) {
                prepare(panel);
                revive.workItemsList(panel);
            }
        }),
        vscode.window.registerWebviewPanelSerializer(WORK_ITEM_VIEW_TYPE, {
            async deserializeWebviewPanel(panel, state) {
                const id = workItemIdFromState(state);
                if (!id) {
                    log('Not restoring a work item tab: it did not record which item it showed');
                    panel.dispose();
                    return;
                }
                prepare(panel);
                let restored = false;
                try {
                    restored = await revive.workItem(panel, id);
                } catch (error) {
                    log(`Could not restore work item #${id}: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (!restored) {
                    panel.dispose();
                }
            }
        })
    ];
}
