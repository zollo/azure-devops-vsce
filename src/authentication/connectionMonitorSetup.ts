import * as vscode from 'vscode';
import { AuthenticationManager } from './authenticationManager';
import { ConnectionHealth, ConnectionMonitor, ProbeResult } from './connectionMonitor';
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
    const onHealthChange = (health: ConnectionHealth) => {
        switch (health) {
            case 'connected':
                statusBar.updateStatus('connected');
                break;
            case 'offline':
                statusBar.updateStatus('offline');
                break;
            case 'authExpired':
                statusBar.updateStatus('authExpired');
                break;
        }
    };

    /**
     * Probes, and if the probe works but the extension is marked disconnected (after an
     * outage, a rejected request or a new sign-in), restores the connection and reloads the
     * views. A failed restore counts as unreachable, so the monitor keeps retrying.
     */
    const probeAndRecover = async (): Promise<ProbeResult> => {
        const result = await authManager.probeConnection();
        if (result !== 'ok' || authManager.isConnected()) {
            return result;
        }
        if (!await authManager.autoConnect()) {
            return 'unreachable';
        }
        vscode.commands.executeCommand('setContext', 'azureDevOps.connected', true);
        refreshViews();
        return 'ok';
    };

    const monitor = new ConnectionMonitor(
        {
            probe: probeAndRecover,
            refreshSilently: () => authManager.refreshSessionSilently(),
            promptReauthentication: () => authManager.promptReauthentication(),
            // Skip background checks when not configured or while VS Code is in the background.
            shouldCheck: () => !!authManager.getConfig()?.organizationUrl && vscode.window.state.focused,
            onHealthChange
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
            // Background checks off (interval 0) means no automatic probes on focus either.
            if (state.focused && readIntervalMs() > 0 && authManager.getConfig()?.organizationUrl) {
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
