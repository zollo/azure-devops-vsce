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
    /** How the column's values compare when the table is sorted by it. */
    sort: 'number' | 'text';
    /**
     * When the table is too narrow, columns are set aside in this order (lowest first) so the
     * title keeps its room. Columns without one always stay.
     */
    dropOrder?: number;
    /** A narrower form tried before any column is set aside (the assignee shows only an avatar). */
    compactTrack?: string;
    compactMinWidth?: number;
}

/** Width of the leading selection checkbox column, which is always shown. */
export const CHECKBOX_COLUMN_WIDTH = 32;

/** All columns, in display order. */
export const WORK_ITEM_COLUMNS: readonly WorkItemColumn[] = [
    { id: 'id', label: 'ID', track: '64px', minWidth: 64, defaultVisible: true, sort: 'number' },
    { id: 'type', label: 'Type', track: 'minmax(96px, 0.7fr)', minWidth: 96, defaultVisible: false, sort: 'text', dropOrder: 4 },
    { id: 'title', label: 'Title', track: 'minmax(160px, 3fr)', minWidth: 160, defaultVisible: true, required: true, sort: 'text' },
    { id: 'state', label: 'State', track: 'minmax(90px, 0.8fr)', minWidth: 90, defaultVisible: true, sort: 'text' },
    {
        id: 'assignedTo', label: 'Assigned to', track: 'minmax(110px, 1.1fr)', minWidth: 110, defaultVisible: true, sort: 'text',
        compactTrack: '56px', compactMinWidth: 56
    },
    { id: 'areaPath', label: 'Area path', track: 'minmax(90px, 1.1fr)', minWidth: 90, defaultVisible: true, sort: 'text', dropOrder: 3 },
    { id: 'iterationPath', label: 'Iteration path', track: 'minmax(90px, 1.1fr)', minWidth: 90, defaultVisible: false, sort: 'text', dropOrder: 2 },
    { id: 'tags', label: 'Tags', track: 'minmax(90px, 1.8fr)', minWidth: 90, defaultVisible: true, sort: 'text', dropOrder: 7 },
    { id: 'priority', label: 'Priority', track: '72px', minWidth: 72, defaultVisible: false, sort: 'number', dropOrder: 5 },
    { id: 'comments', label: 'Comments', track: '84px', minWidth: 84, defaultVisible: true, sort: 'number', dropOrder: 6 },
    { id: 'changedDate', label: 'Activity date', track: '140px', minWidth: 140, defaultVisible: true, sort: 'number', dropOrder: 8 },
    { id: 'createdDate', label: 'Created date', track: '140px', minWidth: 140, defaultVisible: false, sort: 'number', dropOrder: 1 }
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

export interface ColumnLayout {
    /** Columns on screen, in display order. */
    shown: string[];
    /** Chosen columns set aside because the table is too narrow. */
    setAside: string[];
    /** Shown columns drawn in their compact form. */
    compact: string[];
    /** CSS grid-template-columns, including the checkbox column. */
    tracks: string;
    /** Below this width the table scrolls sideways. */
    minWidth: number;
}

/**
 * Which of the chosen columns fit at a table width. When the chosen columns would leave the
 * title less than `titleRoom`, the assignee first shrinks to its avatar, then columns are set
 * aside by `dropOrder`. The webview runs this same function (serialized with toString), so it
 * must not refer to anything outside itself.
 */
export function layoutForWidth(
    columns: readonly WorkItemColumn[],
    visible: readonly string[],
    width: number,
    checkboxWidth: number,
    /** Room the title keeps before other columns give way, in px. */
    titleRoom = 280
): ColumnLayout {
    const chosen = new Set(visible);
    const active = columns.filter(c => c.required || chosen.has(c.id));
    const compact = new Set<string>();
    const setAside = new Set<string>();
    const needed = () => active.reduce((sum, c) => {
        if (setAside.has(c.id)) {
            return sum;
        }
        if (c.required) {
            return sum + Math.max(c.minWidth, titleRoom);
        }
        return sum + (compact.has(c.id) ? (c.compactMinWidth ?? c.minWidth) : c.minWidth);
    }, checkboxWidth);
    const shrinkable = active.filter(c => c.compactTrack);
    const droppable = active.filter(c => c.dropOrder !== undefined && !c.required)
        .sort((a, b) => (a.dropOrder as number) - (b.dropOrder as number));
    for (const col of shrinkable) {
        if (needed() > width) {
            compact.add(col.id);
        }
    }
    for (const col of droppable) {
        if (needed() > width) {
            setAside.add(col.id);
        }
    }
    const layout: ColumnLayout = { shown: [], setAside: [], compact: [], tracks: checkboxWidth + 'px', minWidth: checkboxWidth };
    for (const col of active) {
        if (setAside.has(col.id)) {
            layout.setAside.push(col.id);
            continue;
        }
        layout.shown.push(col.id);
        const small = compact.has(col.id);
        if (small) {
            layout.compact.push(col.id);
        }
        layout.tracks += ' ' + (small ? col.compactTrack : col.track);
        layout.minWidth += small ? (col.compactMinWidth ?? col.minWidth) : col.minWidth;
    }
    return layout;
}

/**
 * Order for two sort keys: numbers compare as numbers, text by locale with numbers inside text
 * in numeric order. Empty values go last whichever way the table is sorted. Serialized into
 * the webview like layoutForWidth, so it stays self-contained.
 */
export function compareSortKeys(a: string, b: string, kind: 'number' | 'text', descending: boolean): number {
    const aEmpty = a === '' || a === undefined || a === null;
    const bEmpty = b === '' || b === undefined || b === null;
    if (aEmpty || bEmpty) {
        return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
    }
    const order = kind === 'number'
        ? Number(a) - Number(b)
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
    return descending ? -order : order;
}

/** CSS grid-template-columns for the given visible columns, including the checkbox column. */
export function gridTemplateFor(visible: readonly WorkItemColumnId[]): string {
    return layoutForWidth(WORK_ITEM_COLUMNS, visible, Infinity, CHECKBOX_COLUMN_WIDTH).tracks;
}

/** Minimum table width for the given visible columns; below this the table scrolls sideways. */
export function minTableWidthFor(visible: readonly WorkItemColumnId[]): number {
    return layoutForWidth(WORK_ITEM_COLUMNS, visible, Infinity, CHECKBOX_COLUMN_WIDTH).minWidth;
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
        `<th role="columnheader" data-col="${c.id}" aria-sort="none">`
        + `<button type="button" class="sort-btn" data-sort-col="${c.id}" title="Sort by ${escapeHtml(c.label)}">`
        + (c.compactTrack ? `<span class="codicon codicon-account compact-label" aria-hidden="true"></span>` : '')
        + `<span class="col-label">${escapeHtml(c.label)}</span>`
        + `<span class="codicon sort-icon" aria-hidden="true"></span></button></th>`
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
    const timeKey = (value: unknown) => {
        const time = value ? new Date(String(value)).getTime() : NaN;
        return isNaN(time) ? '' : String(time);
    };
    // What the table sorts each column by, read from data-sort on the cell
    const sortKeys: Record<WorkItemColumnId, string> = {
        id: String(id),
        type,
        title,
        state,
        assignedTo: assignedTo?.displayName ? displayName : '',
        areaPath,
        iterationPath,
        tags: tags.join(', '),
        priority: priority === undefined || priority === null || priority === '' ? '' : String(priority),
        comments: String(commentCount),
        changedDate: timeKey(fields['System.ChangedDate']),
        createdDate: timeKey(fields['System.CreatedDate'])
    };

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
        + WORK_ITEM_COLUMN_IDS.map(c => cells[c].replace(/^<td /, `<td data-sort="${e(sortKeys[c])}" `)).join('')
        + `</tr>`;
}

/** CSS that hides a column's cells when the table carries the matching hide-col-* class. */
export function columnVisibilityCss(tableSelector: string): string {
    return WORK_ITEM_COLUMN_IDS
        .map(id => `${tableSelector}.hide-col-${id} [data-col="${id}"] { display: none; }`)
        .join('\n');
}
