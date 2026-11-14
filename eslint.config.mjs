// ESLint 9 flat config with typescript-eslint.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    { ignores: ['out/**', 'dist/**', 'node_modules/**', '.vscode-test/**', 'scripts/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            globals: { ...globals.node }
        },
        rules: {
            // The existing code base uses `any` for Azure DevOps API payloads extensively.
            // Keep it visible as a warning rather than blocking; tighten as types are added.
            '@typescript-eslint/no-explicit-any': 'warn',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
            '@typescript-eslint/no-require-imports': 'warn',
            curly: 'warn',
            eqeqeq: ['warn', 'smart'],
            'no-throw-literal': 'warn'
        }
    },
    {
        // Scripts that run inside webviews.
        files: ['media/**/*.js'],
        languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: 'readonly' } },
        rules: { '@typescript-eslint/no-require-imports': 'off' }
    },
    {
        files: ['*.js', '*.mjs'],
        languageOptions: { globals: { ...globals.node } },
        rules: { '@typescript-eslint/no-require-imports': 'off' }
    }
);
