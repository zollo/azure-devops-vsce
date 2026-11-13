import { defineConfig } from '@vscode/test-cli';

// Integration tests run inside a real VS Code (downloaded by @vscode/test-electron).
// Uses the minimum supported version from package.json engines.
export default defineConfig({
    files: 'out/test/integration/**/*.test.js',
    version: '1.101.0',
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'tdd', timeout: 60000 }
});
