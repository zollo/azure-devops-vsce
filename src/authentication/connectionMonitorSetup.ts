import * as vscode from 'vscode';
import { AuthenticationManager } from './authenticationManager';
import { ConnectionHealth, ConnectionMonitor } from './connectionMonitor';
import { StatusBarManager } from '../utils/statusBarManager';

/** Re-check on window focus only if the last check is older than this. */
const FOCUS_RECHECK_AGE_MS = 60_000;

function readIntervalMs(): number {
    const seconds = vscode.workspace.getConfiguration('azureDevOps').get<number>('connectionCheckInterval', 120);
    return Math.max(0, seconds) * 1000;
}

/**
 * Wires the background connection monitor into VS Code: status bar, context keys,
 * view refreshes, focus and configuration events, and the check/re-authenticate commands.
 */
export function startConnectionMonitor(
    context: vscode.ExtensionContext,
    authManager: AuthenticationManager,
    statusBar: StatusBarManager,
    refreshViews: () => void
): ConnectionMonitor {
    const onHealthChange = async (health: ConnectionHealth, previous: ConnectionHealth) => {
        switch (health) {
            case 'connected':
                if (previous === 'offline' || previous === 'authExpired' || !authManager.isConnected()) {
                    // Back after an outage or a sign-in: restore connection details and reload data.
                    await authManager.autoConnect();
                    vscode.commands.executeCommand('setContext', 'azureDevOps.connected', true);
                    statusBar.updateStatus('connected');
                    refreshViews();
                } else {
                    statusBar.updateStatus('connected');
                }
                break;
            case 'offline':
                statusBar.updateStatus('offline');
                break;
            case 'authExpired':
                statusBar.updateStatus('authExpired');
                break;
        }
    };

    const monitor = new ConnectionMonitor(
        {
            probe: () => authManager.probeConnection(),
            refreshSilently: () => authManager.refreshSessionSilently(),
            promptReauthentication: () => authManager.promptReauthentication(),
            // Skip background checks when not configured or while VS Code is in the background.
            shouldCheck: () => !!authManager.getConfig()?.organizationUrl && vscode.window.state.focused,
            onHealthChange: (health, previous) => {
                onHealthChange(health, previous).catch(err => console.warn('[ConnectionMonitor]', err));
            }
        },
        { intervalMs: readIntervalMs() }
    );

    context.subscriptions.push(
        { dispose: () => monitor.stop() },
        authManager.onDidDetectAuthFailure(() => monitor.reportAuthFailure()),
        authManager.onDidChangeSession((session) => {
            if (!session) {
                monitor.reset();
            } else if (monitor.getHealth() === 'authExpired' || monitor.getHealth() === 'offline') {
                void monitor.check(0);
            }
        }),
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused && authManager.getConfig()?.organizationUrl) {
                void monitor.check(FOCUS_RECHECK_AGE_MS);
            }
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('azureDevOps.connectionCheckInterval')) {
                monitor.setInterval(readIntervalMs());
            }
        }),
        vscode.commands.registerCommand('azureDevOps.checkConnection', async () => {
            if (!authManager.getConfig()?.organizationUrl) {
                await vscode.commands.executeCommand('azureDevOps.connect');
                return;
            }
            const health = await monitor.check(0);
            if (health === 'connected') {
                vscode.window.showInformationMessage('Connected to Azure DevOps.');
            } else if (health === 'offline') {
                vscode.window.showWarningMessage('Azure DevOps cannot be reached. Retrying in the background.');
            }
            // authExpired already shows the sign-in prompt once.
        }),
        vscode.commands.registerCommand('azureDevOps.reauthenticate', async () => {
            if (!authManager.getConfig()?.organizationUrl) {
                await vscode.commands.executeCommand('azureDevOps.connect');
                return;
            }
            await monitor.reauthenticate();
        })
    );

    monitor.start();
    return monitor;
}
