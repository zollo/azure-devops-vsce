import * as vscode from 'vscode';
import { AuthenticationManager } from './authenticationManager';
import { organizationLabel } from '../onboarding/discovery';
import { ConnectionHealth } from './connectionMonitor';

class ConnectionStatusItem extends vscode.TreeItem {
    constructor(
        label: string,
        description?: string,
        command?: vscode.Command,
        iconPath?: vscode.ThemeIcon
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.description = description;
        this.command = command;
        this.iconPath = iconPath;
    }
}

export class ConnectionStatusProvider implements vscode.TreeDataProvider<ConnectionStatusItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ConnectionStatusItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private authManager: AuthenticationManager, private context: vscode.ExtensionContext) {
        this.authManager.onDidChangeSession(() => {
            this.refresh();
        });
    }

    private health: ConnectionHealth = 'unknown';

    /** Called by the connection monitor so the view warns about outages and expired sign-ins. */
    setHealth(health: ConnectionHealth): void {
        if (health !== this.health) {
            this.health = health;
            this.refresh();
        }
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ConnectionStatusItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ConnectionStatusItem): Promise<ConnectionStatusItem[]> {
        if (element) {
            return [];
        }

        const items: ConnectionStatusItem[] = [];
        const session = await this.authManager.getSession();

        if (!session) {
            // Return empty - the welcome view will show the sign-in button
            return [];
        }

        const userInfo = await this.authManager.getUserInfo();
        const config = this.authManager.getConfig();
        const settings = vscode.workspace.getConfiguration('azureDevOps');
        const change: vscode.Command = { command: 'azureDevOps.getStarted', title: 'Change Connection Settings' };

        // Account, then where you are connected. Changing settings and signing out live in the
        // view's title bar, so the list stays short.
        const isPat = this.authManager.getConfiguredAuthenticationMethod() === 'pat';
        const account = new ConnectionStatusItem(
            isPat ? 'Personal access token' : userInfo?.name || 'Signed in',
            isPat ? '' : userInfo?.email || '',
            undefined,
            new vscode.ThemeIcon(isPat ? 'key' : 'account')
        );
        items.push(account);

        if (!config?.organizationUrl) {
            items.push(new ConnectionStatusItem('Choose an organization', '', change, new vscode.ThemeIcon('warning', new vscode.ThemeColor('notificationsWarningIcon.foreground'))));
            return items;
        }

        const organization = new ConnectionStatusItem(organizationLabel(config.organizationUrl), '', change, new vscode.ThemeIcon('organization'));
        organization.tooltip = config.organizationUrl;
        items.push(organization);

        if (config.defaultProject) {
            items.push(new ConnectionStatusItem(config.defaultProject, '', change, new vscode.ThemeIcon('project')));
        }

        let teams = settings.get<string[]>('teams', []).filter(t => typeof t === 'string' && t);
        const primary = config.defaultTeam || teams[0];
        if (primary && !teams.some(t => t.toLowerCase() === primary.toLowerCase())) {
            // Select Team changed the team without updating the saved list, so the list is stale.
            teams = [primary];
        }
        if (primary) {
            const others = teams.filter(t => t.toLowerCase() !== primary.toLowerCase()).length;
            const team = new ConnectionStatusItem(primary, others ? `+${others} more` : '', change, new vscode.ThemeIcon('people'));
            team.tooltip = teams.length > 1 ? `Teams: ${teams.join(', ')} (primary: ${primary})` : `Team: ${primary}`;
            items.push(team);
        }

        const problem = this.health === 'authExpired' ? 'Sign-in expired'
            : this.health === 'offline' ? 'Cannot reach Azure DevOps'
            : !this.authManager.isConnected() ? 'Not connected'
            : undefined;
        if (problem) {
            items.push(new ConnectionStatusItem(
                problem,
                'Check connection',
                { command: 'azureDevOps.checkConnection', title: 'Check Connection' },
                new vscode.ThemeIcon('warning', new vscode.ThemeColor('notificationsWarningIcon.foreground'))
            ));
        }

        return items;
    }
}

