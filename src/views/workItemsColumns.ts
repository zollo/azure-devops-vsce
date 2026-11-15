import { escapeHtml } from '../utils/webviewSecurity';

/**
 * Column model for the Work Items list webview: which columns exist, how wide they may get,
 * which ones show by default, and how each cell renders. Kept free of the `vscode` module so
 * the layout and rendering rules can be unit tested in plain Node.
 */

export type WorkItemColumnId =
    | 'id'
    | 'type'
    | 'title'
    | 'state'
    | 'assignedTo'
    | 'areaPath'
    | 'iterationPath'
    | 'tags'
    | 'priority'
    | 'comments'
    | 'changedDate'
    | 'createdDate';

export interface WorkItemColumn {
    id: WorkItemColumnId;
    label: string;
    /** CSS grid track for this column. Flexible columns use minmax(<min>px, <n>fr). */
    track: string;
    /** Narrowest the column gets before the table scrolls sideways, in px. */
    minWidth: number;
    defaultVisible: boolean;
    /** Required columns are always shown and cannot be turned off. */
    required?: boolean;
}

/** Width of the leading selection checkbox column, which is always shown. */
export const CHECKBOX_COLUMN_WIDTH = 32;

/** All columns, in display order. */
export const WORK_ITEM_COLUMNS: readonly WorkItemColumn[] = [
    { id: 'id', label: 'ID', track: '64px', minWidth: 64, defaultVisible: true },
    { id: 'type', label: 'Type', track: 'minmax(96px, 0.7fr)', minWidth: 96, defaultVisible: false },
    { id: 'title', label: 'Title', track: 'minmax(160px, 3fr)', minWidth: 160, defaultVisible: true, required: true },
    { id: 'state', label: 'State', track: 'minmax(90px, 0.8fr)', minWidth: 90, defaultVisible: true },
    { id: 'assignedTo', label: 'Assigned to', track: 'minmax(110px, 1.1fr)', minWidth: 110, defaultVisible: true },
    { id: 'areaPath', label: 'Area path', track: 'minmax(90px, 1.1fr)', minWidth: 90, defaultVisible: true },
    { id: 'iterationPath', label: 'Iteration path', track: 'minmax(90px, 1.1fr)', minWidth: 90, defaultVisible: false },
    { id: 'tags', label: 'Tags', track: 'minmax(90px, 1.8fr)', minWidth: 90, defaultVisible: true },
    { id: 'priority', label: 'Priority', track: '72px', minWidth: 72, defaultVisible: false },
    { id: 'comments', label: 'Comments', track: '84px', minWidth: 84, defaultVisible: true },
    { id: 'changedDate', label: 'Activity date', track: '140px', minWidth: 140, defaultVisible: true },
    { id: 'createdDate', label: 'Created date', track: '140px', minWidth: 140, defaultVisible: false }
];

export const WORK_ITEM_COLUMN_IDS: readonly WorkItemColumnId[] = WORK_ITEM_COLUMNS.map(c => c.id);

export const DEFAULT_WORK_ITEM_COLUMNS: readonly WorkItemColumnId[] =
    WORK_ITEM_COLUMNS.filter(c => c.defaultVisible).map(c => c.id);

/**
 * Turn a saved setting value into the list of columns to show, in display order.
 * Unknown ids and duplicates are dropped, required columns are always included, and anything
 * that is not a usable list falls back to the defaults.
 */
export function resolveVisibleColumns(saved: unknown): WorkItemColumnId[] {
    if (!Array.isArray(saved)) {
        return [...DEFAULT_WORK_ITEM_COLUMNS];
    }
    const wanted = new Set(saved.filter((v): v is string => typeof v === 'string'));
    const known = WORK_ITEM_COLUMNS.filter(c => wanted.has(c.id));
    if (known.length === 0) {
        return [...DEFAULT_WORK_ITEM_COLUMNS];
    }
    return WORK_ITEM_COLUMNS.filter(c => c.required || wanted.has(c.id)).map(c => c.id);
}

/** CSS grid-template-columns for the given visible columns, including the checkbox column. */
export function gridTemplateFor(visible: readonly WorkItemColumnId[]): string {
    const set = new Set(visible);
    return [`${CHECKBOX_COLUMN_WIDTH}px`, ...WORK_ITEM_COLUMNS.filter(c => set.has(c.id)).map(c => c.track)].join(' ');
}

/** Minimum table width for the given visible columns; below this the table scrolls sideways. */
export function minTableWidthFor(visible: readonly WorkItemColumnId[]): number {
    const set = new Set(visible);
    return WORK_ITEM_COLUMNS.filter(c => set.has(c.id)).reduce((sum, c) => sum + c.minWidth, CHECKBOX_COLUMN_WIDTH);
}

/** Split an Azure DevOps tag string ("a; b;c") into trimmed, non-empty tags. */
export function splitTags(raw: unknown): string[] {
    return String(raw ?? '')
        .split(';')
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

/** A short date for the cell and a full one for its tooltip. */
export function formatDateCompact(value: unknown): { short: string; full: string } {
    if (!value) {
        return { short: '-', full: '' };
    }
    const date = new Date(String(value));
    if (isNaN(date.getTime())) {
        return { short: '-', full: '' };
    }
    return {
        short: date.toLocaleString('en-US', {
            month: 'numeric', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
        }),
        full: date.toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true
        })
    };
}

/** Pieces of a row that need the webview (resource URIs), supplied by the panel. */
export interface WorkItemRowContext {
    typeIconHtml(type: string): string;
    avatarHtml(displayName: string, initials: string): string;
}

