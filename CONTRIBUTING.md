# Contributing to ADO Boards

Thanks for helping out. ADO Boards is a community-maintained fork of
[Azure DevOps Boards](https://github.com/dammyboss/azure-devops-vsce) by Damilola Onadeinde.

## Getting started

Requires Node.js 22 and VS Code 1.101 or later.

```bash
npm ci
npm run build      # bundle to dist/ (use `npm run watch` while developing)
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

## Before opening a pull request

```bash
npm run lint               # must report 0 errors
npm test                   # unit tests
npm run test:integration   # smoke tests inside VS Code (on Linux: xvfb-run -a npm run test:integration)
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
   with today's date.
2. Update the What's New panel (`src/views/whatsNewPanel.ts`) and its `LATEST_ANNOUNCEMENT_ID`.
3. Merge to `main`, then push a tag `vX.Y.Z`. The Release workflow builds the VSIX, creates the
   GitHub Release and publishes to the Marketplace (see `.github/workflows/release.yml` for setup).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
