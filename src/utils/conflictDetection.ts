import * as vscode from 'vscode';

/**
 * Extension ID of the original "Azure DevOps Boards" extension by Damilola Onadeinde,
 * which this extension was forked from. Both contribute the same `azureDevOps.*`
 * command, view and setting IDs, so they cannot run side by side.
 */
export const ORIGINAL_EXTENSION_ID = 'Damilola.azure-devops-boards';

/**
 * Returns true when the original extension is installed and enabled alongside this one.
 * In that case an error is shown with options to find or uninstall the original, and the
 * caller should stop activating, because registering the shared command IDs would fail.
 */
export function detectOriginalExtensionConflict(context: vscode.ExtensionContext): boolean {
    if (context.extension.id.toLowerCase() === ORIGINAL_EXTENSION_ID.toLowerCase()) {
        return false;
    }

    // getExtension only returns installed, enabled extensions (case-insensitive ID match).
    if (!vscode.extensions.getExtension(ORIGINAL_EXTENSION_ID)) {
        return false;
    }

    const showOriginal = 'Show Original Extension';
    const uninstallOriginal = 'Uninstall Original';
    vscode.window.showErrorMessage(
        'ADO Boards cannot run while the original "Azure DevOps Boards" extension ' +
        `(${ORIGINAL_EXTENSION_ID}) is also enabled, because both use the same commands and settings. ` +
        'Disable or uninstall the original, then reload the window. Your existing settings will carry over.',
        showOriginal,
        uninstallOriginal
    ).then(async choice => {
        if (choice === showOriginal) {
            await vscode.commands.executeCommand('workbench.extensions.search', `@installed ${ORIGINAL_EXTENSION_ID}`);
        } else if (choice === uninstallOriginal) {
            await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', ORIGINAL_EXTENSION_ID);
            const reload = 'Reload Window';
            const next = await vscode.window.showInformationMessage(
                'The original extension was uninstalled. Reload the window to start ADO Boards.',
                reload
            );
            if (next === reload) {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        }
    });

    return true;
}
