import './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    CHECKBOX_COLUMN_WIDTH,
    DEFAULT_WORK_ITEM_COLUMNS,
    WORK_ITEM_COLUMNS,
    WORK_ITEM_COLUMN_IDS,
    columnVisibilityCss,
    compareSortKeys,
    formatDateCompact,
    layoutForWidth,
    gridTemplateFor,
    minTableWidthFor,
    renderHeaderRow,
    renderWorkItemRow,
    resolveVisibleColumns,
    splitTags
} from '../../views/workItemsColumns';

const ctx = {
    typeIconHtml: (type: string) => `<img alt="${type}">`,
    avatarHtml: (_name: string, initials: string) => initials
};

function cellsOf(html: string): string[] {
    return [...html.matchAll(/<td[^>]*data-col="([^"]+)"/g)].map(m => m[1]);
}

test('defaults match the columns the view showed before columns were configurable', () => {
    assert.deepEqual([...DEFAULT_WORK_ITEM_COLUMNS], ['id', 'title', 'state', 'assignedTo', 'areaPath', 'tags', 'comments', 'changedDate']);
});

test('the package.json setting lists every column and the same defaults', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const setting = pkg.contributes.configuration.properties['azureDevOps.workItemsView.columns'];
    assert.ok(setting, 'setting is contributed');
    assert.deepEqual(setting.items.enum, [...WORK_ITEM_COLUMN_IDS]);
    assert.equal(setting.items.enumDescriptions.length, WORK_ITEM_COLUMN_IDS.length);
    assert.deepEqual(setting.default, [...DEFAULT_WORK_ITEM_COLUMNS]);
});

test('resolveVisibleColumns falls back to defaults for unusable values', () => {
    for (const value of [undefined, null, 'id', {}, [], ['nope'], [42]]) {
        assert.deepEqual(resolveVisibleColumns(value), [...DEFAULT_WORK_ITEM_COLUMNS], JSON.stringify(value));
    }
});

test('resolveVisibleColumns keeps display order, drops unknowns and duplicates, and always includes Title', () => {
    assert.deepEqual(resolveVisibleColumns(['tags', 'id', 'bogus', 'id', 'priority']), ['id', 'title', 'tags', 'priority']);
    assert.deepEqual(resolveVisibleColumns(['state']), ['title', 'state']);
});

test('gridTemplateFor has one track per visible column plus the checkbox column', () => {
    assert.equal(gridTemplateFor(['id', 'title']), `${CHECKBOX_COLUMN_WIDTH}px 64px minmax(160px, 3fr)`);
    const all = gridTemplateFor(WORK_ITEM_COLUMN_IDS);
    assert.equal(all.split(/ (?![^(]*\))/).length, WORK_ITEM_COLUMNS.length + 1);
});

