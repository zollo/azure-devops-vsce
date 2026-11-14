// Bundles the extension into dist/extension.js and copies the files the webviews load at runtime.
// Usage: node esbuild.js [--production] [--watch]
let esbuild;
try {
    esbuild = require('esbuild');
} catch {
    console.error('esbuild is not installed. Run `npm ci` in the repository folder first.');
    process.exit(1);
}
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Files the webviews load by path from the extension folder (see webviewAssets.ts).
const vendorFiles = [
    ['node_modules/quill/dist/quill.min.js', 'dist/vendor/quill/quill.min.js'],
    ['node_modules/quill/dist/quill.snow.css', 'dist/vendor/quill/quill.snow.css'],
    ['node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/vendor/codicons/codicon.ttf'],
    ['node_modules/@vscode/codicons/dist/codicon.css', 'dist/vendor/codicons/codicon.css']
];

function copyVendorFiles() {
    for (const [from, to] of vendorFiles) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    }
}

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
    name: 'problem-matcher',
    setup(build) {
        build.onStart(() => console.log('[watch] build started'));
        build.onEnd(result => {
            for (const { text, location } of result.errors) {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            }
            console.log('[watch] build finished');
        });
    }
};

async function main() {
    fs.rmSync('dist', { recursive: true, force: true });
    copyVendorFiles();

    const ctx = await esbuild.context({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node22',
        outfile: 'dist/extension.js',
        external: ['vscode'],
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: 'warning',
        plugins: watch ? [problemMatcherPlugin] : []
    });

    if (watch) {
        await ctx.watch();
    } else {
        await ctx.rebuild();
        await ctx.dispose();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
