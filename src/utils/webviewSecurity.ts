import * as crypto from 'crypto';
import * as vscode from 'vscode';
import sanitizeHtml from 'sanitize-html';

/**
 * Helpers for safely putting Azure DevOps data (titles, names, rich text) into webview HTML.
 * Work item content is written by anyone with access to the project, so it must never be able
 * to run script inside a webview, which can post messages back to the extension.
 */

/** Escape text for HTML element content or a quoted attribute value. */
export function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Encode a value as a JavaScript (and JSON) string literal for use inside an attribute, such as
 * an inline event handler, onclick="doThing(${jsArg(name)})", or an argument list,
 * data-click-args='[${jsArg(name)}]'. The quotes are included.
 * HTML-escaping alone is not enough there: the browser decodes entities in the attribute
 * before running it as JavaScript, so a ' in the data would end the string.
 */
export function jsArg(value: unknown): string {
    return escapeHtml(JSON.stringify(String(value ?? '')));
}

/**
 * Serialize a value for embedding inside an inline <script> block, e.g.
 * const items = ${serializeForScript(items)};
 * Plain JSON.stringify would let a string containing "</script>" close the script element.
 */
export function serializeForScript(value: unknown): string {
    return (JSON.stringify(value) ?? 'null')
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|(rgb|rgba|hsl|hsla)\([0-9.,%\s]+\)|[a-zA-Z]{1,30}|var\(--[a-zA-Z0-9-]+\))$/;

/** Return the color if it is a plain CSS color, otherwise the fallback. Used for colors that come from Azure DevOps settings. */
export function safeCssColor(value: unknown, fallback = ''): string {
    const color = String(value ?? '').trim();
    return SAFE_COLOR.test(color) ? color : fallback;
}

/**
 * Sanitize rich text HTML from Azure DevOps (descriptions, acceptance criteria, comments)
 * before rendering it in a webview. Keeps formatting, links and images; drops scripts,
 * event handlers, and non-http(s) URLs.
 */
export function sanitizeRichText(html: string | undefined | null): string {
    if (!html) {
        return '';
    }
    return sanitizeHtml(html, {
        allowedTags: [
            'p', 'br', 'hr', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'sub', 'sup',
            'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img',
            'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'font'
        ],
        allowedAttributes: {
            a: ['href', 'title', 'data-vss-mention', 'target', 'rel'],
            img: ['src', 'alt', 'title', 'width', 'height'],
            font: ['color'],
            td: ['colspan', 'rowspan'],
            th: ['colspan', 'rowspan'],
            '*': ['class', 'style']
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: { img: ['http', 'https', 'data'] },
        allowedStyles: {
            '*': {
                color: [/^[#a-zA-Z0-9(),.\s%-]+$/],
                'background-color': [/^[#a-zA-Z0-9(),.\s%-]+$/],
                'text-align': [/^(left|right|center|justify)$/],
                'font-weight': [/^(normal|bold|[1-9]00)$/],
                'font-style': [/^(normal|italic)$/],
                'text-decoration': [/^[a-z\s-]+$/],
                'padding-left': [/^\d+(px|em)$/],
                'margin-left': [/^\d+(px|em)$/]
            }
        }
    });
}

/** A random value for a Content-Security-Policy script nonce. Use a new one for every page. */
export function getNonce(): string {
    return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Content-Security-Policy for the extension's webviews. Blocks all remote scripts, frames and
 * network requests; images may load over https (avatars, attachments) and from the extension.
 *
 * With a nonce, only scripts carrying that nonce run: no inline event handlers and no injected
 * script tags, so work item content that slips past escaping still can't run. Pages that still
 * use inline event handlers call it without one, which allows inline script.
 */
export function webviewCsp(webview: vscode.Webview, nonce?: string): string {
    return [
        "default-src 'none'",
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        nonce ? `script-src 'nonce-${nonce}'` : `script-src ${webview.cspSource} 'unsafe-inline'`
    ].join('; ') + ';';
}
