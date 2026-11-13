/** Minimal view of vscode.SecretStorage, so this logic can be unit tested without VS Code. */
export interface SecretStore {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
}

/**
 * Returns the Personal Access Token from secret storage. If none is stored yet but the
 * legacy plain-text `azureDevOps.personalAccessToken` setting has one, moves it into
 * secret storage and clears the setting.
 */
export async function getOrMigratePat(
    secrets: SecretStore,
    secretKey: string,
    readLegacySetting: () => string | undefined,
    clearLegacySetting: () => Promise<void>
): Promise<string> {
    const storedPat = (await secrets.get(secretKey))?.trim() || '';
    if (storedPat) {
        return storedPat;
    }

    const legacyPat = (readLegacySetting() || '').trim();
    if (!legacyPat) {
        return '';
    }

    await secrets.store(secretKey, legacyPat);
    await clearLegacySetting();
    return legacyPat;
}
