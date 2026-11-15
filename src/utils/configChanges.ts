/**
 * Settings under azureDevOps.* that don't affect the connection, such as how a view looks or how
 * often it refreshes. Changing one of them must not re-read the connection settings, which
 * reconnects and can mark an offline session disconnected.
 */
export const VIEW_ONLY_SETTING_PREFIXES: readonly string[] = [
    'azureDevOps.workItemsView',
    'azureDevOps.autoRefreshInterval',
    'azureDevOps.showNotifications'
];

/** The part of vscode.ConfigurationChangeEvent this module needs, so it can be tested without VS Code. */
export interface ConfigurationChange {
    affectsConfiguration(section: string): boolean;
}

function isViewOnly(key: string): boolean {
    return VIEW_ONLY_SETTING_PREFIXES.some(prefix => key === prefix || key.startsWith(prefix + '.'));
}

/**
 * True when a change touches an azureDevOps setting other than the view-only ones.
 * `contributedKeys` are the setting names from package.json (contributes.configuration.properties).
 */
export function affectsConnectionSettings(event: ConfigurationChange, contributedKeys: readonly string[]): boolean {
    if (!event.affectsConfiguration('azureDevOps')) {
        return false;
    }
    if (!VIEW_ONLY_SETTING_PREFIXES.some(prefix => event.affectsConfiguration(prefix))) {
        return true;
    }
    return contributedKeys.some(key => !isViewOnly(key) && event.affectsConfiguration(key));
}
