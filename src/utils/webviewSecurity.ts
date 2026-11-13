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
 * Encode a value as a JavaScript string literal for use inside an inline event handler
 * attribute, e.g. onclick="doThing(${jsArg(name)})". The quotes are included.
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

/**
 * Content-Security-Policy for the extension's webviews. Blocks all remote scripts, frames and
 * network requests; images may load over https (avatars, attachments) and from the extension.
 * Inline scripts are allowed because the webviews use inline event handlers; the escaping
 * helpers above are what keep work item data from becoming script.
 */
export function webviewCsp(webview: vscode.Webview): string {
    return [
        "default-src 'none'",
        `img-src ${webview.cspSource} https: data:`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
        `script-src ${webview.cspSource} 'unsafe-inline'`
    ].join('; ') + ';';
}
