import * as vscode from 'vscode';

/** What a tree shows when its data can't be loaded. */
export interface LoadErrorInfo {
    /** Short label for the tree row. */
    label: string;
    /** The underlying error, for the tooltip. */
    detail: string;
    /** True when signing in again is the fix (401 or 403 from Azure DevOps). */
    signInAgain: boolean;
}

/**
 * Turns a failed request into something a person can act on, so a failure shows up as an
 * error with a way forward instead of looking like an empty list.
 */
export function describeLoadError(error: unknown, what: string): LoadErrorInfo {
    const err = error as any;
    const status: number | undefined = err?.response?.status;
    const serverMessage: string | undefined = err?.response?.data?.message;
    const detail = String(serverMessage || err?.message || err || 'Unknown error');

    if (status === 401) {
        return { label: `Couldn't load ${what}: sign-in expired`, detail, signInAgain: true };
    }
    if (status === 403) {
        return { label: `Couldn't load ${what}: access denied`, detail, signInAgain: true };
    }
    if (status === 404) {
        return { label: `Couldn't load ${what}: not found`, detail, signInAgain: false };
    }
    if (!err?.response && (err?.code || /network|timeout|ENOTFOUND|ECONN/i.test(detail))) {
        return { label: `Couldn't load ${what}: can't reach Azure DevOps`, detail, signInAgain: false };
    }
    return { label: `Couldn't load ${what}`, detail, signInAgain: false };
}

/**
 * Fills in a tree item as an error row. Clicking it retries with `retryCommand`, or opens
 * Sign In Again when that is the fix.
 */
export function applyLoadError<T extends vscode.TreeItem>(item: T, info: LoadErrorInfo, retryCommand: string): T {
    item.label = info.label;
    item.description = info.signInAgain ? 'Sign in again' : 'Click to retry';
    item.tooltip = info.detail;
    item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    item.contextValue = 'loadError';
    item.collapsibleState = vscode.TreeItemCollapsibleState.None;
    item.command = info.signInAgain
        ? { command: 'azureDevOps.reauthenticate', title: 'Sign In Again' }
        : { command: retryCommand, title: 'Retry' };
    return item;
}