function initialsFor(displayName: string): string {
    if (displayName === 'Unassigned') {
        return '?';
    }
    return displayName.split(/\s+/).filter(Boolean).map(n => n[0]).join('').substring(0, 2);
}

/** Header row for the work items table. Every column is rendered; hidden ones are hidden by CSS. */
export function renderHeaderRow(): string {
    const cells = WORK_ITEM_COLUMNS.map(c =>
        `<th role="columnheader" data-col="${c.id}" title="${escapeHtml(c.label)}">${escapeHtml(c.label)}</th>`
    ).join('');
    return `<tr role="row"><th role="columnheader" class="checkbox-cell" data-col="select"><input type="checkbox" id="selectAllCheckbox" aria-label="Select all"></th>${cells}</tr>`;
}

/**
 * One single-line table row. Text that may overflow carries a title attribute so the full value
 * shows on hover; tags render inline and the webview script collapses the overflow into "+N".
 */
export function renderWorkItemRow(workItem: { id: number; fields: object }, ctx: WorkItemRowContext): string {
    const fields = (workItem.fields || {}) as Record<string, unknown>;
    const assignedTo = fields['System.AssignedTo'] as { displayName?: string } | undefined;
    const id = Number(workItem.id);
    const title = String(fields['System.Title'] ?? '');
    const type = String(fields['System.WorkItemType'] ?? '');
    const state = String(fields['System.State'] ?? '');
    const displayName = String(assignedTo?.displayName || 'Unassigned');
    const areaPath = String(fields['System.AreaPath'] ?? '');
    const iterationPath = String(fields['System.IterationPath'] ?? '');
    const rawTags = String(fields['System.Tags'] ?? '');
    const tags = splitTags(rawTags);
    const priority = fields['Microsoft.VSTS.Common.Priority'];
    const commentCount = Number(fields['System.CommentCount'] ?? 0) || 0;
    const changed = formatDateCompact(fields['System.ChangedDate']);
    const created = formatDateCompact(fields['System.CreatedDate']);
    const stateClass = state.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const e = escapeHtml;

    const cells: Record<WorkItemColumnId, string> = {
        id: `<td role="cell" data-col="id" class="clickable-cell"><span class="work-item-id">${id}</span></td>`,
        type: `<td role="cell" data-col="type" class="clickable-cell" title="${e(type)}">${e(type)}</td>`,
        title: `<td role="cell" data-col="title" class="title-cell" title="${e(title)}">`
            + `<span class="type-icon">${ctx.typeIconHtml(type)}</span><span class="title-text">${e(title)}</span></td>`,
        state: `<td role="cell" data-col="state" class="clickable-cell"><div class="cell-flex">`
            + `<span class="state-pill state-${e(stateClass)}" title="${e(state)}">${e(state)}</span>`
            + `<button class="action-btn cell-actions change-state-btn" data-id="${id}" title="Change state" aria-label="Change state"><span class="codicon codicon-ellipsis"></span></button>`
            + `</div></td>`,
        assignedTo: `<td role="cell" data-col="assignedTo" class="clickable-cell"><div class="cell-flex">`
            + `<span class="avatar">${ctx.avatarHtml(displayName, initialsFor(displayName))}</span>`
            + `<span class="truncate" title="${e(displayName)}">${e(displayName)}</span>`
            + `<button class="action-btn cell-actions change-assignee-btn" data-id="${id}" title="Change assignee" aria-label="Change assignee"><span class="codicon codicon-ellipsis"></span></button>`
            + `</div></td>`,
        areaPath: `<td role="cell" data-col="areaPath" class="clickable-cell" title="${e(areaPath)}">${e(areaPath)}</td>`,
        iterationPath: `<td role="cell" data-col="iterationPath" class="clickable-cell" title="${e(iterationPath)}">${e(iterationPath)}</td>`,
        tags: `<td role="cell" data-col="tags" class="clickable-cell"${tags.length ? ` title="${e(tags.join(', '))}"` : ''}><div class="tags">`
            + tags.map(t => `<span class="tag">${e(t)}</span>`).join('')
            + `<span class="tag tag-more" hidden></span></div></td>`,
        priority: `<td role="cell" data-col="priority" class="clickable-cell">${priority === undefined || priority === null ? '' : e(String(priority))}</td>`,
        comments: `<td role="cell" data-col="comments" class="clickable-cell" title="${commentCount} comment${commentCount === 1 ? '' : 's'}">`
            + `<span class="codicon codicon-comment"></span> <span class="comments-count">${commentCount}</span></td>`,
        changedDate: `<td role="cell" data-col="changedDate" class="clickable-cell"${changed.full ? ` title="${e(changed.full)}"` : ''}>${e(changed.short)}</td>`,
        createdDate: `<td role="cell" data-col="createdDate" class="clickable-cell"${created.full ? ` title="${e(created.full)}"` : ''}>${e(created.short)}</td>`
    };

    return `<tr role="row" data-id="${id}" data-type="${e(type)}" data-state="${e(state)}" data-assignee="${e(displayName)}" data-area="${e(areaPath)}" data-tags="${e(rawTags)}" class="work-item-row">`
        + `<td role="cell" class="checkbox-cell" data-col="select"><input type="checkbox" class="row-checkbox" data-id="${id}" aria-label="Select #${id}"></td>`
        + WORK_ITEM_COLUMN_IDS.map(c => cells[c]).join('')
        + `</tr>`;
}

/** CSS that hides a column's cells when the table carries the matching hide-col-* class. */
export function columnVisibilityCss(tableSelector: string): string {
    return WORK_ITEM_COLUMN_IDS
        .map(id => `${tableSelector}.hide-col-${id} [data-col="${id}"] { display: none; }`)
        .join('\n');
}
