# Contributing to ADO Boards

Thanks for helping out. ADO Boards is a community-maintained fork of
[Azure DevOps Boards](https://github.com/dammyboss/azure-devops-vsce) by Damilola Onadeinde.

## Getting started

Requires Node.js 22 and VS Code 1.101 or later.

```bash
npm ci
npm run build      # bundle to dist/ (use `npm run watch` while developing)
```

Open the folder in VS Code and install the recommended extensions when prompted
(`.vscode/extensions.json`). Then:

- **F5** (*Run Extension*) starts the `watch` task and opens an Extension Development Host.
  *Run Extension (clean profile)* does the same with other extensions disabled.
- **Ctrl+Shift+B** starts the `watch` task on its own (esbuild bundle plus type-check).
- **Testing view**: integration tests (`src/test/integration`, run inside VS Code via
  `.vscode-test.mjs`) appear through the Extension Test Runner, and unit tests (`src/test/unit`,
  plain `node:test`) through the Node.js Test Runner. You can run or debug single tests from
  either, and the Extension Test Runner can also run with coverage.
  Run the `watch-tests` task first so `dist/` and `out/` stay current while you edit.
- **Run and Debug**: *Extension Tests* and *Unit Tests* launch the same suites under the debugger,
  so breakpoints in `src/` work.

## Before opening a pull request

```bash
npm run lint               # must report 0 errors
npm test                   # unit tests
npm run test:integration   # smoke tests inside VS Code (on Linux: xvfb-run -a npm run test:integration)
npm run test:coverage      # optional: integration tests with a coverage report in coverage/
```

CI runs the same checks on every pull request.

- Keep pull requests focused on one change, and add a line to the `Unreleased` section of
  `CHANGELOG.md` for anything user-visible.
- Webviews render data written by other people in the Azure DevOps project. Never put work item
  data into HTML without the helpers in `src/utils/webviewSecurity.ts`: `escapeHtml` for text and
  attributes, `jsArg` for values passed to inline handlers, `serializeForScript` for data in
  `<script>`, and `sanitizeRichText` for HTML fields.
- Add unit tests in `src/test/unit` for logic that doesn't need VS Code.

## Releasing (maintainers)

1. Update `version` in `package.json` and move the `Unreleased` CHANGELOG entry under that version
   with today's date, as `## [X.Y.Z] - YYYY-MM-DD` (the Release workflow checks for this).
2. Update the What's New panel (`src/views/whatsNewPanel.ts`) and its `LATEST_ANNOUNCEMENT_ID`.
3. Merge to `main`, then push a tag `vX.Y.Z`. The Release workflow builds the VSIX, creates the
   GitHub Release and publishes to the Marketplace (see `.github/workflows/release.yml` for setup).
   If a publish step fails, re-run the workflow: it reuses the existing GitHub Release and its VSIX.
   To make a GitHub Release without publishing to the Marketplace, run the Release workflow from
   the Actions tab on `main` with the tag name and "marketplace" unticked; run it again with it
   ticked to publish that same VSIX later.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
