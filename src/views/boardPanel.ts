import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { notifySuccess } from '../utils/notify';
import { vendorAssetUri } from '../utils/webviewAssets';
import { extractWorkItemIdFromUrl } from '../utils/workItemUrls';
import { getNonce, jsArg, safeCssColor, serializeForScript, webviewCsp } from '../utils/webviewSecurity';
import { AuthenticationManager } from '../authentication/authenticationManager';
import { WorkItemEventManager } from '../events/workItemEventManager';
import { OrganizationManager } from '../authentication/organizationManager';
import { outputChannel } from '../extension';
import { azureDevOps } from '../services/azureDevOpsService';
import { sharedMetadataCache } from '../utils/metadataCache';
import { BOARD_VIEW_TYPE } from './panelSerializers';

/** Stands in for the script nonce while comparing renders; replaced before the HTML is shown. */
const NONCE_PLACEHOLDER = '__BOARD_NONCE__';

interface BoardColumn {
    id: string;
    name: string;
    itemLimit: number;
    stateMappings: Record<string, string>;
    isSplit: boolean;
    description: string;
    columnType: 'incoming' | 'inProgress' | 'outgoing';
}

interface BoardWorkItem {
    id: number;
    title: string;
    state: string;
    type: string;
    assignedTo?: {
        displayName: string;
        uniqueName: string;
        imageUrl?: string;
    };
    priority?: number;
    tags?: string;
    areaPath?: string;
    iterationPath?: string;
    boardColumn?: string;
    effort?: number;
    children?: {
        id: number;
        title: string;
        state: string;
        type: string;
    }[];
}

interface Board {
    id: string;
    name: string;
    columns: BoardColumn[];
    workItems: Map<string, BoardWorkItem[]>;
}

interface AvailableBoard {
    id: string;
    name: string;
}

export class BoardPanel {
    public static currentPanel: BoardPanel | undefined;

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private authenticationManager: AuthenticationManager;
    private currentBoard: Board | null = null;
    private availableBoards: AvailableBoard[] = [];
    private boardId: string;
    private boardName: string;
    private _refreshInterval: NodeJS.Timeout | undefined;
    private _lastRefreshTime: number = 0;
    private eventManager = WorkItemEventManager.getInstance();
    private eventSubscription: vscode.Disposable | null = null;
    private _tagColors: Map<string, string> = new Map();
    private _cardStyleRules: Array<{name: string, filter: string, settings: any}> = [];
    private _projectWorkItemTypes: string[] = [];
    private _pendingMoves: Set<number> = new Set();
    private _filterState: {
        search?: string;
        assignee?: string[];
        type?: string[];
        priority?: string[];
        state?: string[];
        iteration?: string[];
        hideDone?: boolean;
    } = {};
    private _isLoading: boolean = false;
    /** The last board page set on the webview; an unchanged refresh doesn't rebuild the page. */
    private _lastBoardHtml: string | undefined;
    /** True while the person is dragging, editing or has a menu open; automatic refreshes wait. */
    private _uiBusy = false;
    private _refreshPendingWhileBusy = false;
    private _loadDebounceTimer: NodeJS.Timeout | undefined;
    private _teamIterations: Array<{name: string, path: string, timeFrame: string}> = [];

    // Cache timestamps for metadata (5 minute cache)
    private _metadataCacheTime: number = 0;
    private readonly METADATA_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

