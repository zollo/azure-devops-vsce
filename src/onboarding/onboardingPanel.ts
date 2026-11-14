import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { ARM_SCOPE, AZURE_DEVOPS_SCOPE, Hints, HttpGet, parseAzureReposRemote, RemoteInfo, remoteUrlsFromGitConfig } from './discovery';
import { MicrosoftSession, OnboardingController, OnboardingResult, WebviewMessage } from './onboardingController';
import { vendorAssetUri } from '../utils/webviewAssets';

/** globalState key: the user chose "Skip setup", so don't open the wizard on startup again. */
export const ONBOARDING_DISMISSED_KEY = 'azureDevOps.onboarding.dismissed';

const PAT_SECRET_KEY = 'ado-pat';
const SESSION_SECRET_KEY = 'ado-session-id';
const TENANT_SECRET_KEY = 'ado-tenant-id';

/**
 * The "Get started" editor tab: welcome, feature overview, sign-in (Microsoft account or PAT)
 * and a review step with detected tenant, organization, project and teams.
 */
export class OnboardingPanel {
    private static current: OnboardingPanel | undefined;

    private readonly controller: OnboardingController;
    private readonly disposables: vscode.Disposable[] = [];

    /** Opens the wizard, or focuses it if it is already open. */
    public static show(context: vscode.ExtensionContext, onConfigured: () => Promise<void>): void {
        if (OnboardingPanel.current) {
            OnboardingPanel.current.panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel('azureDevOpsOnboarding', 'Get Started with ADO Boards', vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.joinPath(context.extensionUri, 'media'),
                vscode.Uri.joinPath(context.extensionUri, 'dist', 'vendor')
            ]
        });
        panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
        OnboardingPanel.current = new OnboardingPanel(panel, context, onConfigured);
    }

    /** First run: open the wizard when nothing is configured and the user hasn't skipped it. */
    public static shouldShowOnStartup(context: vscode.ExtensionContext): boolean {
        if (context.globalState.get<boolean>(ONBOARDING_DISMISSED_KEY, false)) {
            return false;
        }
        const organizationUrl = vscode.workspace.getConfiguration('azureDevOps').get<string>('organizationUrl', '');
        return !organizationUrl.trim();
    }

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly context: vscode.ExtensionContext,
        private readonly onConfigured: () => Promise<void>
    ) {
        this.controller = new OnboardingController({
            signInMicrosoft: tenant => this.signInMicrosoft(tenant),
            getArmToken: interactive => this.getArmToken(interactive),
            createHttp: authorization => createHttp(authorization),
            getHints: () => collectHints(),
            save: result => this.save(result),
            dismiss: () => this.dismiss(),
            post: state => { void this.panel.webview.postMessage({ type: 'state', state }); },
            log: message => console.log(`[Onboarding] ${message}`)
        });

        panel.webview.html = this.getHtml(panel.webview);
        panel.webview.onDidReceiveMessage((message: WebviewMessage | { type: 'runCommand'; command?: string }) => {
            if (message.type === 'runCommand') {
                this.runCommand(message.command);
                return;
            }
            void this.controller.handle(message);
        }, undefined, this.disposables);
        panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    }

    private async signInMicrosoft(tenant: string | undefined): Promise<MicrosoftSession | undefined> {
        const scopes = tenant ? [AZURE_DEVOPS_SCOPE, `VSCODE_TENANT:${tenant}`] : [AZURE_DEVOPS_SCOPE];
        const session = await vscode.authentication.getSession('microsoft', scopes, {
            createIfNone: true,
            // Let the user pick the account on first sign-in instead of reusing a remembered one.
            clearSessionPreference: !tenant
        });
        return session ? { id: session.id, accessToken: session.accessToken, accountLabel: session.account.label } : undefined;
    }

    private async getArmToken(interactive: boolean): Promise<string | undefined> {
        try {
            const session = await vscode.authentication.getSession('microsoft', [ARM_SCOPE], interactive ? { createIfNone: true } : { silent: true });
            return session?.accessToken;
        } catch {
            return undefined;
        }
    }

    private async save(result: OnboardingResult): Promise<void> {
        const secrets = this.context.secrets;
        // Secrets first: AuthenticationManager reloads as soon as the settings below change.
        if (result.authMethod === 'pat') {
            await secrets.store(PAT_SECRET_KEY, result.pat ?? '');
        } else {
            await secrets.store(SESSION_SECRET_KEY, result.sessionId ?? '');
            if (result.tenantId) {
                await secrets.store(TENANT_SECRET_KEY, result.tenantId);
            } else {
                await secrets.delete(TENANT_SECRET_KEY);
            }
        }

        const config = vscode.workspace.getConfiguration('azureDevOps');
        const target = vscode.ConfigurationTarget.Global;
        await config.update('authenticationMethod', result.authMethod === 'pat' ? 'pat' : 'oauth', target);
        await config.update('organizationUrl', result.organizationUrl, target);
        await config.update('defaultProject', result.project, target);
        await config.update('defaultTeam', result.teams[0] ?? '', target);
        await config.update('teams', result.teams, target);

        await this.onConfigured();
    }

    private dismiss(): void {
        void this.context.globalState.update(ONBOARDING_DISMISSED_KEY, true);
        this.panel.dispose();
        void vscode.window.showInformationMessage(
            'Setup skipped. You can start it any time from the Azure DevOps view or with "Azure DevOps: Get Started".'
        );
    }

    private runCommand(command: string | undefined): void {
        const allowed = new Set(['azureDevOps.openBoardPanel', 'azureDevOps.openWorkItemsPanel', 'workbench.view.extension.azure-devops', 'close']);
        if (!command || !allowed.has(command)) {
            return;
        }
        if (command === 'close') {
            this.panel.dispose();
            return;
        }
        void vscode.commands.executeCommand(command);
        if (command !== 'workbench.view.extension.azure-devops') {
            this.panel.dispose();
        }
    }

    private dispose(): void {
        OnboardingPanel.current = undefined;
        while (this.disposables.length) {
            this.disposables.pop()?.dispose();
        }
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = getNonce();
        const media = (...segments: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...segments));
        const codiconCss = vendorAssetUri(webview, this.context.extensionUri, 'codicons', 'codicon.css');
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource}`,
            `font-src ${webview.cspSource}`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        const version = String(this.context.extension?.packageJSON?.version ?? '');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="stylesheet" href="${codiconCss}">
    <link rel="stylesheet" href="${media('onboarding', 'onboarding.css')}">
    <title>Get Started with ADO Boards</title>
</head>
<body>
    <main id="app" data-logo="${media('icon.png')}" data-version="${version.replace(/[^0-9A-Za-z.+-]/g, '')}" aria-live="polite"></main>
    <script nonce="${nonce}" src="${media('onboarding', 'onboarding.js')}"></script>
</body>
</html>`;
    }
}