test('flexible columns grow with fr tracks so the table fills the available width', () => {
    const title = WORK_ITEM_COLUMNS.find(c => c.id === 'title')!;
    assert.match(title.track, /^minmax\(160px, \d+(\.\d+)?fr\)$/);
    for (const column of WORK_ITEM_COLUMNS) {
        const min = column.track.match(/^minmax\((\d+)px,/)?.[1] ?? column.track.match(/^(\d+)px$/)?.[1];
        assert.equal(Number(min), column.minWidth, `${column.id} track and minWidth agree`);
    }
});

test('minTableWidthFor sums the minimum widths of visible columns', () => {
    assert.equal(minTableWidthFor(['id', 'title']), CHECKBOX_COLUMN_WIDTH + 64 + 160);
});

test('splitTags trims and drops empty entries', () => {
    assert.deepEqual(splitTags(' a; b ;;c; '), ['a', 'b', 'c']);
    assert.deepEqual(splitTags(undefined), []);
});

test('formatDateCompact drops seconds from the cell and keeps them in the tooltip', () => {
    const { short, full } = formatDateCompact('2026-09-21T12:33:35Z');
    assert.ok(!/:35/.test(short), short);
    assert.match(full, /:35/);
    assert.deepEqual(formatDateCompact('not a date'), { short: '-', full: '' });
    assert.deepEqual(formatDateCompact(undefined), { short: '-', full: '' });
});

test('header and rows render one cell per column in the same order', () => {
    const header = [...renderHeaderRow().matchAll(/<th[^>]*data-col="([^"]+)"/g)].map(m => m[1]);
    const row = cellsOf(renderWorkItemRow({ id: 4, fields: { 'System.Title': 'x' } }, ctx));
    assert.deepEqual(header, ['select', ...WORK_ITEM_COLUMN_IDS]);
    assert.deepEqual(row, header);
});

test('rows put overflowing values in tooltips and render tags inline with a +N slot', () => {
    const html = renderWorkItemRow({
        id: 7,
        fields: {
            'System.Title': 'WAF Problems - My Fancy App',
            'System.WorkItemType': 'Issue',
            'System.State': 'To Do',
            'System.AreaPath': 'dev-test\\InfoSecTeam1\\AdhocTickets',
            'System.Tags': 'azuregos; azuregos-portal:product-architecture',
            'System.CommentCount': 1,
            'System.ChangedDate': '2026-09-28T10:43:46Z'
        }
    }, ctx);
    assert.ok(!/\n/.test(html), 'row markup has no line breaks');
    assert.match(html, /data-col="title" class="title-cell" title="WAF Problems - My Fancy App"/);
    assert.match(html, /data-col="areaPath" class="clickable-cell" title="dev-test\\InfoSecTeam1\\AdhocTickets"/);
    assert.match(html, /data-col="tags" class="clickable-cell" title="azuregos, azuregos-portal:product-architecture"/);
    assert.equal((html.match(/class="tag"/g) || []).length, 2);
    assert.match(html, /<span class="tag tag-more" hidden><\/span>/);
    assert.match(html, /title="1 comment"/);
    assert.match(html, /Unassigned/);
});

test('rows escape work item data', () => {
    const html = renderWorkItemRow({
        id: 1,
        fields: {
            'System.Title': '<img src=x onerror=alert(1)>',
            'System.Tags': '"><script>',
            'System.State': 'x" onmouseover="y',
            'System.AssignedTo': { displayName: '<b>Eve</b>' }
        }
    }, ctx);
    assert.ok(!html.includes('<img src=x'), 'title escaped');
    assert.ok(!html.includes('<script>'), 'tags escaped');
    assert.ok(!html.includes('" onmouseover="'), 'state escaped');
    assert.ok(!html.includes('<b>Eve</b>'), 'assignee escaped');
});

test('columnVisibilityCss has a hide rule for every column', () => {
    const css = columnVisibilityCss('.t');
    for (const id of WORK_ITEM_COLUMN_IDS) {
        assert.ok(css.includes(`.t.hide-col-${id} [data-col="${id}"] { display: none; }`), id);
    }
});

test('narrow tables shrink the assignee, then set columns aside, but always keep the title', () => {
    const chosen = [...DEFAULT_WORK_ITEM_COLUMNS];
    const wide = layoutForWidth(WORK_ITEM_COLUMNS, chosen, 1400, CHECKBOX_COLUMN_WIDTH);
    assert.deepEqual(wide.shown, chosen);
    assert.deepEqual([...wide.setAside, ...wide.compact], []);
    const medium = layoutForWidth(WORK_ITEM_COLUMNS, chosen, 900, CHECKBOX_COLUMN_WIDTH);
    assert.deepEqual(medium.compact, ['assignedTo']);
    assert.deepEqual(medium.setAside, ['areaPath']);
    assert.match(medium.tracks, / 56px /);
    for (const width of [1000, 800, 640, 500, 420]) {
        const layout = layoutForWidth(WORK_ITEM_COLUMNS, WORK_ITEM_COLUMN_IDS, width, CHECKBOX_COLUMN_WIDTH);
        assert.ok(layout.minWidth <= width, `everything chosen still fits at ${width}px (${layout.minWidth}px)`);
        assert.ok(layout.shown.includes('title'));
    }
    const narrow = layoutForWidth(WORK_ITEM_COLUMNS, chosen, 420, CHECKBOX_COLUMN_WIDTH);
    assert.deepEqual(narrow.shown, ['id', 'title', 'state', 'assignedTo']);
});

test('the layout and sort functions run on their own, as the webview loads them', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const layout = new Function(`return (${layoutForWidth.toString()})`)();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const compare = new Function(`return (${compareSortKeys.toString()})`)();
    assert.deepEqual(layout(WORK_ITEM_COLUMNS, ['id', 'title'], 300, 32).shown, ['id', 'title']);
    assert.equal(compare('2', '10', 'number', false) < 0, true);
});

test('sort keys compare numbers, text naturally, and keep empty values last', () => {
    const sorted = (keys: string[], kind: 'number' | 'text', desc = false) =>
        [...keys].sort((a, b) => compareSortKeys(a, b, kind, desc));
    assert.deepEqual(sorted(['10', '', '2', '1'], 'number'), ['1', '2', '10', '']);
    assert.deepEqual(sorted(['10', '', '2', '1'], 'number', true), ['10', '2', '1', '']);
    assert.deepEqual(sorted(['Sprint 10', 'sprint 2', 'Alpha'], 'text'), ['Alpha', 'sprint 2', 'Sprint 10']);
});

test('cells carry the value the table sorts by', () => {
    const html = renderWorkItemRow({
        id: 7,
        fields: { 'System.Title': 'T', 'System.ChangedDate': '2026-11-01T10:00:00Z', 'Microsoft.VSTS.Common.Priority': 2 }
    }, ctx);
    assert.match(html, /data-sort="7"[^>]*data-col="id"/);
    assert.match(html, new RegExp(`data-sort="${Date.parse('2026-11-01T10:00:00Z')}"[^>]*data-col="changedDate"`));
    assert.match(html, /data-sort=""[^>]*data-col="assignedTo"/);
    assert.match(html, /data-sort="2"[^>]*data-col="priority"/);
    assert.match(renderHeaderRow(), /<th role="columnheader" data-col="title" aria-sort="none"><button type="button" class="sort-btn" data-sort-col="title"/);
});
