import * as vscode from 'vscode';

/**
 * One way to show a work item as a tree row, shared by the Work Items, Sprints, Queries and
 * Backlogs views so they look and behave the same: "#id: title", type and state, a tooltip,
 * and a click that opens the item, including items with children (the twistie still expands).
 */

export const OPEN_WORK_ITEM_COMMAND = 'azureDevOps.viewWorkItemDetails';

export interface WorkItemRowOptions {
    /** Text after the title; defaults to "type • state". */
    description?: string;
    /** Defaults to a state icon from the state name. */
    iconPath?: vscode.TreeItem['iconPath'];
}

/** The click command for a work item row. */
export function openWorkItemCommand(id: number): vscode.Command {
    return { command: OPEN_WORK_ITEM_COMMAND, title: 'View Work Item Details', arguments: [id] };
}

/** Tooltip with the fields the rows don't have room for. Field values are added as plain text. */
export function workItemTooltip(item: { id: number; fields?: Record<string, any> }): vscode.MarkdownString {
    const fields = item.fields || {};
    const md = new vscode.MarkdownString();
    md.appendMarkdown('#### ');
    md.appendText(`#${item.id}: ${fields['System.Title'] ?? ''}`);
    md.appendMarkdown('\n\n');
    const rows: Array<[string, unknown]> = [
        ['Type', fields['System.WorkItemType']],
        ['State', fields['System.State']],
        ['Assigned to', fields['System.AssignedTo']?.displayName || 'Unassigned'],
        ['Priority', fields['Microsoft.VSTS.Common.Priority']],
        ['Iteration', fields['System.IterationPath']],
        ['Tags', fields['System.Tags']],
        ['Created', formatDate(fields['System.CreatedDate'])],
        ['Updated', formatDate(fields['System.ChangedDate'])]
    ];
    for (const [name, value] of rows) {
        if (value !== undefined && value !== null && value !== '') {
            md.appendMarkdown(`**${name}:** `);
            md.appendText(String(value));
            md.appendMarkdown('  \n');
        }
    }
    return md;
}

function formatDate(value: unknown): string | undefined {
    if (!value) {
        return undefined;
    }
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? undefined : date.toLocaleDateString();
}

/** A codicon for a state name, for views that don't know the state's category. */
export function stateIcon(state: string | undefined): vscode.ThemeIcon {
    const s = (state || '').toLowerCase();
    if (['closed', 'done', 'resolved', 'completed'].includes(s)) {
        return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    }
    if (['removed', 'cut'].includes(s)) {
        return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    }
    if (['active', 'in progress', 'committed', 'doing'].includes(s)) {
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    }
    return new vscode.ThemeIcon('circle-outline');
}

/** True when the work item's relations include a child link. */
export function hasChildLinks(item: { relations?: Array<{ rel?: string }> }): boolean {
    return item.relations?.some(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward') ?? false;
}

/** Fills in a tree row for a work item. The row keeps its own collapsible state. */
export function decorateWorkItemRow<T extends vscode.TreeItem>(
    treeItem: T,
    item: { id: number; fields?: Record<string, any> },
    options: WorkItemRowOptions = {}
): T {
    const fields = item.fields || {};
    // Written through the base type: some views' subclasses declare label and command readonly
    const row: vscode.TreeItem = treeItem;
    row.label = `#${item.id}: ${fields['System.Title'] ?? ''}`;
    row.description = options.description
        ?? [fields['System.WorkItemType'], fields['System.State']].filter(Boolean).join(' • ');
    row.tooltip = workItemTooltip(item);
    row.iconPath = options.iconPath ?? stateIcon(fields['System.State']);
    row.contextValue = 'workItem';
    row.command = openWorkItemCommand(item.id);
    return treeItem;
}