function createHttp(authorization: string): HttpGet {
    return async (url, params) => {
        const response = await axios.get(url, {
            params,
            headers: { Authorization: authorization, Accept: 'application/json' },
            timeout: 30000
        });
        return { data: response.data, headers: response.headers as Record<string, unknown> };
    };
}

/** Workspace and settings values that let the wizard preselect the organization, project and teams. */
async function collectHints(): Promise<Hints> {
    const config = vscode.workspace.getConfiguration('azureDevOps');
    const savedTeams = config.get<string[]>('teams', []).filter(t => typeof t === 'string' && t);
    const defaultTeam = config.get<string>('defaultTeam', '');
    return {
        remotes: await detectRemotes(),
        organizationUrl: config.get<string>('organizationUrl', '') || undefined,
        project: config.get<string>('defaultProject', '') || undefined,
        // Select Team changes only defaultTeam, so it stays the primary (first) team.
        teams: defaultTeam
            ? [defaultTeam, ...savedTeams.filter(t => t.toLowerCase() !== defaultTeam.toLowerCase())]
            : savedTeams.length ? savedTeams : undefined
    };
}

async function detectRemotes(): Promise<RemoteInfo[]> {
    const urls: string[] = [];
    // The built-in Git extension knows about nested repositories and worktrees.
    try {
        const git = vscode.extensions.getExtension<any>('vscode.git');
        const api = git?.isActive ? git.exports.getAPI(1) : undefined;
        for (const repo of api?.repositories ?? []) {
            const remotes: any[] = repo.state?.remotes ?? [];
            // "origin" first: it's usually the one people mean.
            remotes.sort((a, b) => (a.name === 'origin' ? -1 : b.name === 'origin' ? 1 : 0));
            for (const remote of remotes) {
                urls.push(remote.fetchUrl, remote.pushUrl);
            }
        }
    } catch {
        // Fall back to reading .git/config below.
    }
    if (!urls.length) {
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            if (folder.uri.scheme !== 'file') {
                continue;
            }
            try {
                const text = await fs.promises.readFile(path.join(folder.uri.fsPath, '.git', 'config'), 'utf8');
                urls.push(...remoteUrlsFromGitConfig(text));
            } catch {
                // Not a Git repository, or .git is a file (worktree); skip.
            }
        }
    }
    const seen = new Set<string>();
    const remotes: RemoteInfo[] = [];
    for (const url of urls) {
        const info = url ? parseAzureReposRemote(url) : undefined;
        const key = info ? `${info.organizationUrl}|${info.project}`.toLowerCase() : '';
        if (info && !seen.has(key)) {
            seen.add(key);
            remotes.push(info);
        }
    }
    return remotes;
}

function getNonce(): string {
    return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}
