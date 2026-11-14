// Conventional Commits (https://www.conventionalcommits.org), checked in CI on pull request
// titles and commits, and locally by .githooks/commit-msg (npm run hooks:install).
// The type decides the next version: fix -> patch, feat -> minor, "!" or BREAKING CHANGE -> major
// (minor while the version is 0.x). See release-please-config.json.
export default {
    extends: ['@commitlint/config-conventional'],
    rules: {
        // Allow "feat: Add ..." as well as "feat: add ...": subjects become CHANGELOG lines.
        'subject-case': [0],
        // Dependabot and release notes put long URLs in bodies and footers.
        'body-max-line-length': [0],
        'footer-max-line-length': [0]
    }
};
