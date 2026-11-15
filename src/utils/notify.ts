import * as vscode from 'vscode';

/**
 * Confirms a routine action (saved, moved, assigned...) in the status bar for a few seconds
 * instead of a notification toast, so a run of edits doesn't pile up toasts. Errors, results
 * the user has to read, and messages with buttons still use notifications.
 * Turned off entirely by the azureDevOps.showNotifications setting.
 */
export function notifySuccess(message: string): void {
    if (!vscode.workspace.getConfiguration('azureDevOps').get<boolean>('showNotifications', true)) {
        return;
    }
    vscode.window.setStatusBarMessage(`$(check) ${message.replace(/^✓\s*/, '')}`, 5000);
}

/** Reports the result of a bulk edit: in the status bar when all succeeded, as a warning when some failed. */
export function notifyBulkResult(message: string, failed: number): void {
    if (failed > 0) {
        void vscode.window.showWarningMessage(`${message} (${failed} failed)`);
    } else {
        notifySuccess(message);
    }
}
