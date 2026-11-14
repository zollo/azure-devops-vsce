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

- Keep pull requests focused on one change.
- Webviews render data written by other people in the Azure DevOps project. Never put work item
  data into HTML without the helpers in `src/utils/webviewSecurity.ts`: `escapeHtml` for text and
  attributes, `jsArg` for values passed to inline handlers, `serializeForScript` for data in
  `<script>`, and `sanitizeRichText` for HTML fields.
- Add unit tests in `src/test/unit` for logic that doesn't need VS Code.

## Commit messages

Pull request titles and commit messages must follow
[Conventional Commits](https://www.conventionalcommits.org); CI checks both
(`commitlint.config.mjs`). They decide the next version and become the CHANGELOG, so write
the subject for users:

| Type | Example | Release |
| --- | --- | --- |
| `feat` | `feat(boards): add swimlane filter` | minor (listed under Added) |
| `fix` | `fix: keep column order after refresh` | patch (listed under Fixed) |
| `perf` | `perf: cache iteration list` | patch (listed under Changed) |
| `docs`, `refactor`, `test`, `build`, `ci`, `chore` | `ci: cache npm` | none, not listed |
| `!` after the type, or a `BREAKING CHANGE:` footer | `feat!: drop VS Code 1.101` | major (minor while 0.x) |

To check messages locally before pushing, run `npm run hooks:install` once (it points
`core.hooksPath` at `.githooks`).

## Releasing (maintainers)

Releases are automated with [release-please](https://github.com/googleapis/release-please).

1. Each push to `main` updates a release pull request titled `chore: release X.Y.Z`, which
   bumps `package.json` and adds the merged commits to `CHANGELOG.md`. Edit the CHANGELOG on
   that branch if you want to reword entries; release-please keeps your edits only until the
   next push to `main`, so make final edits just before merging.
2. Before merging it, update the What's New panel (`src/views/whatsNewPanel.ts`) and its
   `LATEST_ANNOUNCEMENT_ID` in a normal pull request if the release deserves an announcement.
3. Merge the release pull request. That tags `vX.Y.Z`, creates the GitHub Release with the
   changelog notes, and starts the Release workflow, which builds and tests the VSIX and
   attaches it. The Marketplace is skipped unless the repository variable
   `MARKETPLACE_PUBLISH` is `true`; to publish a release later, run the Release workflow from
   the Actions tab on `main` with the tag and "marketplace" ticked.

To force a specific version, add a commit with a `Release-As: X.Y.Z` footer.

### Manual release (fallback)

1. Update `version` in `package.json` and `.release-please-manifest.json`, and add a CHANGELOG
   entry dated today, as `## [X.Y.Z] - YYYY-MM-DD` (the Release workflow checks for this).
2. Update the What's New panel (`src/views/whatsNewPanel.ts`) and its `LATEST_ANNOUNCEMENT_ID`.
3. Merge to `main`, then push a tag `vX.Y.Z`. The Release workflow builds the VSIX, creates the
   GitHub Release and publishes to the Marketplace (see `.github/workflows/release.yml` for setup).
   If a publish step fails, re-run the workflow: it reuses the existing GitHub Release and its VSIX.
   To make a GitHub Release without publishing to the Marketplace, run the Release workflow from
   the Actions tab on `main` with the tag name and "marketplace" unticked; run it again with it
   ticked to publish that same VSIX later.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
