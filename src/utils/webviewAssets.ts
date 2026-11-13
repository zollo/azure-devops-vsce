import * as vscode from 'vscode';

/**
 * Third-party files the webviews load by path. esbuild.js copies them from node_modules
 * into dist/vendor at build time, because node_modules is not shipped in the VSIX.
 */
export function vendorAssetUri(webview: vscode.Webview, extensionUri: vscode.Uri, ...segments: string[]): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'vendor', ...segments));
}
