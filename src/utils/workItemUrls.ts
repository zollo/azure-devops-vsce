/**
 * Extracts the work item ID from an Azure DevOps work item REST URL, as found in relation links.
 * Handles both URL styles:
 *   https://dev.azure.com/org/_apis/wit/workItems/123
 *   https://org.visualstudio.com/{project}/_apis/wit/workItems/123
 * Returns undefined when no ID can be found.
 */
export function extractWorkItemIdFromUrl(url: string | undefined | null): string | undefined {
    if (!url) {
        return undefined;
    }
    const match = url.match(/\/workitems\/(\d+)/i) || url.match(/\/(\d+)$/);
    return match?.[1];
}

/** The organization a URL belongs to, as "host/org" style key, or undefined. */
function organizationKey(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    if (host === 'dev.azure.com') {
        const org = url.pathname.split('/').filter(Boolean)[0];
        return org ? `azure:${org.toLowerCase()}` : undefined;
    }
    const legacy = host.match(/^([a-z0-9-]+)\.visualstudio\.com$/);
    if (legacy) {
        return `azure:${legacy[1]}`;
    }
    return undefined;
}

/**
 * True when `url` is an https URL on the same Azure DevOps organization as `organizationUrl`.
 * Treats dev.azure.com/{org} and {org}.visualstudio.com as the same organization; for other
 * hosts (Azure DevOps Server) the URL must share the organization URL's host and path.
 * Used before sending a request that carries the person's credentials to a URL from a webview.
 */
export function isOrganizationUrl(url: string | undefined | null, organizationUrl: string | undefined | null): boolean {
    if (!url || !organizationUrl) {
        return false;
    }
    let target: URL;
    let org: URL;
    try {
        target = new URL(url);
        org = new URL(organizationUrl);
    } catch {
        return false;
    }
    if (target.protocol !== org.protocol || (target.protocol !== 'https:' && target.protocol !== 'http:')) {
        return false;
    }
    if (target.username || target.password) {
        return false;
    }
    const targetKey = organizationKey(target);
    const orgKey = organizationKey(org);
    if (targetKey || orgKey) {
        return targetKey !== undefined && targetKey === orgKey;
    }
    const orgPath = org.pathname.replace(/\/+$/, '').toLowerCase();
    return target.host.toLowerCase() === org.host.toLowerCase()
        && (target.pathname.toLowerCase() === orgPath || target.pathname.toLowerCase().startsWith(orgPath + '/'));
}
