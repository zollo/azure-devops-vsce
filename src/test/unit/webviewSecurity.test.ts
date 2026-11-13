import './vscodeMock';
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { escapeHtml, jsArg, safeCssColor, sanitizeRichText, serializeForScript } from '../../utils/webviewSecurity';

/** Decode the HTML entities escapeHtml produces, the way a browser decodes an attribute value. */
function decodeAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

test('escapeHtml escapes markup and both quote styles', () => {
    assert.equal(escapeHtml(`<a href="x">O'Brien & co</a>`), '&lt;a href=&quot;x&quot;&gt;O&#039;Brien &amp; co&lt;/a&gt;');
    assert.equal(escapeHtml(undefined), '');
});

test('jsArg yields exactly one JS string literal after attribute decoding', () => {
    const hostile = `x', alert(1), '"); alert(2); ("`;
    const decoded = decodeAttribute(jsArg(hostile));
    assert.equal(JSON.parse(decoded), hostile);
    assert.ok(!jsArg(hostile).includes(`'`), 'no raw single quote');
    assert.ok(!jsArg(hostile).includes(`"`), 'no raw double quote');
});

test('serializeForScript cannot close a script element', () => {
    const value = { title: '</script><img src=x onerror=alert(1)>', sep: ' ' };
    const out = serializeForScript(value);
    assert.ok(!out.includes('<'));
    assert.ok(!out.includes(' '));
    assert.deepEqual(JSON.parse(out), value);
    assert.equal(serializeForScript(undefined), 'null');
});

test('safeCssColor accepts plain colors and rejects anything else', () => {
    for (const ok of ['#fff', '#A1B2C3', 'rgb(1, 2, 3)', 'rgba(0,0,0,0.5)', 'red', 'var(--vscode-foreground)']) {
        assert.equal(safeCssColor(ok), ok);
    }
    for (const bad of ['red;background:url(x)', 'expression(alert(1))', '#fff" onmouseover="x', 'url(https://x)']) {
        assert.equal(safeCssColor(bad, 'FALLBACK'), 'FALLBACK');
    }
});

test('sanitizeRichText keeps formatting and removes script vectors', () => {
    const html = sanitizeRichText(
        '<div style="color: red; position: fixed">Hi <b>there</b>' +
        '<img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a>' +
        '<script>alert(1)</script><a href="https://dev.azure.com">ok</a><iframe src="https://x"></iframe></div>'
    );
    assert.match(html, /<b>there<\/b>/);
    assert.match(html, /href="https:\/\/dev\.azure\.com"/);
    assert.match(html, /style="color:red"/);
    for (const banned of ['onerror', 'javascript:', '<script', '<iframe', 'position']) {
        assert.ok(!html.includes(banned), `should not contain ${banned}`);
    }
    assert.equal(sanitizeRichText(undefined), '');
});
