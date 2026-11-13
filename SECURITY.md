# Security Policy

## Supported versions

Only the latest release of ADO Boards on the VS Code Marketplace receives security fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** ([direct link](https://github.com/zollo/azure-devops-vsce/security/advisories/new)).
Include the steps to reproduce, the affected version, and the impact you expect.

You should get a first response within 7 days. Once a fix is released, the advisory will be
published with credit to you unless you prefer to stay anonymous.

## Scope

Of particular interest:

- Work item content (titles, descriptions, comments, tags, names) that can run script in the
  extension's webviews
- Exposure of Personal Access Tokens or Microsoft account tokens
- Requests sent anywhere other than your Azure DevOps organization

Vulnerabilities in Azure DevOps itself should be reported to Microsoft through the
[Microsoft Security Response Center](https://msrc.microsoft.com/).
