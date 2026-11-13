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