    public static createOrShow(
        extensionUri: vscode.Uri,
        authenticationManager: AuthenticationManager,
        boardId: string,
        boardName: string
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel for this board, show it
        if (BoardPanel.currentPanel && BoardPanel.currentPanel.boardId === boardId) {
            BoardPanel.currentPanel._panel.reveal(column);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            BOARD_VIEW_TYPE,
            `Board: ${boardName}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        BoardPanel.currentPanel = new BoardPanel(panel, extensionUri, authenticationManager, boardId, boardName);
    }

    /** Rebuilds the board in a tab VS Code restored after a window reload. */
    public static revive(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        authenticationManager: AuthenticationManager,
        boardId: string,
        boardName: string
    ) {
        BoardPanel.currentPanel?.dispose();
        BoardPanel.currentPanel = new BoardPanel(panel, extensionUri, authenticationManager, boardId, boardName);
    }

    private static readonly EVENT_SOURCE = 'board';

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        authenticationManager: AuthenticationManager,
        boardId: string,
        boardName: string
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this.authenticationManager = authenticationManager;
        this.boardId = boardId;
        this.boardName = boardName;

        // Set initial loading state
        this._panel.webview.html = this._getLoadingHtml();

        // Subscribe to work item updates from other views with debouncing
        this.eventSubscription = this.eventManager.onWorkItemUpdated((event) => {
            // The board already shows its own edits; reloading for them only redrew the page
            if (event.source === BoardPanel.EVENT_SOURCE) {
                return;
            }
            // Don't refresh if we have pending moves (to avoid race conditions)
            if (this._pendingMoves.size === 0 && !this._isLoading) {
                // Debounce - wait 2 seconds before actually refreshing
                if (this._loadDebounceTimer) {
                    clearTimeout(this._loadDebounceTimer);
                }
                this._loadDebounceTimer = setTimeout(() => {
                    outputChannel.appendLine('[Board] Debounced refresh triggered by work item update');
                    this._loadAndRender();
                }, 2000);
            }
        });

        // Load board data and update (full refresh on initial load)
        this._loadAndRender(true);

        // Start auto-refresh (every 30 seconds)
        this._startAutoRefresh();

        // Handle panel disposal
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'moveWorkItem':
                        await this._moveWorkItem(message.workItemId, message.targetColumn, message.targetState);
                        break;
                    case 'openWorkItem':
                        vscode.commands.executeCommand('azureDevOps.viewWorkItemDetails', message.workItemId);
                        break;
                    case 'refresh':
                        // The person asked for it: re-read team iterations, areas and members too
                        sharedMetadataCache.invalidate();
                        await this._loadAndRender(true); // Full refresh when user clicks refresh button
                        break;
                    case 'openInBrowser':
                        this._openBoardInBrowser();
                        break;
                    case 'createWorkItem':
                        await this._createWorkItem(message.columnName, message.title, message.workItemType);
                        break;
                    case 'assignToMe':
                        await this._assignToMe(message.workItemId);
                        break;
                    case 'changeState':
                        await this._changeState(message.workItemId, message.state);
                        break;
                    case 'addComment':
                        await this._addComment(message.workItemId);
                        break;
                    case 'copyId':
                        await vscode.env.clipboard.writeText(message.workItemId.toString());
                        notifySuccess(`Copied #${message.workItemId} to clipboard`);
                        break;
                    case 'copyUrl':
                        await this._copyWorkItemUrl(message.workItemId);
                        break;
                    case 'openWorkItemInBrowser':
                        this._openWorkItemInBrowser(message.workItemId);
                        break;
                    case 'createBranch':
                        vscode.commands.executeCommand('azureDevOps.createBranchFromWorkItem', message.workItemId);
                        break;
                    case 'switchBoard':
                        await this._switchBoard(message.boardId, message.boardName);
                        break;
                    case 'showError':
                        vscode.window.showErrorMessage(message.text);
                        break;
                    case 'showInfo':
                        vscode.window.showInformationMessage(message.text);
                        break;
                    case 'getCurrentUser': {
                        const currentUser = await this.authenticationManager.getCurrentUser();
                        // Try multiple fields to find the user's email/uniqueName
                        const userEmail = currentUser?.uniqueName
                            || currentUser?.emailAddress
                            || currentUser?.providerDisplayName
                            || currentUser?.mailAddress
                            || currentUser?.properties?.Account?.$value
                            || currentUser?.properties?.Mail?.$value
                            || '';

                        outputChannel.appendLine(`[Board] getCurrentUser extracted email: "${userEmail}" from user: ${JSON.stringify(currentUser)}`);

                        this._panel.webview.postMessage({
                            command: 'setCurrentUser',
                            email: userEmail
                        });
                        break;
                    }
                    case 'saveFilterState':
                        this._filterState = message.filterState || {};
                        break;
                    case 'uiBusy':
                        this._uiBusy = !!message.busy;
                        if (!this._uiBusy && this._refreshPendingWhileBusy) {
                            this._refreshPendingWhileBusy = false;
                            await this._loadAndRender();
                        }
                        break;
                    case 'debugLog':
                        outputChannel.appendLine(`[Webview] ${message.text}`);
                        break;
                    case 'updateWorkItemTitle':
                        await this._updateWorkItemTitle(message.workItemId, message.title);
                        break;
                    case 'updateWorkItemEffort':
                        await this._updateWorkItemEffort(message.workItemId, message.effort);
                        break;
                    case 'changeAssignee':
                        await this._changeAssignee(message.workItemId);
                        break;
                    case 'confirmDeleteWorkItem':
                        await this._confirmDeleteWorkItem(message.workItemId);
                        break;
                    case 'deleteWorkItem':
                        await this._deleteWorkItem(message.workItemId);
                        break;
                    case 'moveToColumn':
                        await this._showMoveToColumnPicker(message.workItemId);
                        break;
                    case 'moveToIteration':
                        await this._showMoveToIterationPicker(message.workItemId);
                        break;
                    case 'addChildWorkItem':
                        await this._addChildWorkItem(message.workItemId, message.workItemType);
                        break;
                    case 'updateChildWorkItemState':
                        await this._updateChildWorkItemState(message.workItemId, message.state);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    private _teamMembers: Array<{displayName: string, uniqueName: string}> = [];
    private _currentIterationPath: string | null = null;
    private _teamAreaPath: string | null = null;

    private async _loadAndRender(fullRefresh: boolean = false) {
        // Prevent concurrent loads
        if (this._isLoading && !fullRefresh) {
            outputChannel.appendLine('[Board] Already loading, skipping duplicate request');
            return;
        }

        // Don't redraw under the person's hands; refresh once they finish dragging or editing
        if (!fullRefresh && this._uiBusy && this.currentBoard) {
            this._refreshPendingWhileBusy = true;
            return;
        }

        try {
            this._isLoading = true;
            // Update last refresh time
            this._lastRefreshTime = Date.now();
            outputChannel.appendLine(`[Board] Starting load (fullRefresh: ${fullRefresh})`);

            // Show loading screen only on initial load, not on refresh
            if (!this.currentBoard) {
                this._panel.webview.html = this._getLoadingHtml();
                this._lastBoardHtml = undefined;
            }

            // Check if metadata cache is still valid (within 5 minutes)
            const now = Date.now();
            const metadataCacheValid = !fullRefresh && (now - this._metadataCacheTime) < this.METADATA_CACHE_DURATION;

            // Only reload metadata on full refresh, if not loaded yet, or if cache expired
            if (!metadataCacheValid) {
                outputChannel.appendLine('[Board] Reloading metadata (cache expired or full refresh)');

                // These lookups don't depend on each other, so they run together
                await Promise.all([
                    (fullRefresh || this.availableBoards.length === 0)
                        ? this._getAvailableBoards().then(boards => { this.availableBoards = boards; })
                        : undefined,
                    (fullRefresh || this._tagColors.size === 0) ? this._getTagColors() : undefined,
                    (fullRefresh || this._projectWorkItemTypes.length === 0) ? this._fetchProjectWorkItemTypes() : undefined,
                    (fullRefresh || this._teamMembers.length === 0)
                        ? this._getTeamMembers().then(members => { this._teamMembers = members; })
                        : undefined,
                    (fullRefresh || this._teamIterations.length === 0)
                        ? this._getAllTeamIterations().then(iterations => { this._teamIterations = iterations; })
                        : undefined,
                    (fullRefresh || !this._currentIterationPath)
                        ? this._getCurrentIteration().then(path => { this._currentIterationPath = path; })
                        : undefined,
                    (fullRefresh || !this._teamAreaPath)
                        ? this._getTeamAreaPath().then(path => { this._teamAreaPath = path; })
                        : undefined
                ]);

                // Update cache timestamp
                this._metadataCacheTime = now;
            } else {
                outputChannel.appendLine('[Board] Using cached metadata (still valid)');
            }

            // Always reload board data (this is what changes frequently)
            await this._loadBoardData();

            // Add any assignees from work items that aren't in team members
            if (this.currentBoard) {
                const uniqueAssignees = new Map<string, {displayName: string, uniqueName: string}>();
                
                // First add existing team members
                this._teamMembers.forEach(m => uniqueAssignees.set(m.uniqueName.toLowerCase(), m));

                // Then add from work items
                this.currentBoard.workItems.forEach(items => {
                    items.forEach(item => {
                        const assignee = item.assignedTo as any;
                        if (assignee) {
                            // Handle if assignee is a complex object (standard)
                            if (assignee.uniqueName && assignee.displayName) {
                                const key = assignee.uniqueName.toLowerCase();
                                if (!uniqueAssignees.has(key)) {
                                    uniqueAssignees.set(key, {
                                        displayName: assignee.displayName,
                                        uniqueName: assignee.uniqueName
                                    });
                                }
                            }
                            // Handle edge case if assignee is just a string (sometimes happens in older API versions or specific configs)
                            else if (typeof assignee === 'string') {
                                // Use the string as both uniqueName and displayName if we can't do better
                                const key = assignee.toLowerCase();
                                // Try to ignore if it looks like an email but we already have it
                                let exists = false;
                                for (const existing of uniqueAssignees.values()) {
                                    if (existing.uniqueName.toLowerCase() === key || existing.displayName.toLowerCase() === key) {
                                        exists = true;
                                        break;
                                    }
                                }
                                
                                if (!exists) {
                                    uniqueAssignees.set(key, {
                                        displayName: assignee,
                                        uniqueName: assignee
                                    });
                                }
                            }
                        }
                    });
                });

                // Note: _teamMembers is loaded from the team API in _loadAndRender(),
                // NOT from work item assignees. This ensures we only show actual team members.
            }

            try {
                // Rendered with a placeholder nonce so unchanged boards compare equal
                const template = this._getHtmlForWebview(NONCE_PLACEHOLDER);
                if (template === this._lastBoardHtml) {
                    // Nothing on the board changed: keep the page as it is instead of redrawing it
                    outputChannel.appendLine('[Board] No changes since the last refresh');
                    return;
                }
                // The person may have started dragging or editing while the data loaded
                if (!fullRefresh && this._uiBusy && this._lastBoardHtml !== undefined) {
                    this._refreshPendingWhileBusy = true;
                    return;
                }
                this._lastBoardHtml = template;
                this._panel.webview.html = template.split(NONCE_PLACEHOLDER).join(getNonce());

                // Restore filter state after HTML is loaded
                if (Object.keys(this._filterState).length > 0) {
                    // Small delay to ensure HTML is fully loaded before restoring state
                    setTimeout(() => {
                        this._panel.webview.postMessage({
                            command: 'restoreFilterState',
                            filterState: this._filterState
                        });
                    }, 100);
                }
            } catch (htmlError: any) {
                // Special handling for webview HTML errors
                outputChannel.appendLine(`[Board] Failed to set webview HTML: ${htmlError?.message || htmlError}`);
                outputChannel.appendLine(`[Board] Error code: ${htmlError?.code}`);
                outputChannel.appendLine(`[Board] Error errno: ${htmlError?.errno}`);

                // If it's a system error (like EAFNOSUPPORT -96), provide helpful message
                if (htmlError?.errno === -96 || htmlError?.code === 'EAFNOSUPPORT') {
                    throw new Error('System error -96 (EAFNOSUPPORT). This can happen when loading many items at once. The board has been loaded but rendering failed. Try refreshing the board.');
                }

                throw htmlError;
            }
        } catch (error: any) {
            log.error('Failed to load board:', error);
            outputChannel.appendLine(`[Board] Failed to load board: ${error.message || error}`);

            let message = 'Failed to Load Board';
            let details = '';
            let actionable = '';

            if (error.message?.includes('Team selection is required')) {
                message = 'Team Selection Required';
                details = 'Board view requires a team to be configured. This is needed to load board columns and work items from Azure DevOps.';
                actionable = 'Please close this panel and try opening the board again. You will be prompted to select a team.';
            } else if (error.message?.includes('Team configuration is missing')) {
                message = 'Team Configuration Missing';
                details = 'The team configuration was lost after selection. This might be a configuration issue.';
                actionable = 'Please run "Azure DevOps: Setup Connection Wizard" from the command palette to reconfigure your connection.';
            } else if (error.response?.status === 404) {
                message = 'Board Not Found';
                details = 'The requested board could not be found. It may have been deleted, renamed, or you may not have access to it.';
                actionable = 'Try selecting a different board from the Boards view, or verify your team permissions in Azure DevOps.';
            } else if (error.response?.status === 401 || error.response?.status === 403) {
                message = 'Authentication Error';
                details = 'Your session may have expired or you do not have permission to access this board.';
                actionable = 'Try reconnecting: Run "Azure DevOps: Connect" from the command palette (Cmd/Ctrl+Shift+P).';
            } else if (error.message?.includes('Not connected')) {
                message = 'Not Connected to Azure DevOps';
                details = 'You need to connect to Azure DevOps before viewing boards.';
                actionable = 'Run "Azure DevOps: Connect" from the command palette to sign in and configure your connection.';
            } else if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT') {
                message = 'Network Error';
                details = 'Unable to reach Azure DevOps. Please check your internet connection.';
                actionable = 'Verify you are connected to the internet and try again. If using a VPN, ensure it is properly configured.';
            } else {
                message = 'Failed to Load Board';
                details = error.message || 'An unexpected error occurred while loading the board.';
                actionable = 'Check the Output panel (View → Output → Azure DevOps) for more details, or try refreshing the board.';
            }

            this._panel.webview.html = this._getErrorHtml(message, details, actionable);
            this._lastBoardHtml = undefined;
        } finally {
            this._isLoading = false;
        }
    }

    /**
     * Ensure team is selected before loading board data
     * Returns true if team is available, false if user cancelled selection
     */
    private async _ensureTeamSelected(): Promise<boolean> {
        const config = this.authenticationManager.getConfig();

        if (!config) {
            return false;
        }

        // Check if team is missing or empty string
        if (!config.defaultTeam || config.defaultTeam.trim() === '') {
            outputChannel.appendLine('[Board] Team not configured, prompting user to select team...');

            const session = await this.authenticationManager.getSession();
            if (!session) {
                vscode.window.showErrorMessage('Please sign in to Azure DevOps first.');
                return false;
            }

            try {
                // Get available teams for the project using direct API call
                const axios = require('axios');
                const teamsUrl = `${config.organizationUrl}/_apis/projects/${encodeURIComponent(config.defaultProject || '')}/teams`;

                const teamsResponse = await axios.get(teamsUrl, {
                    headers: { Authorization: this.authenticationManager.getAuthorizationHeader(session.accessToken) },
                    params: { 'api-version': '7.1-preview.3' }
                });

                const teams = teamsResponse.data.value || [];

                if (teams.length === 0) {
                    vscode.window.showWarningMessage(
                        'No teams found in this project. Board view requires a team to be configured.'
                    );
                    return false;
                }

                // Prompt user to select team
                interface TeamQuickPickItem extends vscode.QuickPickItem {
                    team: { name: string; id: string; url: string };
                }

                const teamItems: TeamQuickPickItem[] = teams.map((team: any) => ({
                    label: `$(people) ${team.name}`,
                    description: team.url,
                    team: team
                }));

                const selectedItem = await vscode.window.showQuickPick<TeamQuickPickItem>(teamItems, {
                    title: 'Select Team for Board View',
                    placeHolder: 'Choose a team to load board data...',
                    canPickMany: false
                });

                if (selectedItem) {
                    const selectedTeam = selectedItem.team;

                    // Save team to VS Code configuration
                    await vscode.workspace.getConfiguration('azureDevOps')
                        .update('defaultTeam', selectedTeam.name, vscode.ConfigurationTarget.Global);

                    // Update auth manager config
                    this.authenticationManager.setConfig({
                        ...config,
                        defaultTeam: selectedTeam.name
                    });

                    outputChannel.appendLine(`[Board] Team selected: ${selectedTeam.name}`);
                    notifySuccess(`Team selected: ${selectedTeam.name}`);
                    return true;
                } else {
                    outputChannel.appendLine('[Board] User cancelled team selection');
                    return false;
                }
            } catch (error) {
                log.error('Failed to select team:', error);
                outputChannel.appendLine(`[Board] Failed to select team: ${error}`);
                vscode.window.showErrorMessage('Failed to select team. Please try again.');
                return false;
            }
        }

        return true;
    }

    private async _loadBoardData(): Promise<void> {
        const axiosInstance = this.authenticationManager.getAxiosInstance();
        let config = this.authenticationManager.getConfig();

        if (!axiosInstance || !config?.defaultProject) {
            throw new Error('Not connected to Azure DevOps');
        }

        // Ensure team is selected before proceeding
        const teamSelected = await this._ensureTeamSelected();
        if (!teamSelected) {
            throw new Error('Team selection is required for board view. Please select a team and try again.');
        }

        // Reload config after potential team selection
        config = this.authenticationManager.getConfig();

        if (!config?.defaultTeam) {
            throw new Error('Team configuration is missing');
        }

        outputChannel.appendLine(`[Board] Loading board: ${this.boardName} (ID: ${this.boardId})`);
        outputChannel.appendLine(`[Board] Project: ${config.defaultProject}, Team: ${config.defaultTeam}`);
        outputChannel.appendLine(`[Board] ⚠️ VERIFY THIS IS YOUR CORRECT TEAM! ⚠️`);

        // Get the backlog work item types for this specific board
        // First, get the team's backlog configuration to map board names to work item types
        let allowedWorkItemTypes: string[] = [];

        try {
            // Get team settings which includes backlog configuration
            const backlogsResponse = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject || '')}/${encodeURIComponent(config.defaultTeam || '')}/_apis/work/backlogs`
            );

            const backlogs = backlogsResponse.data.value || [];
            // Find the backlog that matches this board's name
            const matchingBacklog = backlogs.find((b: any) =>
                b.name === this.boardName || b.id === this.boardId
            );

            if (matchingBacklog && matchingBacklog.workItemTypes) {
                // workItemTypes is an array of { name: "Epic" } objects
                allowedWorkItemTypes = matchingBacklog.workItemTypes.map((wit: any) => wit.name);
            }
        } catch (error) {
            log.error('Failed to load backlog configuration:', error);
            // Continue without filtering - will show all items
        }

        // Load board columns
        const columnsResponse = await axiosInstance.get(
            `/${encodeURIComponent(config.defaultProject || '')}/${encodeURIComponent(config.defaultTeam || '')}/_apis/work/boards/${this.boardId}/columns`
        );

        const columns: BoardColumn[] = (columnsResponse.data.value || []).map((col: any) => ({
            id: col.id || col.name,
            name: col.name,
            itemLimit: col.itemLimit || 0,
            stateMappings: col.stateMappings || {},
            isSplit: col.isSplit || false,
            description: col.description || '',
            columnType: col.columnType || 'inProgress'
        }));

        // DEBUG: Log all columns and their state mappings
        outputChannel.appendLine(`[Board] Loaded ${columns.length} columns:`);
        columns.forEach(col => {
            const states = Object.values(col.stateMappings);
            outputChannel.appendLine(`[Board]   - "${col.name}": states = [${states.join(', ')}]`);
        });

        // Load work items for the board using WIQL
        const workItemsMap = new Map<string, BoardWorkItem[]>();

        // Initialize empty arrays for each column
        for (const column of columns) {
            workItemsMap.set(column.name, []);
        }

        // Build work item type filter for WIQL
        let workItemTypeFilter = '';
        if (allowedWorkItemTypes.length > 0) {
            const typeConditions = allowedWorkItemTypes
                .map((t: string) => `[System.WorkItemType] = '${t.replace(/'/g, "''")}'`)
                .join(' OR ');
            workItemTypeFilter = `AND (${typeConditions})`;
        }

        // Query work items using smart strategy to avoid duplicates
        outputChannel.appendLine(`[Board] Loading columns...`);
        const loadStartTime = Date.now();

        // STRATEGY 1: Try Board Items API (same as browser) - gets specific work items on the board
        let allWorkItems: BoardWorkItem[] = [];
        try {
            allWorkItems = await this._queryBoardItems(columns, axiosInstance, config);
            if (allWorkItems.length > 0) {
                outputChannel.appendLine(`[Board] ✓ Using Board Items API (${allWorkItems.length} total items)`);

                // Distribute items to columns based on their column field
                for (const item of allWorkItems) {
                    const columnName = item.boardColumn || this._findColumnForWorkItem(item, columns) || 'Unknown';
                    if (!workItemsMap.has(columnName)) {
                        workItemsMap.set(columnName, []);
                    }
                    workItemsMap.get(columnName)!.push(item);
                }
            }
        } catch (error: any) {
            outputChannel.appendLine(`[Board] Board Items API failed: ${error?.message || error}`);
        }

        // STRATEGY 2: Try BoardColumn WIQL query
        if (allWorkItems.length === 0) {
            allWorkItems = await this._queryAllWorkItemsByBoardColumn(
                columns,
                workItemTypeFilter,
                axiosInstance,
                config
            );

            if (allWorkItems.length > 0) {
                // BoardColumn query worked - distribute items to columns
                outputChannel.appendLine(`[Board] ✓ Using System.BoardColumn query (${allWorkItems.length} total items)`);
                for (const item of allWorkItems) {
                    const columnName = item.boardColumn || 'Unknown';
                    if (!workItemsMap.has(columnName)) {
                        workItemsMap.set(columnName, []);
                    }
                    workItemsMap.get(columnName)!.push(item);
                }
            }
        }

        // STRATEGY 3: Fallback to state-based query
        if (allWorkItems.length === 0) {
            outputChannel.appendLine(`[Board] Using state-based distribution...`);

            const allWorkItemsByState = await this._queryAllWorkItemsByState(
                columns,
                workItemTypeFilter,
                axiosInstance,
                config
            );

            outputChannel.appendLine(`[Board] ✓ State-based query loaded ${allWorkItemsByState.length} work items, distributing to columns...`);

            // DEBUG: Log unique states found in work items
            const uniqueStates = new Set<string>();
            allWorkItemsByState.forEach(item => uniqueStates.add(item.state));
            outputChannel.appendLine(`[Board] Unique states in work items: [${Array.from(uniqueStates).join(', ')}]`);

            // Distribute items to columns based on state (each item goes to ONE column)
            for (const item of allWorkItemsByState) {
                const columnName = this._findColumnForWorkItem(item, columns);
                if (columnName) {
                    if (!workItemsMap.has(columnName)) {
                        workItemsMap.set(columnName, []);
                    }
                    workItemsMap.get(columnName)!.push(item);
                }
            }
        }

        // Log distribution
        for (const [columnName, items] of workItemsMap.entries()) {
            outputChannel.appendLine(`[Board] Column "${columnName}": ${items.length} items`);
        }

        outputChannel.appendLine(`[Board] Loaded ${columns.length} columns in ${Date.now() - loadStartTime}ms`);

        // Load child work items for parent work items
        try {
            await this._loadChildWorkItems(workItemsMap, axiosInstance);
        } catch (error) {
            outputChannel.appendLine(`[Board] Failed to load child work items: ${error}`);
            log.error('Failed to load child work items:', error);
        }

        this.currentBoard = {
            id: this.boardId,
            name: this.boardName,
            columns,
            workItems: workItemsMap
        };
    }

    /**
     * Query work items using Board Items API (same approach as browser)
     * This API returns the specific work items that are on the board
     */
    private async _queryBoardItems(
        columns: BoardColumn[],
        axiosInstance: any,
        config: any
    ): Promise<BoardWorkItem[]> {
        try {
            // Use the board items API to get work items on this board
            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/${encodeURIComponent(config.defaultTeam)}/_apis/work/boards/${this.boardId}/boarditems`,
                { params: { 'api-version': '7.1-preview.1' } }
            );

            outputChannel.appendLine(`[Board] Board Items API response structure: ${JSON.stringify(Object.keys(response.data), null, 2)}`);

            // The response contains work item references grouped by column
            const boardRows = response.data.workItemRelations || [];

            if (boardRows.length === 0) {
                outputChannel.appendLine('[Board] No work items found in board items API');
                return [];
            }

            // Collect all work item IDs from the board
            const workItemIds: number[] = [];
            for (const row of boardRows) {
                if (row.target?.id) {
                    workItemIds.push(row.target.id);
                }
            }

            if (workItemIds.length === 0) {
                outputChannel.appendLine('[Board] No work item IDs found in board response');
                return [];
            }

            outputChannel.appendLine(`[Board] Found ${workItemIds.length} work item IDs from board API`);

            // Fetch details for all work items
            const workItemIdsStr = workItemIds.join(',');
            const detailsResponse = await axiosInstance.get(`/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/workitems`, {
                params: {
                    'ids': workItemIdsStr,
                    'api-version': '7.1',
                    '$expand': 'relations'
                }
            });

            const workItems = detailsResponse.data.value || [];
            outputChannel.appendLine(`[Board] Fetched details for ${workItems.length} work items`);

            // Convert to BoardWorkItem format and store relations for child loading
            return workItems.map((item: any) => {
                const workItem: any = {
                    id: item.id,
                    title: item.fields['System.Title'] || '',
                    state: item.fields['System.State'] || '',
                    type: item.fields['System.WorkItemType'] || '',
                    assignedTo: item.fields['System.AssignedTo'],
                    priority: item.fields['Microsoft.VSTS.Common.Priority'],
                    tags: item.fields['System.Tags'],
                    areaPath: item.fields['System.AreaPath'],
                    iterationPath: item.fields['System.IterationPath'],
                    boardColumn: item.fields['System.BoardColumn'] || null,
                    effort: item.fields['Microsoft.VSTS.Scheduling.Effort'] || (item.fields as any)['Microsoft.VSTS.Scheduling.StoryPoints']
                };
                // Store relations temporarily for child work items loading
                if (item.relations && item.relations.length > 0) {
                    workItem._tempRelations = item.relations;
                    outputChannel.appendLine(`[Board] Stored ${item.relations.length} relations for work item #${item.id}`);
                }
                return workItem;
            });
        } catch (error: any) {
            outputChannel.appendLine(`[Board] Board Items API error: ${error?.message || error}`);
            if (error?.response?.status) {
                outputChannel.appendLine(`[Board] Status: ${error.response.status}`);
            }
            throw error;
        }
    }

    /**
     * Find the correct column for a work item based on its type and state
     * Each column has state mappings keyed by work item type
     */
    private _findColumnForWorkItem(item: BoardWorkItem, columns: BoardColumn[]): string | null {
        // DEBUG: Log first few items
        if (Math.random() < 0.05) { // Log 5% of items to avoid spam
            outputChannel.appendLine(`[Board] Finding column for item #${item.id} (${item.title.substring(0, 30)}...) type: "${item.type}", state: "${item.state}"`);
        }

        // Check each column's state mappings to find where this item belongs
        // State mappings are keyed by work item type, so we need to check BOTH type and state
        for (const column of columns) {
            // DEBUG: Log column state mappings for first check
            if (Math.random() < 0.02) {
                outputChannel.appendLine(`[Board]   Column "${column.name}" state mappings: ${JSON.stringify(column.stateMappings)}`);
            }

            // Check if this column has a mapping for this work item type AND the state matches
            if (column.stateMappings[item.type] === item.state) {
                if (Math.random() < 0.05) {
                    outputChannel.appendLine(`[Board]   ✓ Matched column: "${column.name}" (${item.type}: ${item.state})`);
                }
                return column.name;
            }
        }

        outputChannel.appendLine(`[Board]   ✗ No column found for type "${item.type}" with state "${item.state}" on item #${item.id}`);
        return null;
    }

    /**
     * Query ALL work items using BoardColumn (for all columns at once)
     */
    private async _queryAllWorkItemsByBoardColumn(
        columns: BoardColumn[],
        workItemTypeFilter: string,
        axiosInstance: any,
        config: any
    ): Promise<BoardWorkItem[]> {
        // Build area path filter
        let areaFilter = '';
        if (this._teamAreaPath) {
            areaFilter = `AND [System.AreaPath] UNDER '${this._teamAreaPath.replace(/'/g, "''")}'`;
        }

        // Build column filter - get items from ANY of these columns
        const columnNames = columns.map(c => `[System.BoardColumn] = '${c.name.replace(/'/g, "''")}'`).join(' OR ');

        const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],
                             [System.AssignedTo], [Microsoft.VSTS.Common.Priority], [System.Tags],
                             [System.AreaPath], [System.IterationPath], [System.BoardColumn]
                      FROM WorkItems
                      WHERE [System.TeamProject] = @project
                      AND (${columnNames})
                      ${areaFilter}
                      ${workItemTypeFilter}
                      ORDER BY [Microsoft.VSTS.Common.BacklogPriority]`;

        outputChannel.appendLine(`[Board] BoardColumn WIQL query:\n${wiql}`);

        try {
            const wiqlResponse = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/wiql`,
                { query: wiql },
                {
                    params: {
                        'api-version': '7.1'
                    }
                }
            );

            const workItemRefs = wiqlResponse.data.workItems || [];

            outputChannel.appendLine(`[Board] BoardColumn query returned ${workItemRefs.length} work item references`);

            if (workItemRefs.length === 0) {
                outputChannel.appendLine('[Board] BoardColumn query returned 0 items - System.BoardColumn field may not be available');
                return [];
            }

            return await this._fetchWorkItemDetails(workItemRefs, axiosInstance, columns[0]);
        } catch (error: any) {
            outputChannel.appendLine(`[Board] BoardColumn query failed: ${error?.message || error}`);
            if (error?.response?.data) {
                outputChannel.appendLine(`[Board] Error details: ${JSON.stringify(error.response.data)}`);
            }
            return [];
        }
    }

    /**
     * Query ALL work items using State (fallback when BoardColumn not available)
     * Now supports pagination with $top and $skip parameters
     */
    private async _queryAllWorkItemsByState(
        columns: BoardColumn[],
        workItemTypeFilter: string,
        axiosInstance: any,
        config: any
    ): Promise<BoardWorkItem[]> {
        // Build area path filter
        let areaFilter = '';
        if (this._teamAreaPath) {
            areaFilter = `AND [System.AreaPath] UNDER '${this._teamAreaPath.replace(/'/g, "''")}'`;
            outputChannel.appendLine(`[Board] Filtering by area path: ${this._teamAreaPath}`);
        }

        // NOTE: Not filtering by iteration in WIQL to avoid query complexity
        // With many team iterations (37+), the WIQL query becomes too large and fails with 400
        // The UI filter will handle iteration filtering client-side
        const iterationFilter = '';
        outputChannel.appendLine(`[Board] No iteration filter in WIQL (will filter client-side in UI)`);

        // Collect ALL states from ALL columns
        const allStates = new Set<string>();
        columns.forEach(column => {
            Object.values(column.stateMappings).forEach(state => allStates.add(state));
        });

        if (allStates.size === 0) {
            outputChannel.appendLine('[Board] No state mappings found in any column');
            return [];
        }

        // Build state filter
        const stateConditions = Array.from(allStates)
            .map(state => `[System.State] = '${state.replace(/'/g, "''")}'`)
            .join(' OR ');

        // NOTE: WIQL doesn't support TOP keyword - default limit is 20000 items
        const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],
                             [System.AssignedTo], [Microsoft.VSTS.Common.Priority], [System.Tags],
                             [System.AreaPath], [System.IterationPath]
                      FROM WorkItems
                      WHERE [System.TeamProject] = @project
                      AND (${stateConditions})
                      ${areaFilter}
                      ${iterationFilter}
                      ${workItemTypeFilter}
                      ORDER BY [Microsoft.VSTS.Common.BacklogPriority] DESC`;

        outputChannel.appendLine(`[Board] Full WIQL query:\n${wiql}`);

        try {
            const wiqlResponse = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/wiql`,
                { query: wiql },
                {
                    params: {
                        'api-version': '7.1'
                    }
                }
            );

            const workItemRefs = wiqlResponse.data.workItems || [];

            outputChannel.appendLine(`[Board] WIQL returned ${workItemRefs.length} work item references`);

            if (workItemRefs.length === 0) {
                return [];
            }

            // Fetch details for the work items
            const items = await this._fetchWorkItemDetails(workItemRefs, axiosInstance, columns[0]);

            return items;
        } catch (error: any) {
            outputChannel.appendLine(`[Board] WIQL query failed with error: ${error?.message}`);
            if (error?.response?.data) {
                outputChannel.appendLine(`[Board] Error details: ${JSON.stringify(error.response.data, null, 2)}`);
            }
            throw error;
        }
    }

    /**
     * Query work items using System.BoardColumn field
     */
    private async _queryByBoardColumn(
        column: BoardColumn,
        workItemTypeFilter: string,
        axiosInstance: any,
        config: any
    ): Promise<BoardWorkItem[]> {
        // Build area path filter - use team area if available (keep this one)
        let areaFilter = '';
        if (this._teamAreaPath) {
            areaFilter = `AND [System.AreaPath] UNDER '${this._teamAreaPath.replace(/'/g, "''")}'`;
            outputChannel.appendLine(`[Board] Filtering by team area: ${this._teamAreaPath}`);
        }

        // NOTE: NOT filtering by iteration in WIQL - we want all team iterations
        // The UI filter will handle current iteration selection

        const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],
                             [System.AssignedTo], [Microsoft.VSTS.Common.Priority], [System.Tags],
                             [System.AreaPath], [System.IterationPath]
                      FROM WorkItems
                      WHERE [System.TeamProject] = @project
                      AND [System.BoardColumn] = '${column.name.replace(/'/g, "''")}'
                      ${areaFilter}
                      ${workItemTypeFilter}
                      ORDER BY [Microsoft.VSTS.Common.BacklogPriority]`;

        const wiqlResponse = await axiosInstance.post(
            `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/wiql`,
            { query: wiql }
        );

        const workItemRefs = wiqlResponse.data.workItems || [];

        if (workItemRefs.length === 0) {
            return [];
        }

        return await this._fetchWorkItemDetails(workItemRefs, axiosInstance, column);
    }

    /**
     * Query work items using System.State field (fallback for when BoardColumn is unavailable)
     */
    private async _queryByStateMappings(
        column: BoardColumn,
        workItemTypeFilter: string,
        axiosInstance: any,
        config: any
    ): Promise<BoardWorkItem[]> {
        // Use column's stateMappings to query by state
        const states = Object.values(column.stateMappings);

        if (states.length === 0) {
            outputChannel.appendLine(`[Board] Column "${column.name}" has no state mappings, cannot query by state`);
            return [];
        }

        // Build state filter: [System.State] IN ('State1', 'State2', ...)
        const stateConditions = states
            .map(state => `[System.State] = '${state.replace(/'/g, "''")}'`)
            .join(' OR ');

        // Build area path filter - use team area if available
        let areaFilter = '';
        if (this._teamAreaPath) {
            areaFilter = `AND [System.AreaPath] UNDER '${this._teamAreaPath.replace(/'/g, "''")}'`;
        }

        const wiql = `SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType],
                             [System.AssignedTo], [Microsoft.VSTS.Common.Priority], [System.Tags],
                             [System.AreaPath], [System.IterationPath]
                      FROM WorkItems
                      WHERE [System.TeamProject] = @project
                      AND (${stateConditions})
                      ${areaFilter}
                      ${workItemTypeFilter}
                      ORDER BY [Microsoft.VSTS.Common.BacklogPriority]`;

        const wiqlResponse = await axiosInstance.post(
            `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/wiql`,
            { query: wiql }
        );

        const workItemRefs = wiqlResponse.data.workItems || [];

        if (workItemRefs.length === 0) {
            return [];
        }

        return await this._fetchWorkItemDetails(workItemRefs, axiosInstance, column);
    }

    /**
     * Fetch full work item details from work item references
     * Batches requests in chunks of 200 (Azure DevOps API limit)
     */
    private async _fetchWorkItemDetails(
        workItemRefs: any[],
        axiosInstance: any,
        column: BoardColumn
    ): Promise<BoardWorkItem[]> {
        if (workItemRefs.length === 0) {
            return [];
        }

        const startTime = Date.now();
        const ids = workItemRefs.map((ref: any) => Number(ref.id)).filter((id: number) => Number.isFinite(id));
        const items = await azureDevOps().getWorkItems(ids, { expand: 'relations' });
        const workItems = items.map((item: any) => {
            const fields = item.fields || {};
            const workItem: any = {
                id: item.id,
                title: fields['System.Title'],
                state: fields['System.State'],
                type: fields['System.WorkItemType'],
                assignedTo: fields['System.AssignedTo'],
                priority: fields['Microsoft.VSTS.Common.Priority'],
                tags: fields['System.Tags'],
                areaPath: fields['System.AreaPath'],
                iterationPath: fields['System.IterationPath'],
                boardColumn: fields['System.BoardColumn'] || column.name,
                effort: fields['Microsoft.VSTS.Scheduling.Effort'] || fields['Microsoft.VSTS.Scheduling.StoryPoints']
            };
            // Kept for loading child work items, then removed
            if (item.relations && item.relations.length > 0) {
                workItem._tempRelations = item.relations;
            }
            return workItem as BoardWorkItem;
        });
        log.debug(`[Board] Loaded ${workItems.length} of ${ids.length} work items in ${Date.now() - startTime}ms`);
        return workItems;
    }

    private async _loadChildWorkItems(workItemsMap: Map<string, BoardWorkItem[]>, _axiosInstance?: unknown): Promise<void> {
        const allWorkItems = [...workItemsMap.values()].flat();
        try {
            // Child ids from each card's parent-to-child links
            const parentToChildIds = new Map<number, number[]>();
            for (const workItem of allWorkItems) {
                const relations: any[] = (workItem as any)._tempRelations || [];
                const childIds = relations
                    .filter(rel => rel?.rel === 'System.LinkTypes.Hierarchy-Forward' && rel.url)
                    .map(rel => Number(extractWorkItemIdFromUrl(rel.url)))
                    .filter(id => Number.isFinite(id) && id > 0);
                if (childIds.length > 0) {
                    parentToChildIds.set(workItem.id, childIds);
                }
            }
            const allChildIds = [...new Set([...parentToChildIds.values()].flat())];
            if (allChildIds.length === 0) {
                return;
            }

            // Without a configured project this falls back to the organization-wide endpoint
            const children = await azureDevOps().getWorkItems(allChildIds, {
                fields: ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo']
            });
            const childById = new Map<number, any>();
            for (const child of children) {
                const fields = (child as any).fields || {};
                const assignedTo = fields['System.AssignedTo'];
                childById.set(child.id, {
                    id: child.id,
                    title: fields['System.Title'],
                    state: fields['System.State'],
                    type: fields['System.WorkItemType'],
                    assignedTo: assignedTo ? {
                        displayName: assignedTo.displayName || assignedTo,
                        uniqueName: assignedTo.uniqueName || ''
                    } : null
                });
            }
            for (const workItem of allWorkItems) {
                const childIds = parentToChildIds.get(workItem.id);
                if (childIds) {
                    workItem.children = childIds.map(id => childById.get(id)).filter(child => child !== undefined);
                }
            }
            log.debug(`[Board] Loaded ${children.length} child work items for ${parentToChildIds.size} cards`);
        } catch (error) {
            log.error('[Board] Failed to load child work items:', error);
        } finally {
            for (const workItem of allWorkItems) {
                delete (workItem as any)._tempRelations;
            }
        }
    }

    private async _moveWorkItem(workItemId: number, targetColumn: string, targetState: string): Promise<void> {
        // Track this move as pending to prevent race conditions with refresh
        this._pendingMoves.add(workItemId);

        outputChannel.appendLine(`[Board] Moving work item #${workItemId} to column "${targetColumn}" with state "${targetState}"`);

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();
            if (!axiosInstance || !config) {
                throw new Error('Not connected');
            }

            // Update work item state
            const url = `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/workitems/${workItemId}`;
            outputChannel.appendLine(`[Board] PATCH URL: ${url}`);
            outputChannel.appendLine(`[Board] Setting state to: ${targetState}`);

            await axiosInstance.patch(
                url,
                [
                    { op: 'replace', path: '/fields/System.State', value: targetState }
                ],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            outputChannel.appendLine(`[Board] ✓ Successfully moved work item #${workItemId}`);

            // Broadcast state change to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'state-change',
                changes: [{ field: '/fields/System.State', newValue: targetState }]
            });

            // Send success message to webview (no full refresh needed - card already moved visually)
            this._panel.webview.postMessage({
                command: 'moveSuccess',
                workItemId,
                targetState
            });

            notifySuccess(`Moved #${workItemId} to ${targetColumn}`);

            // Remove from pending moves after a short delay to ensure backend has propagated
            setTimeout(() => {
                this._pendingMoves.delete(workItemId);
            }, 1000);

        } catch (error: any) {
            // Remove from pending moves immediately on error
            this._pendingMoves.delete(workItemId);

            outputChannel.appendLine(`[Board] ✗ Failed to move work item #${workItemId}`);
            outputChannel.appendLine(`[Board] Error: ${error?.message || error}`);
            if (error?.response?.status) {
                outputChannel.appendLine(`[Board] HTTP Status: ${error.response.status}`);
            }
            if (error?.response?.data) {
                outputChannel.appendLine(`[Board] Error details: ${JSON.stringify(error.response.data, null, 2)}`);
            }

            // Send failure message to webview for rollback
            this._panel.webview.postMessage({
                command: 'moveFailed',
                workItemId,
                message: error?.message || 'Failed to move work item'
            });

            vscode.window.showErrorMessage(`Failed to move work item: ${error?.message || error}`);
        }
    }

    private async _createWorkItem(columnName: string, title: string, workItemType?: string): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            // Find the state for this column
            const column = this.currentBoard?.columns.find(c => c.name === columnName);
            const stateMappings = column?.stateMappings || {};
            const state = Object.values(stateMappings)[0] || 'New';

            // Use provided type, or derive from board name, or fall back to config default
            const type = workItemType || this._getDefaultWorkItemType();

            const response = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workitems/$${encodeURIComponent(type)}`,
                [
                    { op: 'add', path: '/fields/System.Title', value: title },
                    { op: 'add', path: '/fields/System.State', value: state }
                ],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast work item creation to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId: response.data.id,
                updateType: 'create',
                changes: [
                    { field: '/fields/System.Title', newValue: title },
                    { field: '/fields/System.State', newValue: state }
                ]
            });

            notifySuccess(`Created ${type} #${response.data.id}`);

            // Refresh the board
            await this._loadAndRender();

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create work item: ${error?.message || error}`);
        }
    }

    private async _assignToMe(workItemId: number): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();
            if (!axiosInstance || !config) {
                throw new Error('Not connected');
            }

            const currentUser = await this.authenticationManager.getCurrentUser();
            if (!currentUser?.uniqueName) {
                throw new Error('Could not get current user');
            }

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/workitems/${workItemId}`,
                [{ op: 'replace', path: '/fields/System.AssignedTo', value: currentUser.uniqueName }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast assignment to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'assign',
                changes: [{ field: '/fields/System.AssignedTo', newValue: currentUser.uniqueName }]
            });

            // The page has no in-place update for this, and the card may change column:
            // reload the board (it keeps scroll, filters and collapsed columns)
            await this._loadAndRender();

            notifySuccess(`Assigned #${workItemId} to you`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to assign: ${error?.message || error}`);
        }
    }

    private _openBoardInBrowser(): void {
        const config = this.authenticationManager.getConfig();
        if (config) {
            const url = `${config.organizationUrl}/${config.defaultProject}/_boards/board/t/${config.defaultTeam}/${this.boardName}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }
    }

    private _openWorkItemInBrowser(workItemId: number): void {
        const config = this.authenticationManager.getConfig();
        if (config) {
            const url = `${config.organizationUrl}/${config.defaultProject}/_workitems/edit/${workItemId}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }
    }

    private async _copyWorkItemUrl(workItemId: number): Promise<void> {
        const config = this.authenticationManager.getConfig();
        if (config) {
            const url = `${config.organizationUrl}/${config.defaultProject}/_workitems/edit/${workItemId}`;
            await vscode.env.clipboard.writeText(url);
            notifySuccess('Work item URL copied to clipboard');
        }
    }

    private async _changeState(workItemId: number, newState: string): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();
            if (!axiosInstance || !config) {
                throw new Error('Not connected');
            }

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/workitems/${workItemId}`,
                [{ op: 'replace', path: '/fields/System.State', value: newState }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast state change to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'state-change',
                changes: [{ field: '/fields/System.State', newValue: newState }]
            });

            // The page has no in-place update for this, and the card may change column:
            // reload the board (it keeps scroll, filters and collapsed columns)
            await this._loadAndRender();

            notifySuccess(`Changed #${workItemId} state to ${newState}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to change state: ${error?.message || error}`);
        }
    }

    private async _addComment(workItemId: number): Promise<void> {
        const comment = await vscode.window.showInputBox({
            prompt: `Add comment to work item #${workItemId}`,
            placeHolder: 'Enter your comment...',
            validateInput: (value) => value?.trim() ? null : 'Comment cannot be empty'
        });

        if (!comment) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${workItemId}/comments`,
                { text: comment },
                { params: { 'api-version': '7.1-preview.3' } }
            );

            notifySuccess(`Comment added to #${workItemId}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to add comment: ${error?.message || error}`);
        }
    }

    private async _updateWorkItemTitle(workItemId: number, title: string): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${workItemId}`,
                [
                    {
                        op: 'replace',
                        path: '/fields/System.Title',
                        value: title
                    }
                ],
                {
                    params: { 'api-version': '7.1' },
                    headers: { 'Content-Type': 'application/json-patch+json' }
                }
            );

            // No need for full refresh - webview already updated the title
            notifySuccess(`Updated title for #${workItemId}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to update title: ${error?.message || error}`);
        }
    }

    private async _updateWorkItemEffort(workItemId: number, effort: number | null): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            const fieldName = 'Microsoft.VSTS.Scheduling.Effort';
            const patchOp = effort !== null
                ? { op: 'replace', path: `/fields/${fieldName}`, value: effort }
                : { op: 'remove', path: `/fields/${fieldName}` };

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${workItemId}`,
                [patchOp],
                {
                    params: { 'api-version': '7.1' },
                    headers: { 'Content-Type': 'application/json-patch+json' }
                }
            );

            // No need for full refresh - webview already updated the effort
            notifySuccess(`Updated effort for #${workItemId}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to update effort: ${error?.message || error}`);
        }
    }

    private async _changeAssignee(workItemId: number): Promise<void> {
        const teamMembers = await this._getTeamMembers();

        const items = [
            { label: 'Unassigned', description: 'Remove assignee', uniqueName: '' },
            ...teamMembers.map(m => ({
                label: m.displayName,
                description: m.uniqueName,
                uniqueName: m.uniqueName
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select assignee'
        });

        if (!selected) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            const patchOp = selected.uniqueName
                ? { op: 'replace', path: '/fields/System.AssignedTo', value: selected.uniqueName }
                : { op: 'remove', path: '/fields/System.AssignedTo' };

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${workItemId}`,
                [patchOp],
                {
                    params: { 'api-version': '7.1' },
                    headers: { 'Content-Type': 'application/json-patch+json' }
                }
            );

            // Broadcast assignment to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'assign',
                changes: [{ field: '/fields/System.AssignedTo', newValue: selected.uniqueName }]
            });

            // The page has no in-place update for this, and the card may change column:
            // reload the board (it keeps scroll, filters and collapsed columns)
            await this._loadAndRender();

            notifySuccess(`Updated assignee for #${workItemId}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to update assignee: ${error?.message || error}`);
        }
    }

    private async _confirmDeleteWorkItem(workItemId: number): Promise<void> {
        const answer = await vscode.window.showWarningMessage(
            `Are you sure you want to delete work item #${workItemId}?`,
            { modal: true },
            'Delete',
            'Cancel'
        );

        if (answer === 'Delete') {
            await this._deleteWorkItem(workItemId);
        }
    }

    private async _deleteWorkItem(workItemId: number): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            await axiosInstance.delete(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${workItemId}`,
                {
                    params: { 'api-version': '7.1' }
                }
            );

            // Broadcast deletion to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'delete'
            });

            await this._loadAndRender();
            notifySuccess(`Deleted work item #${workItemId}`);

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to delete work item: ${error?.message || error}`);
        }
    }

    private async _addChildWorkItem(parentWorkItemId: number, workItemType: string): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            // Ask for the title
            const title = await vscode.window.showInputBox({
                prompt: `Enter title for new ${workItemType}`,
                placeHolder: 'Work item title'
            });

            if (!title) {
                return; // User cancelled
            }

            // Create the work item
            const response = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workitems/$${encodeURIComponent(workItemType)}`,
                [
                    { op: 'add', path: '/fields/System.Title', value: title },
                    { op: 'add', path: '/fields/System.State', value: 'To Do' }
                ],
                {
                    headers: { 'Content-Type': 'application/json-patch+json' },
                    params: { 'api-version': '7.1' }
                }
            );

            const newWorkItemId = response.data.id;

            // Add parent-child relationship
            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workitems/${newWorkItemId}`,
                [
                    {
                        op: 'add',
                        path: '/relations/-',
                        value: {
                            rel: 'System.LinkTypes.Hierarchy-Reverse',
                            url: `${axiosInstance.defaults.baseURL}/_apis/wit/workitems/${parentWorkItemId}`,
                            attributes: {
                                comment: 'Child work item'
                            }
                        }
                    }
                ],
                {
                    headers: { 'Content-Type': 'application/json-patch+json' },
                    params: { 'api-version': '7.1' }
                }
            );

            notifySuccess(`Created ${workItemType} #${newWorkItemId} as child of #${parentWorkItemId}`);

            // Refresh the board
            await this._loadAndRender();

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create child work item: ${error?.message || error}`);
        }
    }

    private async _updateChildWorkItemState(workItemId: number, state: string): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                throw new Error('Not connected');
            }

            // Update the work item state
            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workitems/${workItemId}`,
                [
                    { op: 'add', path: '/fields/System.State', value: state }
                ],
                {
                    headers: { 'Content-Type': 'application/json-patch+json' },
                    params: { 'api-version': '7.1' }
                }
            );

            outputChannel.appendLine(`[Board] Updated work item #${workItemId} state to ${state}`);

            // Refresh the board to reflect the changes
            await this._loadAndRender();

        } catch (error: any) {
            outputChannel.appendLine(`[Board] Failed to update work item state: ${error?.message || error}`);
            vscode.window.showErrorMessage(`Failed to update work item state: ${error?.message || error}`);
        }
    }

    private async _showMoveToColumnPicker(workItemId: number): Promise<void> {
        if (!this.currentBoard) return;

        // Get available columns and their states
        const columnItems = this.currentBoard.columns.map(col => {
            const states = Object.values(col.stateMappings);
            return {
                label: col.name,
                description: states.join(', '),
                column: col
            };
        });

        const selected = await vscode.window.showQuickPick(columnItems, {
            placeHolder: 'Select target column'
        });

        if (!selected) return;

        // Get the first state in the column's state mappings
        const targetState = Object.values(selected.column.stateMappings)[0];
        if (targetState) {
            await this._moveWorkItem(workItemId, selected.column.name, targetState);
        }
    }

    private async _showMoveToIterationPicker(workItemId: number): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject || !config?.defaultTeam) {
                throw new Error('Not connected or team not configured');
            }

            // Get iterations for the team
            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/${encodeURIComponent(config.defaultTeam)}/_apis/work/teamsettings/iterations`,
                { params: { 'api-version': '7.1-preview.1' } }
            );

            const iterations = response.data.value || [];
            if (iterations.length === 0) {
                vscode.window.showInformationMessage('No iterations found');
                return;
            }

            interface IterationItem extends vscode.QuickPickItem {
                iterationPath: string;
            }

            const items: IterationItem[] = iterations.map((iteration: any) => ({
                label: iteration.name,
                description: iteration.path,
                iterationPath: iteration.path
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select target iteration'
            });

            if (!selected) return;

            // Update the work item's iteration path
            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject || '')}/_apis/wit/workitems/${workItemId}`,
                [{ op: 'replace', path: '/fields/System.IterationPath', value: selected.iterationPath }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast update to all views
            this.eventManager.notifyWorkItemUpdated({
                source: BoardPanel.EVENT_SOURCE,
                workItemId,
                updateType: 'update',
                changes: [{ field: '/fields/System.IterationPath', newValue: selected.iterationPath }]
            });

            notifySuccess(`Moved #${workItemId} to ${selected.label}`);
            await this._loadAndRender();

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to move to iteration: ${error?.message || error}`);
        }
    }

    private async _getTeamMembers(): Promise<Array<{displayName: string, uniqueName: string}>> {
        try {
            return await azureDevOps().getTeamMembers();
        } catch (error) {
            log.error('[Board] Failed to load team members:', error);
            return [];
        }
    }

    /** All of the team's iterations (past, current and future). */
    private async _getAllTeamIterations(): Promise<Array<{name: string, path: string, timeFrame: string}>> {
        try {
            return await azureDevOps().getTeamIterations();
        } catch (error) {
            log.error('[Board] Failed to load team iterations:', error);
            return [];
        }
    }

    private async _getCurrentIteration(): Promise<string | null> {
        try {
            return await azureDevOps().getCurrentIterationPath();
        } catch (error) {
            log.error('[Board] Failed to load the current iteration:', error);
            return null;
        }
    }

    private async _getTeamAreaPath(): Promise<string | null> {
        try {
            return await azureDevOps().getTeamAreaPath();
        } catch (error) {
            log.error('[Board] Failed to load the team area path:', error);
            return null;
        }
    }

    private async _switchBoard(boardId: string, boardName: string): Promise<void> {
        this.boardId = boardId;
        this.boardName = boardName;
        this._panel.title = `Board: ${boardName}`;
        await this._loadAndRender(true); // Full refresh when switching boards
    }

    private async _getAvailableBoards(): Promise<Array<{id: string, name: string}>> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject || !config?.defaultTeam) {
                return [];
            }

            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/${encodeURIComponent(config.defaultTeam)}/_apis/work/boards`
            );

            return (response.data.value || []).map((b: any) => ({
                id: b.id,
                name: b.name
            }));
        } catch (error) {
            return [];
        }
    }

    private async _getTagColors(): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject || !config?.defaultTeam) {
                return;
            }

            // Clear existing colors and rules
            this._tagColors.clear();
            this._cardStyleRules = [];

            // Fetch tag colors and card styling rules from card rule settings API
            try {
                const ruleResponse = await axiosInstance.get(
                    `/${encodeURIComponent(config.defaultProject)}/${encodeURIComponent(config.defaultTeam)}/_apis/work/boards/${encodeURIComponent(this.boardId)}/cardrulesettings`,
                    {
                        params: {
                            'api-version': '7.1'
                        }
                    }
                );

                // Check for tag colors and card styling rules
                if (ruleResponse.data && ruleResponse.data.rules) {
                    const rules = ruleResponse.data.rules;

                    // Look for tagStyle in rules - it's an array of tag style objects
                    if (rules.tagStyle && Array.isArray(rules.tagStyle)) {
                        rules.tagStyle.forEach((tagStyle: any) => {
                            // Each tagStyle has: name, isEnabled, settings { "background-color": "#HEX" }
                            if (tagStyle.name && tagStyle.settings && tagStyle.settings['background-color']) {
                                const tagName = tagStyle.name;
                                const tagColor = tagStyle.settings['background-color'];
                                this._tagColors.set(tagName.toLowerCase(), tagColor);
                            }
                        });
                    }

                    // Look for fill (card background) styling rules
                    if (rules.fill && Array.isArray(rules.fill)) {
                        rules.fill.forEach((fillRule: any) => {
                            // Each fillRule has: name, isEnabled, filter, settings { "background-color": "#HEX" }
                            if (fillRule.isEnabled && fillRule.filter && fillRule.settings && fillRule.settings['background-color']) {
                                this._cardStyleRules.push({
                                    name: fillRule.name,
                                    filter: fillRule.filter,
                                    settings: fillRule.settings
                                });
                            }
                        });
                    }
                }
            } catch (error) {
                // Silently fail if card rule settings are not available
                log.error('Failed to fetch card rule settings:', error);
            }
        } catch (error) {
            log.error('Failed to fetch tag colors:', error);
        }
    }

    private _hasIconForWorkItemType(type: string): boolean {
        // List of work item types we have icons for
        const supportedTypes = [
            'User Story',
            'Product Backlog Item',
            'Requirement',
            'Feature',
            'Epic',
            'Task',
            'Issue',
            'Bug',
            'Test Case'
        ];
        return supportedTypes.includes(type);
    }

    private async _fetchProjectWorkItemTypes(): Promise<void> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                return;
            }

            // Fetch all work item types from the project
            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workitemtypes`,
                {
                    params: {
                        'api-version': '7.1'
                    }
                }
            );

            if (response.data && response.data.value) {
                // Extract work item type names, filter to only supported types with icons, and sort
                this._projectWorkItemTypes = response.data.value
                    .map((wit: any) => wit.name)
                    .filter((name: string) => name && this._hasIconForWorkItemType(name))
                    .sort();
            }

            // If no supported types found, use fallback
            if (this._projectWorkItemTypes.length === 0) {
                this._projectWorkItemTypes = ['User Story', 'Bug', 'Task', 'Issue', 'Feature', 'Epic'];
            }
        } catch (error) {
            log.error('Failed to fetch project work item types:', error);
            // Fallback to common types if API fails
            this._projectWorkItemTypes = ['User Story', 'Bug', 'Task', 'Issue', 'Feature', 'Epic'];
        }
    }

    private _getLoadingHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(this._panel.webview, getNonce())}">
    <title>Loading Board...</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
        }
        .loader {
            text-align: center;
        }
        .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid var(--vscode-input-border);
            border-top-color: var(--vscode-focusBorder);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin: 0 auto 16px;
        }
        @keyframes spin {
            to { transform: rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="loader">
        <div class="spinner"></div>
        <p>Loading board...</p>
    </div>
</body>
</html>`;
    }

    private _getErrorHtml(message: string, details?: string, actionable?: string): string {
        const detailsHtml = details ? `<p class="error-details">${this._escapeHtml(details)}</p>` : '';
        const actionableHtml = actionable ? `<div class="error-actionable">${this._escapeHtml(actionable)}</div>` : '';
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(this._panel.webview, nonce)}">
    <title>Board Error</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            padding: 20px;
        }
        .error {
            text-align: center;
            padding: 30px;
            max-width: 600px;
        }
        .error-icon {
            font-size: 48px;
            margin-bottom: 16px;
        }
        .error-message {
            font-size: 18px;
            font-weight: bold;
            margin-bottom: 12px;
            color: var(--vscode-errorForeground);
        }
        .error-details {
            font-size: 14px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 16px;
            line-height: 1.5;
        }
        .error-actionable {
            font-size: 14px;
            background: var(--vscode-textBlockQuote-background);
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            padding: 16px;
            margin: 20px 0;
            text-align: left;
            border-radius: 4px;
            line-height: 1.6;
        }
        .error-actionable strong {
            display: block;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        button {
            margin-top: 16px;
            padding: 10px 20px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
        }
        button:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">⚠️</div>
        <p class="error-message">${this._escapeHtml(message)}</p>
        ${detailsHtml}
        ${actionableHtml}
        <button id="retry">Retry</button>
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('retry').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    </script>
</body>
</html>`;
    }

    private _getHtmlForWebview(nonce: string = getNonce()): string {
        if (!this.currentBoard) {
            return this._getErrorHtml('No board data available');
        }

        const columns = this.currentBoard.columns;
        const workItems = this.currentBoard.workItems;

        // Extract unique types from work items on the board
        const uniqueTypes = new Set<string>();
        workItems.forEach((items) => {
            items.forEach(item => {
                if (item.type) {
                    uniqueTypes.add(item.type);
                }
            });
        });
        const boardTypes = Array.from(uniqueTypes).sort();

        // Extract unique priorities from work items on the board
        const uniquePriorities = new Set<number>();
        workItems.forEach((items) => {
            items.forEach(item => {
                if (item.priority !== undefined && item.priority !== null) {
                    uniquePriorities.add(item.priority);
                }
            });
        });
        const boardPriorities = Array.from(uniquePriorities).sort((a, b) => a - b);

        // Priority labels mapping
        const priorityLabels: Record<number, string> = {
            1: '1 - Critical',
            2: '2 - High',
            3: '3 - Medium',
            4: '4 - Low'
        };

        // Extract unique states from work items on the board
        const uniqueStates = new Set<string>();
        workItems.forEach((items) => {
            items.forEach(item => {
                if (item.state) {
                    uniqueStates.add(item.state);
                }
            });
        });
        const boardStates = Array.from(uniqueStates).sort();

        // Extract unique areas from work items on the board
        const uniqueAreas = new Set<string>();
        workItems.forEach((items) => {
            items.forEach(item => {
                if (item.areaPath) {
                    uniqueAreas.add(item.areaPath);
                }
            });
        });
        const boardAreas = Array.from(uniqueAreas).sort();

        // Extract unique assignees from work items on the board
        const uniqueAssignees = new Set<string>();
        workItems.forEach((items) => {
            items.forEach(item => {
                if (item.assignedTo?.uniqueName) {
                    uniqueAssignees.add(item.assignedTo.uniqueName);
                }
            });
        });

        // Filter team members to only include those who have work items on the board
        const teamMembersWithWorkItems = this._teamMembers.filter(member =>
            uniqueAssignees.has(member.uniqueName)
        );
        outputChannel.appendLine(`[Board] Filtered team members: ${teamMembersWithWorkItems.length} of ${this._teamMembers.length} have work items on board`);

        // Use ALL team iterations from API instead of just those in loaded work items
        // This ensures FY26 and future iterations appear in the filter dropdown
        const boardIterations = this._teamIterations.map(iter => iter.path).sort();
        outputChannel.appendLine(`[Board] Using ${boardIterations.length} team iterations for filter dropdown`);

        // Derive default work item type from board name
        const defaultWorkItemType = this._getDefaultWorkItemType();

        // Use project work item types fetched from Azure DevOps API
        // Combine with board types to ensure all types on current board are included
        const allWorkItemTypes = Array.from(new Set([...boardTypes, ...this._projectWorkItemTypes])).sort();

        // Get the codicon font URI from VSCode
        const codiconFontUri = vendorAssetUri(this._panel.webview, this._extensionUri, 'codicons', 'codicon.ttf');

        // Styles and script live in media/board; data for the script goes in #board-data
        const mediaUri = (...segments: string[]) =>
            this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', ...segments));
        const boardCssUri = mediaUri('board', 'board.css');
        const boardJsUri = mediaUri('board', 'board.js');
        const handlersJsUri = mediaUri('shared', 'webviewHandlers.js');
        const boardData = {
            availableBoards: this.availableBoards,
            currentIterationPath: this._currentIterationPath || '',
            boardKey: this.boardId,
            boardName: this.boardName
        };

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(this._panel.webview, nonce)}">
    <title>Board: ${this._escapeHtml(this.boardName)}</title>
    <style>
        @font-face {
            font-family: 'codicon';
            font-display: block;
            src: url('${codiconFontUri}') format('truetype');
        }
    </style>
    <link rel="stylesheet" href="${boardCssUri}">
</head>
<body>
    <div class="board-header">
        <div class="board-title">
            <div class="board-selector">
                <button class="board-selector-btn" data-click="toggleBoardDropdown" aria-haspopup="listbox" aria-label="Board: ${this._escapeHtml(this.boardName)}. Switch board">
                    <span class="board-icon">${this._getBoardIcon(this.boardName)}</span>
                    <span class="board-name">${this._escapeHtml(this.boardName)}</span>
                </button>
                <div class="board-dropdown" id="boardDropdown" role="listbox" aria-label="Boards">
                    ${this.availableBoards.map(board => `
                        <div class="board-dropdown-item ${board.id === this.boardId ? 'active' : ''}"
                             role="option" tabindex="0" aria-selected="${board.id === this.boardId}"
                             data-click="switchBoard" data-click-args='[${jsArg(board.id)}, ${jsArg(board.name)}]'>
                            <span class="board-icon">${this._getBoardIcon(board.name)}</span>
                            <span class="board-name">${this._escapeHtml(board.name)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        </div>
        <div class="board-actions">
            <button class="btn icon-btn" data-click="toggleFilterBar" title="Toggle filters (F)" aria-label="Toggle filters" id="filterToggleBtn">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 10.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7a.5.5 0 0 1-.5-.5zm-2-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/></svg>
            </button>
            <button class="btn icon-btn" data-click="refresh" title="Refresh (R)" aria-label="Refresh">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/><path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/></svg>
            </button>
            <button class="btn icon-btn" data-click="openInBrowser" title="Open in browser" aria-label="Open in browser">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/><path fill-rule="evenodd" d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/></svg>
            </button>
            <button class="btn icon-btn" data-click="toggleKeyboardHelp" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" aria-controls="keyboardHelp">?</button>
        </div>
    </div>

    <!-- Filter Bar -->
    <div class="filter-bar" id="filterBar">
        <div class="filter-search">
            <input type="text"
                   class="filter-search-input"
                   id="searchInput"
                   placeholder="Search by ID or title..."
                   data-input="applyFilters"
                   data-keydown="handleSearchKeydown" data-keydown-args='[{"$ref": "event"}, {"$ref": "el"}]'>
            <button class="filter-search-clear" data-click="clearSearch" aria-label="Clear search">×</button>
        </div>

        <div class="filter-divider"></div>

        <div class="filter-dropdown" id="assigneeDropdown">
            <button class="filter-dropdown-btn" id="assigneeDropdownBtn" data-click="toggleDropdown" data-click-args='["assigneeDropdownContent"]'>Assigned to</button>
            <div class="filter-dropdown-content" id="assigneeDropdownContent">
                <label class="filter-checkbox-item"><input type="checkbox" name="assignee" value="me" data-change="handleFilterChange" data-change-args='["assignee", {"$ref": "el"}]'> @Me</label>
                <label class="filter-checkbox-item"><input type="checkbox" name="assignee" value="unassigned" data-change="handleFilterChange" data-change-args='["assignee", {"$ref": "el"}]'> Unassigned</label>
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                ${teamMembersWithWorkItems.map(m => `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="assignee" value="${this._escapeHtml(m.uniqueName)}" data-change="handleFilterChange" data-change-args='["assignee", {"$ref": "el"}]'>
                        ${this._escapeHtml(m.displayName)}
                    </label>
                `).join('')}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="assigneeClearBtn" data-click="clearFilter" data-click-args='["assignee"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-dropdown" id="typeDropdown">
            <button class="filter-dropdown-btn" id="typeDropdownBtn" data-click="toggleDropdown" data-click-args='["typeDropdownContent"]'>Type</button>
            <div class="filter-dropdown-content" id="typeDropdownContent">
                ${boardTypes.map(type => `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="type" value="${this._escapeHtml(type)}" data-change="handleFilterChange" data-change-args='["type", {"$ref": "el"}]'>
                        ${this._escapeHtml(type)}
                    </label>
                `).join('')}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="typeClearBtn" data-click="clearFilter" data-click-args='["type"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-dropdown" id="priorityDropdown">
            <button class="filter-dropdown-btn" id="priorityDropdownBtn" data-click="toggleDropdown" data-click-args='["priorityDropdownContent"]'>Priority</button>
            <div class="filter-dropdown-content" id="priorityDropdownContent">
                ${boardPriorities.map(priority => `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="priority" value="${priority}" data-change="handleFilterChange" data-change-args='["priority", {"$ref": "el"}]'>
                        ${priorityLabels[priority] || priority}
                    </label>
                `).join('')}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="priorityClearBtn" data-click="clearFilter" data-click-args='["priority"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-dropdown" id="stateDropdown">
            <button class="filter-dropdown-btn" id="stateDropdownBtn" data-click="toggleDropdown" data-click-args='["stateDropdownContent"]'>States</button>
            <div class="filter-dropdown-content" id="stateDropdownContent">
                ${boardStates.map(state => `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="state" value="${this._escapeHtml(state)}" data-change="handleFilterChange" data-change-args='["state", {"$ref": "el"}]'>
                        ${this._escapeHtml(state)}
                    </label>
                `).join('')}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="stateClearBtn" data-click="clearFilter" data-click-args='["state"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-dropdown" id="areaDropdown">
            <button class="filter-dropdown-btn" id="areaDropdownBtn" data-click="toggleDropdown" data-click-args='["areaDropdownContent"]'>Area</button>
            <div class="filter-dropdown-content" id="areaDropdownContent">
                ${boardAreas.map(area => `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="area" value="${this._escapeHtml(area)}" data-change="handleFilterChange" data-change-args='["area", {"$ref": "el"}]'>
                        ${this._escapeHtml(area.split('\\').pop() || area)}
                    </label>
                `).join('')}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="areaClearBtn" data-click="clearFilter" data-click-args='["area"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-dropdown" id="iterationDropdown" style="flex-shrink: 0;">
            <button class="filter-dropdown-btn" id="iterationDropdownBtn" data-click="toggleDropdown" data-click-args='["iterationDropdownContent"]' style="min-width: 100px;">Iteration</button>
            <div class="filter-dropdown-content" id="iterationDropdownContent">
                <label class="filter-checkbox-item"><input type="checkbox" name="iteration" value="@currentiteration" data-change="handleFilterChange" data-change-args='["iteration", {"$ref": "el"}]'> @CurrentIteration</label>
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                ${boardIterations.length > 0 ? boardIterations.map(iteration => {
                    // Remove organization and team prefix (first 2 segments)
                    // e.g., "Experian Verifications\\DevOps\\FY26.Q4.03" -> "FY26.Q4.03"
                    const parts = iteration.split('\\');
                    const displayName = parts.length > 2 ? parts.slice(2).join('\\') : iteration;
                    return `
                    <label class="filter-checkbox-item">
                        <input type="checkbox" name="iteration" value="${this._escapeHtml(iteration)}" data-change="handleFilterChange" data-change-args='["iteration", {"$ref": "el"}]'>
                        ${this._escapeHtml(displayName)}
                    </label>
                    `;
                }).join('') : '<div style="padding: 8px; color: var(--vscode-descriptionForeground); font-size: 11px;">No iterations available</div>'}
                <div class="filter-divider" style="margin: 4px 0; height: 1px; width: 100%;"></div>
                <button class="filter-clear-btn" id="iterationClearBtn" data-click="clearFilter" data-click-args='["iteration"]' disabled>✕ Clear</button>
            </div>
        </div>

        <div class="filter-divider"></div>

        <button class="filter-toggle" id="hideDoneToggle" data-click="toggleHideDone">
            <span class="filter-toggle-icon">✓</span>
            Hide Done
        </button>

        <div class="filter-count" id="filterCount">
            Showing <strong id="visibleCount">0</strong> of <strong id="totalCount">0</strong> items
        </div>
    </div>

    <div class="board-container" id="boardContainer" role="region" aria-label="${this._escapeHtml(this.boardName)} board" aria-describedby="boardKeyboardHint">
        <p id="boardKeyboardHint" class="sr-only">Use the arrow keys to move between cards and columns. Enter opens a card, M moves it to another column, and Shift+F10 opens its menu.</p>
        ${columns.map((column, colIndex) => {
            const items = workItems.get(column.name) || [];
            const itemCount = items.length;
            const wipClass = column.itemLimit > 0
                ? (itemCount >= column.itemLimit ? 'danger' : (itemCount >= column.itemLimit * 0.8 ? 'warning' : ''))
                : '';

            const stateMappings = column.stateMappings || {};
            const targetState = Object.values(stateMappings)[0] || column.name;

            return `
            <div class="column"
                 data-column="${this._escapeHtml(column.name)}"
                 data-state="${this._escapeHtml(String(targetState))}"
                 data-state-mappings="${this._escapeHtml(JSON.stringify(stateMappings))}"
                 data-limit="${column.itemLimit}"
                 data-index="${colIndex}"
                 role="group"
                 aria-label="${this._escapeHtml(column.name)} column, ${itemCount} item${itemCount === 1 ? '' : 's'}${column.itemLimit > 0 ? ', limit ' + column.itemLimit : ''}"
                 tabindex="-1"
                 data-dragover="handleDragOver" data-dragover-args='[{"$ref": "event"}]'
                 data-dragleave="handleDragLeave" data-dragleave-args='[{"$ref": "event"}]'
                 data-drop="handleDrop" data-drop-args='[{"$ref": "event"}]'>
                <div class="column-header" data-click="toggleColumn" data-click-args='[{"$ref": "parent"}]'>
                    <div class="column-header-left">
                        <button class="collapse-btn" data-click="toggleColumn" data-click-args='[{"$ref": "column"}]' data-stop aria-expanded="true" aria-label="Collapse ${this._escapeHtml(column.name)} column"><span aria-hidden="true">◀</span></button>
                        <span class="column-title">${this._escapeHtml(column.name)}</span>
                    </div>
                    <div class="column-header-right">
                        ${colIndex === 0 ? `
                        <button class="add-item-header-btn" data-click="showAddForm" data-click-args='[${jsArg(column.name)}]' data-stop title="New item">
                            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4z"/></svg>
                            New item
                        </button>
                        ` : ''}
                        <span class="wip-badge ${wipClass}">
                            ${itemCount}${column.itemLimit > 0 ? '/' + column.itemLimit : ''}
                        </span>
                    </div>
                </div>
                ${colIndex === 0 ? `
                <div class="add-item-form-container" id="add-form-${this._escapeHtml(column.name).replace(/\s/g, '-')}">
                    <div class="add-item-row">
                        <div class="add-item-type-dropdown" id="add-item-type-dropdown">
                            <button class="add-item-type-btn" id="add-item-type-btn" data-click="toggleTypeDropdown" data-click-args='[{"$ref": "event"}]' title="${this._escapeHtml(defaultWorkItemType)}" aria-label="Work item type: ${this._escapeHtml(defaultWorkItemType)}" aria-haspopup="listbox">
                                <span class="type-icon">${this._getTypeIcon(defaultWorkItemType)}</span>
                                <svg class="dropdown-arrow" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4z"/></svg>
                            </button>
                            <div class="add-item-type-menu" id="add-item-type-menu">
                                ${allWorkItemTypes.map(type => `
                                    <div class="type-menu-item ${type === defaultWorkItemType ? 'selected' : ''}" role="option" tabindex="0" aria-label="${this._escapeHtml(type)}" aria-selected="${type === defaultWorkItemType}" data-type="${this._escapeHtml(type)}" data-click="selectWorkItemType" data-click-args='[${jsArg(type)}]' title="${this._escapeHtml(type)}">
                                        <span class="type-icon">${this._getTypeIcon(type)}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        <input type="hidden" id="add-item-type-value" value="${this._escapeHtml(defaultWorkItemType)}" />
                        <input type="text" class="add-item-input" id="add-item-title-input" placeholder="Enter title..." aria-label="New work item title"
                               data-keydown="handleAddKeydown" data-keydown-args='[{"$ref": "event"}, ${jsArg(column.name)}]' />
                        <button class="btn btn-primary add-item-submit" data-click="createItem" data-click-args='[${jsArg(column.name)}]'>Add to top</button>
                    </div>
                </div>
                ` : ''}
                <div class="column-body" role="list" aria-label="${this._escapeHtml(column.name)}">
                    ${items.map((item, itemIndex) => this._renderCard(item, colIndex, itemIndex)).join('')}
                    ${items.length === 0 ? '<div class="empty-column" role="listitem">No items</div>' : ''}
                    <div class="drop-placeholder"></div>
                </div>
            </div>
            `;
        }).join('')}
    </div>

    <!-- Context Menu -->
    <div class="context-menu" id="contextMenu" role="menu" aria-label="Work item actions">
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["open"]'>
            <span class="icon" aria-hidden="true">📄</span> Open Details
        </div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["openBrowser"]'>
            <span class="icon" aria-hidden="true">🌐</span> Open in Browser
        </div>
        <div class="context-menu-separator" role="separator"></div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["assignToMe"]'>
            <span class="icon" aria-hidden="true">👤</span> Assign to Me
        </div>
        <div class="context-menu-item context-menu-submenu">
            <span class="icon" aria-hidden="true">📊</span> Change State
            <div class="submenu" id="stateSubmenu">
                ${columns.map(col => {
                    const state = Object.values(col.stateMappings || {})[0] || col.name;
                    return `<div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["changeState", ${jsArg(String(state))}]'>${this._escapeHtml(String(state))}</div>`;
                }).join('')}
            </div>
        </div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["addComment"]'>
            <span class="icon" aria-hidden="true">💬</span> Add Comment
        </div>
        <div class="context-menu-separator" role="separator"></div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["createBranch"]'>
            <span class="icon" aria-hidden="true">🔀</span> Create Branch
        </div>
        <div class="context-menu-separator" role="separator"></div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["copyId"]'>
            <span class="icon" aria-hidden="true">📋</span> Copy ID
        </div>
        <div class="context-menu-item" role="menuitem" tabindex="-1" data-click="contextMenuAction" data-click-args='["copyUrl"]'>
            <span class="icon" aria-hidden="true">🔗</span> Copy URL
        </div>
    </div>

    <!-- Card Menu -->
    <div class="card-menu" id="cardMenu" role="menu" aria-label="Card actions">
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["open"]'>
            <img src="https://img.icons8.com/pastel-glyph/128/external-link--v2.png" class="menu-icon" alt="open"> Open
        </div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["editTitle"]'>
            <img src="https://img.icons8.com/ios/50/edit--v1.png" class="menu-icon" alt="edit"> Edit title
        </div>
        <div class="card-menu-separator" role="separator"></div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["moveToColumn"]'>
            <img src="https://img.icons8.com/ios/50/resize-horizontal.png" class="menu-icon" alt="move column"> Move to column
        </div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["moveToIteration"]'>
            <img src="https://img.icons8.com/ios/50/resize-horizontal.png" class="menu-icon" alt="move iteration"> Move to iteration
        </div>
        <div class="card-menu-separator" role="separator"></div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["addTask"]'>
            <img src="https://img.icons8.com/ios/50/plus--v1.png" class="menu-icon" alt="add task"> Add Task
        </div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["addTest"]'>
            <img src="https://img.icons8.com/carbon-copy/100/test-tube.png" class="menu-icon test-icon" alt="add test"> Add Test
        </div>
        <div class="card-menu-separator" role="separator"></div>
        <div class="card-menu-item" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["createBranch"]'>
            <img src="https://img.icons8.com/ios/50/merge-git.png" class="menu-icon" alt="branch"> New branch...
        </div>
        <div class="card-menu-separator" role="separator"></div>
        <div class="card-menu-item danger" role="menuitem" tabindex="-1" data-click="cardMenuAction" data-click-args='["delete"]'>
            <img src="https://img.icons8.com/ios/50/trash--v1.png" class="menu-icon" alt="delete"> Delete
        </div>
    </div>

    <!-- Keyboard Help -->
    <div class="keyboard-help" id="keyboardHelp" role="note" aria-label="Keyboard shortcuts">
        <strong>Keyboard Shortcuts:</strong><br>
        <kbd>↑</kbd><kbd>↓</kbd> Navigate cards &nbsp;
        <kbd>←</kbd><kbd>→</kbd> Navigate columns<br>
        <kbd>M</kbd> Move mode &nbsp;
        <kbd>Shift</kbd>+<kbd>F10</kbd> Card menu &nbsp;
        <kbd>Enter</kbd> Open details &nbsp;
        <kbd>R</kbd> Refresh<br>
        <kbd>F</kbd> Toggle filters &nbsp;
        <kbd>?</kbd> Toggle this help &nbsp;
        <kbd>Esc</kbd> Cancel
    </div>

    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <div class="sr-only" id="srStatus" role="status" aria-live="assertive"></div>

    <script nonce="${nonce}" id="board-data" type="application/json">${serializeForScript(boardData)}</script>
    <script nonce="${nonce}" src="${handlersJsUri}"></script>
    <script nonce="${nonce}" src="${boardJsUri}"></script>
</body>
</html>`;
    }

    private _renderCard(item: BoardWorkItem, colIndex: number = 0, itemIndex: number = 0): string {
        const initials = item.assignedTo?.displayName
            ? item.assignedTo.displayName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
            : '?';
        const stateLower = item.state.toLowerCase();
        const stateClass = stateLower.includes('done') || stateLower.includes('closed') ? 'done'
                         : stateLower.includes('active') || stateLower.includes('doing') ? 'doing'
                         : 'todo';

        const typeIcon = this._getTypeIcon(item.type);
        const effort = item.effort || '';

        const tags = item.tags
            ? item.tags.split(';').map((tag) => {
                const tagName = tag.trim();
                const tagColor = safeCssColor(this._getTagColor(tagName), '#8b8b8b');
                const textColor = this._getContrastTextColor(tagColor);
                return `<span class="tag" style="background-color: ${tagColor}; border-color: ${tagColor}; color: ${textColor};">${this._escapeHtml(tagName)}</span>`;
              }).join('')
            : '';

        // Check if any card styling rules apply to this work item
        const cardBackgroundColor = safeCssColor(this._getCardBackgroundColor(item));
        const cardStyle = cardBackgroundColor ? `style="background-color: ${cardBackgroundColor} !important;"` : '';
        const hasChildren = item.children && item.children.length > 0;

        return `
        <div class="card ${hasChildren ? 'has-children' : ''}"
             draggable="true"
             data-id="${item.id}"
             data-col="${colIndex}"
             data-item="${itemIndex}"
             data-title="${this._escapeHtml(item.title)}"
             data-type="${this._escapeHtml(item.type)}"
             data-priority="${item.priority || ''}"
             data-assignee="${this._escapeHtml(item.assignedTo?.uniqueName || '')}"
             data-assignee-name="${this._escapeHtml(item.assignedTo?.displayName || '')}"
             data-state="${this._escapeHtml(item.state)}"
             data-tags="${this._escapeHtml(item.tags || '')}"
             data-areapath="${this._escapeHtml(item.areaPath || '')}"
             data-iterationpath="${this._escapeHtml(item.iterationPath || '')}"
             data-effort="${effort}"
             ${cardStyle}
             role="listitem"
             aria-label="${this._escapeHtml(`${item.type} ${item.id}: ${item.title}. ${item.state}. ${item.assignedTo?.displayName || 'Unassigned'}${item.effort ? '. Effort ' + item.effort : ''}`)}"
             aria-describedby="boardKeyboardHint"
             tabindex="0"
             data-dragstart="handleDragStart" data-dragstart-args='[{"$ref": "event"}, ${item.id}]'
             data-dragend="handleDragEnd" data-dragend-args='[{"$ref": "event"}]'
             data-click="openWorkItem" data-click-args='[${item.id}]'
             data-focus="selectCard" data-focus-args='[{"$ref": "el"}]'>
            <div class="card-header">
                <span class="card-type-icon" title="${this._escapeHtml(item.type)}">${typeIcon}</span>
                <div class="card-header-content">
                    <div class="card-id-title">
                        <span class="card-id" data-click="openWorkItem" data-click-args='[${item.id}]' data-stop>${item.id}</span>
                        <span class="card-title" data-dblclick="editCardTitle" data-dblclick-args='[{"$ref": "el"}, ${item.id}]' data-stop>${this._escapeHtml(item.title)}</span>
                    </div>
                </div>
                <button class="card-menu-btn" data-click="showCardMenu" data-click-args='[{"$ref": "event"}, ${item.id}]' data-stop title="More options" aria-label="More options for ${item.id}" aria-haspopup="menu"><span aria-hidden="true">⋯</span></button>
            </div>
            <div class="card-status">
                <span class="status-dot ${stateClass}"></span>
                <span class="status-label">${this._escapeHtml(item.state)}</span>
            </div>
            <div class="card-assignee" role="button" tabindex="-1" aria-label="Change assignee" data-click="changeCardAssignee" data-click-args='[${item.id}, ${jsArg(item.assignedTo?.displayName || '')}]' data-stop>
                <div class="card-avatar ${!item.assignedTo ? 'unassigned' : ''}">${initials}</div>
                <span class="card-assignee-name ${!item.assignedTo ? 'unassigned-text' : ''}">${item.assignedTo ? this._escapeHtml(item.assignedTo.displayName) : ''}</span>
            </div>
            ${item.effort ? `<div class="card-effort">
                <span class="card-effort-label">Effort</span>
                <span class="card-effort-value" data-click="editCardEffort" data-click-args='[{"$ref": "el"}, ${item.id}, ${item.effort}]' data-stop>${item.effort}</span>
            </div>` : ''}
            ${tags ? `<div class="card-tags">${tags}</div>` : ''}
            ${this._renderChildIndicator(item)}
        </div>`;

    }

    private _renderChildIndicator(item: BoardWorkItem): string {
        if (!item.children || item.children.length === 0) {
            return '';
        }

        // Group children by work item type
        const childrenByType = new Map<string, {id: number, title: string, state: string, type: string, assignedTo?: any}[]>();
        item.children.forEach(child => {
            const type = child.type || 'Unknown';
            if (!childrenByType.has(type)) {
                childrenByType.set(type, []);
            }
            childrenByType.get(type)!.push(child);
        });

        // Render indicator for each work item type (clickable) - each type has its own checklist
        const indicators: string[] = [];
        const checklists: string[] = [];

        childrenByType.forEach((children, type) => {
            const totalChildren = children.length;
            const closedChildren = children.filter(child => {
                const state = child.state?.toLowerCase() || '';
                return state === 'closed' || state === 'done' || state === 'completed';
            }).length;
            const allClosed = closedChildren === totalChildren;
            const childIcon = this._getChildTypeIcon(type);
            const typeId = type.replace(/\s+/g, '-').toLowerCase();

            // Each indicator toggles its own type-specific checklist
            indicators.push(`
                <div class="child-indicator-item ${allClosed ? 'completed' : ''}"
                     role="button" tabindex="0" aria-expanded="false"
                     aria-label="${this._escapeHtml(type)}: ${closedChildren} of ${totalChildren} done. Show checklist"
                     data-click="toggleChildChecklist" data-click-args='[${item.id}, ${jsArg(typeId)}]' data-stop
                     title="Click to expand/collapse ${this._escapeHtml(type)} checklist">
                    ${childIcon}
                    <span class="child-count">${closedChildren}/${totalChildren}</span>
                </div>
            `);

            // Build the checklist content in correct order to match browser
            const checklistContent: string[] = [];

            // 1. Add "Add [Type]" button FIRST (appears at top in browser)
            checklistContent.push(`
                <div class="checklist-add-item">
                    <button class="checklist-add-button"
                            data-click="addChildWorkItem" data-click-args='[${item.id}, ${jsArg(type)}]' data-stop
                            title="Add new ${this._escapeHtml(type)}">
                        <span class="add-icon">+</span> Add ${this._escapeHtml(type)}
                    </button>
                </div>
            `);

            // 2. Render each child item row
            children.forEach(child => {
                const isDone = ['closed', 'done', 'completed'].includes(child.state?.toLowerCase() || '');
                const initials = child.assignedTo?.displayName
                    ? child.assignedTo.displayName.split(' ').map((n: string) => n[0]).join('').substring(0, 2).toUpperCase()
                    : '?';

                // CRITICAL: Avatar goes IMMEDIATELY after the icon, before the title
                const assigneeName = child.assignedTo?.displayName || '';
                checklistContent.push(`
                    <div class="checklist-item ${isDone ? 'done' : ''}" data-assignee-name="${this._escapeHtml(assigneeName)}">
                        <input type="checkbox"
                               class="checklist-checkbox"
                               ${isDone ? 'checked' : ''}
                               data-child-id="${child.id}"
                               data-click="toggleChildState" data-click-args='[${child.id}, ${item.id}, {"$ref": "checked"}]' data-stop
                               title="Mark as ${isDone ? 'not done' : 'done'}">
                        <span class="checklist-icon">${this._getChildTypeIcon(child.type)}</span>
                        <div class="checklist-avatar card-avatar ${!child.assignedTo ? 'unassigned' : ''}"
                             title="${child.assignedTo ? this._escapeHtml(child.assignedTo.displayName) : 'Unassigned'}">${initials}</div>
                        <span class="checklist-title ${isDone ? 'done' : ''}"
                              data-click="openWorkItem" data-click-args='[${child.id}]' data-stop
                              title="Click to open ${this._escapeHtml(child.title)}">${this._escapeHtml(child.title)}</span>
                    </div>
                `);
            });

            // Create a separate checklist div for each type
            checklists.push(`
                <div class="child-checklist" id="checklist-${item.id}-${typeId}">
                    <div class="checklist-content">
                        ${checklistContent.join('')}
                    </div>
                </div>
            `);
        });

        return `
            <div class="child-indicators-container">
                ${indicators.join('')}
            </div>
            ${checklists.join('')}
        `;
    }

    private _getChildTypeIcon(type: string): string {
        // Return actual Azure DevOps work item type icons at 12x12 size
        switch(type) {
            case 'User Story':
            case 'Product Backlog Item':
            case 'Requirement':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>`;

            case 'Feature':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#773B93" d="M145.619 384H128c-17.674 0-32 14.326-32 32v32h256v-32c0-17.674-14.327-32-32-32h-17.619c-7.434-36.47-39.75-64-78.381-64s-70.947 27.53-78.381 64zM224 352c20.832 0 38.425 13.418 45.053 32h-90.106c6.627-18.582 24.221-32 45.053-32zM352 64V32H96v32H32v80c0 40.051 29.686 73.018 68.153 78.8C114.003 278.531 163.984 320 224 320c60.016 0 109.997-41.469 123.846-97.2C386.313 217.018 416 184.051 416 144V64h-64zM96 189.053C77.417 182.426 64 164.832 64 144V96h32v93.053zM384 144c0 20.832-13.418 38.426-32 45.053V96h32v48z" /></svg>`;

            case 'Epic':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#FF8C00" d="M448 96c0 17.672-14.326 32-32 32v288H32V128c-17.674 0-32-14.328-32-32 0-17.674 14.326-32 32-32s32 14.326 32 32c0 11.191-6.094 20.564-14.797 26.283L136.727 256 216.79 94.543C202.699 91.191 192 79.113 192 64c0-17.674 14.326-32 32-32s32 14.326 32 32c0 15.113-10.699 27.191-24.789 30.543L311.273 256l87.523-133.717C390.094 116.564 384 107.191 384 96c0-17.674 14.326-32 32-32s32 14.326 32 32z" /></svg>`;

            case 'Task':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#FFC107" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm56 287.758l-79.844-79.828 31.688-31.688L184 320.414l128.156-128.172 31.688 31.688L184 383.758z" /></svg>`;

            case 'Issue':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#28A745" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zm-71.469 352h-49.063v-49.094h49.063V416zm0-84.109h-49.063V164.109h49.063v167.782zM320 128H128V96h64V64c0-17.643 14.357-32 32-32 17.641 0 32 14.357 32 32v32h64v32z" /></svg>`;

            case 'Bug':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#CC293D" d="M352 224c0-17.672 14.328-32 32-32h32v-32h-32c-8.828 0-16.938 2.797-23.656 7.516C350.391 140.234 324.078 120 293 120.781 287.016 108.297 275.547 99.828 262 96.781V64h32V32h-96v32h32v32.781c-13.547 3.047-25.016 11.516-31 24-31.078.781-57.391 21.016-67.344 48.297C125.938 163.797 117.828 161 109 161H77v32h32c17.672 0 32 14.328 32 32v32c0 17.672-14.328 32-32 32H77v32h32c8.828 0 16.938-2.797 23.656-7.516C142.609 340.766 168.922 361 200 360.219c5.984 12.484 17.453 20.953 31 24V417h-32v32h96v-32h-32v-32.781c13.547-3.047 25.016-11.516 31-24 31.078-.781 57.391-21.016 67.344-48.297C366.062 317.203 374.172 320 383 320h32v-32h-32c-17.672 0-32-14.328-32-32v-32zm-80 48c-26.469 0-48-21.531-48-48s21.531-48 48-48 48 21.531 48 48-21.531 48-48 48z" /></svg>`;

            case 'Test Case':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><path fill="#9B59B6" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm192 320H128V192h192v224z" /></svg>`;

            default:
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="12" height="12"><circle cx="224" cy="224" r="160" fill="#666666"/></svg>`;
        }
    }

    private _getTypeIcon(type: string): string {
        // Use SVG icons with Azure DevOps standard colors
        switch(type) {
            case 'User Story':
            case 'Product Backlog Item':
            case 'Requirement':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>`;

            case 'Feature':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#773B93" d="M145.619 384H128c-17.674 0-32 14.326-32 32v32h256v-32c0-17.674-14.327-32-32-32h-17.619c-7.434-36.47-39.75-64-78.381-64s-70.947 27.53-78.381 64zM224 352c20.832 0 38.425 13.418 45.053 32h-90.106c6.627-18.582 24.221-32 45.053-32zM352 64V32H96v32H32v80c0 40.051 29.686 73.018 68.153 78.8C114.003 278.531 163.984 320 224 320c60.016 0 109.997-41.469 123.846-97.2C386.313 217.018 416 184.051 416 144V64h-64zM96 189.053C77.417 182.426 64 164.832 64 144V96h32v93.053zM384 144c0 20.832-13.418 38.426-32 45.053V96h32v48z" /></svg>`;

            case 'Epic':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#FF8C00" d="M448 96c0 17.672-14.326 32-32 32v288H32V128c-17.674 0-32-14.328-32-32 0-17.674 14.326-32 32-32s32 14.326 32 32c0 11.191-6.094 20.564-14.797 26.283L136.727 256 216.79 94.543C202.699 91.191 192 79.113 192 64c0-17.674 14.326-32 32-32s32 14.326 32 32c0 15.113-10.699 27.191-24.789 30.543L311.273 256l87.523-133.717C390.094 116.564 384 107.191 384 96c0-17.674 14.326-32 32-32s32 14.326 32 32z" /></svg>`;

            case 'Task':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#FFC107" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm56 287.758l-79.844-79.828 31.688-31.688L184 320.414l128.156-128.172 31.688 31.688L184 383.758z" /></svg>`;

            case 'Issue':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#28A745" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zm-71.469 352h-49.063v-49.094h49.063V416zm0-84.109h-49.063V164.109h49.063v167.782zM320 128H128V96h64V64c0-17.643 14.357-32 32-32 17.641 0 32 14.357 32 32v32h64v32z" /></svg>`;

            case 'Bug':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#CC293D" d="M352 224c0-17.672 14.328-32 32-32h32v-32h-32c-8.828 0-16.938 2.797-23.656 7.516C350.391 140.234 324.078 120 293 120.781 287.016 108.297 275.547 99.828 262 96.781V64h32V32h-96v32h32v32.781c-13.547 3.047-25.016 11.516-31 24-31.078.781-57.391 21.016-67.344 48.297C125.938 163.797 117.828 161 109 161H77v32h32c17.672 0 32 14.328 32 32v32c0 17.672-14.328 32-32 32H77v32h32c8.828 0 16.938-2.797 23.656-7.516C142.609 340.766 168.922 361 200 360.219c5.984 12.484 17.453 20.953 31 24V417h-32v32h96v-32h-32v-32.781c13.547-3.047 25.016-11.516 31-24 31.078-.781 57.391-21.016 67.344-48.297C366.062 317.203 374.172 320 383 320h32v-32h-32c-17.672 0-32-14.328-32-32v-32zm-80 48c-26.469 0-48-21.531-48-48s21.531-48 48-48 48 21.531 48 48-21.531 48-48 48z" /></svg>`;

            case 'Test Case':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#9B59B6" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm192 320H128V192h192v224z" /></svg>`;

            default:
                // Generic work item icon for unknown types
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#666666" d="M384 0H64C28.65 0 0 28.65 0 64v320c0 35.35 28.65 64 64 64h320c35.35 0 64-28.65 64-64V64c0-35.35-28.65-64-64-64zm32 384c0 17.64-14.36 32-32 32H64c-17.64 0-32-14.36-32-32V64c0-17.64 14.36-32 32-32h320c17.64 0 32 14.36 32 32v320z"/><rect x="96" y="96" width="256" height="32" fill="#666666"/><rect x="96" y="160" width="192" height="32" fill="#666666"/><rect x="96" y="224" width="224" height="32" fill="#666666"/></svg>`;
        }
    }

    private _getDefaultWorkItemType(): string {
        // Map board names to work item types
        const boardNameLower = this.boardName.toLowerCase();

        // Common board name patterns
        if (boardNameLower.includes('issue')) return 'Issue';
        if (boardNameLower.includes('bug')) return 'Bug';
        if (boardNameLower.includes('task')) return 'Task';
        if (boardNameLower.includes('epic')) return 'Epic';
        if (boardNameLower.includes('feature')) return 'Feature';
        if (boardNameLower.includes('story') || boardNameLower.includes('stories')) return 'User Story';
        if (boardNameLower.includes('backlog') || boardNameLower.includes('pbi')) return 'Product Backlog Item';
        if (boardNameLower.includes('requirement')) return 'Requirement';

        // Default to User Story if no match
        return 'User Story';
    }

    private _getBoardIcon(boardName: string): string {
        // Map board name to work item type and return its icon
        const boardNameLower = boardName.toLowerCase();

        // Common board name patterns
        if (boardNameLower.includes('issue')) return this._getTypeIcon('Issue');
        if (boardNameLower.includes('bug')) return this._getTypeIcon('Bug');
        if (boardNameLower.includes('task')) return this._getTypeIcon('Task');
        if (boardNameLower.includes('epic')) return this._getTypeIcon('Epic');
        if (boardNameLower.includes('feature')) return this._getTypeIcon('Feature');
        if (boardNameLower.includes('story') || boardNameLower.includes('stories')) return this._getTypeIcon('User Story');
        if (boardNameLower.includes('backlog') || boardNameLower.includes('pbi')) return this._getTypeIcon('Product Backlog Item');
        if (boardNameLower.includes('requirement')) return this._getTypeIcon('Requirement');

        // Default to User Story icon if no match
        return this._getTypeIcon('User Story');
    }

    private _getCardBackgroundColor(item: BoardWorkItem): string | null {
        // Check each card styling rule to see if it applies to this work item
        for (const rule of this._cardStyleRules) {
            if (this._evaluateCardStyleRule(rule.filter, item)) {
                return rule.settings['background-color'];
            }
        }
        return null;
    }

    private _evaluateCardStyleRule(filter: string, item: BoardWorkItem): boolean {
        try {
            // Generic pattern to match field comparisons: [FieldName] operator value
            const fieldPattern = /\[([^\]]+)\]\s*(=|!=|>|>=|<|<=|Contains|Under)\s*(?:'([^']+)'|(\d+(?:\.\d+)?))/gi;
            const matches = [...filter.matchAll(fieldPattern)];
            
            if (matches.length === 0) return false;
            
            // Evaluate all conditions (AND logic)
            for (const match of matches) {
                const fieldName = match[1];
                const operator = match[2].toLowerCase();
                const stringValue = match[3];
                const numericValue = match[4] ? parseFloat(match[4]) : null;
                
                if (!this._evaluateFieldCondition(fieldName, operator, stringValue, numericValue, item)) {
                    return false;
                }
            }
            
            return matches.length > 0;
        } catch (error) {
            log.error('Error evaluating card style rule:', error);
            return false;
        }
    }

    private _evaluateFieldCondition(fieldName: string, operator: string, stringValue: string | undefined, numericValue: number | null, item: BoardWorkItem): boolean {
        const fieldLower = fieldName.toLowerCase();
        
        // Tags
        if (fieldLower.includes('tags')) {
            const itemTags = (item.tags || '').toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === 'contains') return itemTags.includes(filterValue);
            if (operator === '=') return itemTags.split(';').map(t => t.trim()).includes(filterValue);
        }
        
        // State
        if (fieldLower.includes('state')) {
            const itemState = item.state.toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === '=') return itemState === filterValue;
            if (operator === '!=') return itemState !== filterValue;
        }
        
        // Work Item Type
        if (fieldLower.includes('workitemtype')) {
            const itemType = item.type.toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === '=') return itemType === filterValue;
            if (operator === '!=') return itemType !== filterValue;
        }
        
        // Priority
        if (fieldLower.includes('priority') && item.priority !== undefined) {
            if (numericValue !== null) {
                if (operator === '=') return item.priority === numericValue;
                if (operator === '!=') return item.priority !== numericValue;
                if (operator === '>') return item.priority > numericValue;
                if (operator === '>=') return item.priority >= numericValue;
                if (operator === '<') return item.priority < numericValue;
                if (operator === '<=') return item.priority <= numericValue;
            }
        }
        
        // Area Path
        if (fieldLower.includes('areapath')) {
            const itemArea = (item.areaPath || '').toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === '=') return itemArea === filterValue;
            if (operator === 'under') return itemArea.startsWith(filterValue);
        }
        
        // Title
        if (fieldLower.includes('title')) {
            const itemTitle = item.title.toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === 'contains') return itemTitle.includes(filterValue);
            if (operator === '=') return itemTitle === filterValue;
        }
        
        // Assigned To
        if (fieldLower.includes('assignedto')) {
            const itemAssignee = (item.assignedTo?.displayName || item.assignedTo?.uniqueName || '').toLowerCase();
            const filterValue = (stringValue || '').toLowerCase();
            if (operator === '=') return itemAssignee === filterValue;
            if (operator === 'contains') return itemAssignee.includes(filterValue);
        }
        
        // Numeric fields (Story Points, Remaining Work, Business Value, etc.)
        // These would need to be added to BoardWorkItem interface and fetched from API
        const numericFields = ['storypoints', 'remainingwork', 'businessvalue', 'effort', 'severity'];
        if (numericFields.some(f => fieldLower.includes(f)) && numericValue !== null) {
            const itemValue = (item as any)[fieldLower.replace(/[^a-z]/g, '')] || 0;
            if (operator === '=') return itemValue === numericValue;
            if (operator === '!=') return itemValue !== numericValue;
            if (operator === '>') return itemValue > numericValue;
            if (operator === '>=') return itemValue >= numericValue;
            if (operator === '<') return itemValue < numericValue;
            if (operator === '<=') return itemValue <= numericValue;
        }
        
        return false;
    }

    private _getContrastTextColor(backgroundColor: string): string {
        // Calculate relative luminance and return black or white text for optimal contrast
        // Based on WCAG guidelines: https://www.w3.org/TR/WCAG20/#relativeluminancedef
        
        // Parse color (supports hex, rgb, rgba)
        let r = 0, g = 0, b = 0;
        
        if (backgroundColor.startsWith('#')) {
            // Hex color
            const hex = backgroundColor.replace('#', '');
            if (hex.length === 3) {
                r = parseInt(hex[0] + hex[0], 16);
                g = parseInt(hex[1] + hex[1], 16);
                b = parseInt(hex[2] + hex[2], 16);
            } else {
                r = parseInt(hex.substring(0, 2), 16);
                g = parseInt(hex.substring(2, 4), 16);
                b = parseInt(hex.substring(4, 6), 16);
            }
        } else if (backgroundColor.startsWith('rgb')) {
            // RGB/RGBA color
            const match = backgroundColor.match(/\d+/g);
            if (match && match.length >= 3) {
                r = parseInt(match[0]);
                g = parseInt(match[1]);
                b = parseInt(match[2]);
            }
        }
        
        // Calculate relative luminance
        const rsRGB = r / 255;
        const gsRGB = g / 255;
        const bsRGB = b / 255;
        
        const rLinear = rsRGB <= 0.03928 ? rsRGB / 12.92 : Math.pow((rsRGB + 0.055) / 1.055, 2.4);
        const gLinear = gsRGB <= 0.03928 ? gsRGB / 12.92 : Math.pow((gsRGB + 0.055) / 1.055, 2.4);
        const bLinear = bsRGB <= 0.03928 ? bsRGB / 12.92 : Math.pow((bsRGB + 0.055) / 1.055, 2.4);
        
        const luminance = 0.2126 * rLinear + 0.7152 * gLinear + 0.0722 * bLinear;
        
        // Use black text for light backgrounds (luminance > 0.5), white for dark
        return luminance > 0.5 ? '#000000' : '#ffffff';
    }

    private _getTagColor(tagName: string): string {
        // Check if we have a color for this tag from Azure DevOps
        const azureColor = this._tagColors.get(tagName.toLowerCase());
        if (azureColor) {
            return azureColor;
        }

        // Fall back to consistent colors based on tag name (not index)
        // This ensures the same tag always gets the same color across all cards
        const fallbackColors = [
            'rgba(0, 120, 212, 0.15)',   // blue
            'rgba(16, 124, 16, 0.15)',   // green
            'rgba(136, 23, 152, 0.15)',  // purple
            'rgba(232, 17, 35, 0.15)',   // pink/red
            'rgba(255, 185, 0, 0.15)',   // yellow
            'rgba(0, 183, 195, 0.15)'    // cyan
        ];

        // Generate consistent hash from tag name
        let hash = 0;
        for (let i = 0; i < tagName.length; i++) {
            hash = ((hash << 5) - hash) + tagName.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }

        // Use absolute value to ensure positive index
        const colorIndex = Math.abs(hash) % fallbackColors.length;
        return fallbackColors[colorIndex];
    }

    private _escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }

    private _startAutoRefresh() {
        // Refresh every 30 seconds
        this._refreshInterval = setInterval(async () => {
            const now = Date.now();
            // Only refresh if the panel is visible and it's been at least 30 seconds
            if (this._panel.visible && now - this._lastRefreshTime >= 30000) {
                this._lastRefreshTime = now;
                await this._loadAndRender();
            }
        }, 30000);
    }

    private _stopAutoRefresh() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = undefined;
        }
    }

    public dispose() {
        // Unsubscribe from events
        if (this.eventSubscription) {
            this.eventSubscription.dispose();
            this.eventSubscription = null;
        }

        this._stopAutoRefresh();
        BoardPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}
