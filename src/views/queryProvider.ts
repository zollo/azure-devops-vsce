import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { AuthenticationManager } from '../authentication/authenticationManager';
import { LIST_FIELDS, MAX_IDS_PER_REQUEST } from '../utils/workItemBatches';
import { applyLoadError, describeLoadError } from './loadErrors';
import { WorkItem } from '../models/workItem';
import { decorateWorkItemRow } from './workItemTreeItems';

export interface Query {
    id: string;
    name: string;
    path: string;
    isFolder: boolean;
    hasChildren: boolean;
    children?: Query[];
    queryType?: string;
    wiql?: string;
}

export class QueryProvider implements vscode.TreeDataProvider<QueryTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<QueryTreeItem | undefined | void> = new vscode.EventEmitter<QueryTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<QueryTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private context: vscode.ExtensionContext;
    private authenticationManager: AuthenticationManager;
    private queries: Query[] = [];
    private queryResults: Map<string, WorkItem[]> = new Map();

    constructor(context: vscode.ExtensionContext, authenticationManager: AuthenticationManager) {
        this.context = context;
        this.authenticationManager = authenticationManager;
    }

    private queriesError: unknown;

    refresh(): void {
        // getChildren reloads the queries; loading here as well made every refresh fetch them twice
        this._onDidChangeTreeData.fire();
    }

    private async loadQueries(): Promise<void> {
        this.queriesError = undefined;
        if (!this.authenticationManager.isConnected()) {
            this.queries = [];
            return;
        }

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                this.queries = [];
                return;
            }

            // Get query folders and queries
            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/queries`,
                {
                    params: {
                        '$depth': 2,
                        '$expand': 'all'
                    }
                }
            );

            this.queries = this.parseQueryHierarchy(response.data.value || []);
        } catch (error: any) {
            log.error('Failed to load queries:', error?.message || error);
            this.queries = [];
            this.queriesError = error;
        }
    }

    private parseQueryHierarchy(items: any[]): Query[] {
        return items.map(item => ({
            id: item.id,
            name: item.name,
            path: item.path,
            isFolder: item.isFolder || false,
            hasChildren: item.hasChildren || false,
            children: item.children ? this.parseQueryHierarchy(item.children) : undefined,
            queryType: item.queryType,
            wiql: item.wiql
        }));
    }

    getTreeItem(element: QueryTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: QueryTreeItem): Promise<QueryTreeItem[]> {
        if (!this.authenticationManager.isConnected()) {
            return [];
        }

        if (!element) {
            // Root level - show query folders
            await this.loadQueries();

            if (this.queriesError) {
                return [applyLoadError(
                    new QueryTreeItem('', vscode.TreeItemCollapsibleState.None),
                    describeLoadError(this.queriesError, 'queries'),
                    'azureDevOps.refreshQueries'
                )];
            }

            if (this.queries.length === 0) {
                return [new QueryTreeItem('No queries found', vscode.TreeItemCollapsibleState.None)];
            }

            return this.queries.map(query => this.createQueryTreeItem(query));
        } else if (element.contextValue === 'queryFolder' && element.query?.children) {
            // Show child queries
            return element.query.children.map(query => this.createQueryTreeItem(query));
        } else if (element.contextValue === 'queryResults') {
            // Show query results
            const results = this.queryResults.get(element.queryId || '');
            if (!results || results.length === 0) {
                return [new QueryTreeItem('No results', vscode.TreeItemCollapsibleState.None)];
            }

            return results.map(item => {
                const treeItem = decorateWorkItemRow(new QueryTreeItem('', vscode.TreeItemCollapsibleState.None), item);
                treeItem.workItemId = item.id;
                return treeItem;
            });
        }

        return [];
    }

    private createQueryTreeItem(query: Query): QueryTreeItem {
        const isFolder = query.isFolder || query.hasChildren;
        const collapsibleState = isFolder
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;

        const command = isFolder ? undefined : {
            command: 'azureDevOps.runQuery',
            title: 'Run Query',
            arguments: [query]
        };

        const treeItem = new QueryTreeItem(query.name, collapsibleState, command);

        if (isFolder) {
            treeItem.contextValue = 'queryFolder';
            treeItem.iconPath = new vscode.ThemeIcon('folder');
        } else {
            treeItem.contextValue = 'query';
            treeItem.iconPath = new vscode.ThemeIcon('search');
        }

        treeItem.query = query;
        treeItem.tooltip = query.path;

        return treeItem;
    }

    async runQuery(query: Query): Promise<WorkItem[]> {
        if (!this.authenticationManager.isConnected()) {
            return [];
        }

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                return [];
            }

            // Run the query
            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/wiql/${query.id}`,
                { params: { '$top': MAX_IDS_PER_REQUEST } }
            );

            const workItemRefs = response.data.workItems || [];

            if (workItemRefs.length === 0) {
                return [];
            }

            // Get detailed work item information
            const workItemIds = workItemRefs.slice(0, 200).map((item: any) => item.id).join(',');
            const detailsResponse = await axiosInstance.get('/_apis/wit/workitems', {
                params: {
                    'ids': workItemIds,
                    'fields': LIST_FIELDS.join(','),
                    'errorPolicy': 'omit'
                }
            });

            const results = (detailsResponse.data.value || []).filter((item: any) => item);
            this.queryResults.set(query.id, results);

            return results;
        } catch (error) {
            log.error('Failed to run query:', error);
            vscode.window.showErrorMessage(`Failed to run query: ${error}`);
            return [];
        }
    }

    async runCustomQuery(wiql: string): Promise<WorkItem[]> {
        if (!this.authenticationManager.isConnected()) {
            return [];
        }

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) {
                return [];
            }

            const response = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/wiql`,
                { query: wiql },
                { params: { '$top': MAX_IDS_PER_REQUEST } }
            );

            const workItemRefs = response.data.workItems || [];

            if (workItemRefs.length === 0) {
                return [];
            }

            const workItemIds = workItemRefs.slice(0, 200).map((item: any) => item.id).join(',');
            const detailsResponse = await axiosInstance.get('/_apis/wit/workitems', {
                params: {
                    'ids': workItemIds,
                    'fields': LIST_FIELDS.join(','),
                    'errorPolicy': 'omit'
                }
            });

            return (detailsResponse.data.value || []).filter((item: any) => item);
        } catch (error) {
            log.error('Failed to run custom query:', error);
            return [];
        }
    }
}

export class QueryTreeItem extends vscode.TreeItem {
    public query?: Query;
    public queryId?: string;
    public workItemId?: number;

    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
    }
}
