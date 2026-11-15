import * as vscode from 'vscode';
import { log } from '../utils/logger';
import { notifySuccess } from '../utils/notify';
import { vendorAssetUri } from '../utils/webviewAssets';
import { escapeHtml, getNonce, jsArg, safeCssColor, sanitizeRichText, serializeForScript, webviewCsp } from '../utils/webviewSecurity';
import { AuthenticationManager } from '../authentication/authenticationManager';
import { WorkItem } from '../models/workItem';
import { WorkItemEventManager } from '../events/workItemEventManager';
import { METADATA_TTL_MS, metadataKey, sharedMetadataCache } from '../utils/metadataCache';
import { azureDevOps } from '../services/azureDevOpsService';
import { isOrganizationUrl } from '../utils/workItemUrls';

interface IterationInfo {
    id: string;
    name: string;
    path: string;
    startDate?: string;
    finishDate?: string;
}

interface AreaInfo {
    id: string;
    name: string;
    path: string;
}

interface TeamMemberInfo {
    id: string;
    displayName: string;
    uniqueName: string;
}

export class WorkItemPanel {
    /** One panel per work item: opening an item that is already open reveals its tab. */
    private static readonly openPanels = new Map<number, WorkItemPanel>();

    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _workItem: WorkItem | null = null;
    private _disposables: vscode.Disposable[] = [];
    private authenticationManager: AuthenticationManager;
    private _iterations: IterationInfo[] = [];
    private _areas: AreaInfo[] = [];
    private _teamMembers: TeamMemberInfo[] = [];
    private _existingTags: string[] = [];
    private _availableStates: string[] = [];
    private eventManager = WorkItemEventManager.getInstance();
    private eventSubscription: vscode.Disposable | null = null;

    public static createOrShow(
        extensionUri: vscode.Uri,
        authenticationManager: AuthenticationManager,
        workItem: WorkItem
    ) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        const existing = WorkItemPanel.openPanels.get(workItem.id);
        if (existing) {
            // Just bring it forward: rebuilding the page would lose a comment being written.
            // The tab already refreshes itself when the item changes in another view.
            existing._panel.reveal(existing._panel.viewColumn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            `workItemDetails-${workItem.id}`,
            WorkItemPanel.panelTitle(workItem),
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        WorkItemPanel.openPanels.set(workItem.id, new WorkItemPanel(panel, extensionUri, authenticationManager, workItem));
    }

    /** Tab title: the id plus the start of the title, so several open items can be told apart. */
    private static panelTitle(workItem: WorkItem): string {
        const title = String(workItem.fields?.['System.Title'] ?? '').trim();
        if (!title) {
            return `#${workItem.id}`;
        }
        const short = title.length > 30 ? `${title.slice(0, 29).trimEnd()}\u2026` : title;
        return `#${workItem.id} ${short}`;
    }

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        authenticationManager: AuthenticationManager,
        workItem: WorkItem
    ) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this.authenticationManager = authenticationManager;
        this._workItem = workItem;

        // Subscribe to work item updates from other views
        this.eventSubscription = this.eventManager.onWorkItemUpdated((event) => {
            if (this._workItem && event.workItemId === this._workItem.id) {
                // Refresh this panel if it's showing the updated work item
                this.refreshWorkItem();
            }
        });

        this._update();

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'save':
                        await this.saveWorkItem(message.data);
                        break;
                    case 'changeState':
                        await this.changeState(message.state);
                        break;
                    case 'addComment':
                        await this.addComment(message.comment);
                        break;
                    case 'uploadImage':
                        await this.uploadImageForComment(message.imageData);
                        break;
                    case 'updateComment':
                        await this.updateComment(message.commentId, message.comment);
                        break;
                    case 'deleteComment':
                        await this.deleteComment(message.commentId);
                        break;
                    case 'refresh':
                        await this.refreshWorkItem();
                        break;
                    case 'openInBrowser':
                        this.openInBrowser();
                        break;
                    case 'assignToMe':
                        await this.assignToMe();
                        break;
                    case 'openLinkedItem':
                        if (message.id) {
                            vscode.commands.executeCommand('azureDevOps.viewWorkItemDetails', message.id);
                        }
                        break;
                    case 'updateField':
                        await this.updateField(message.field, message.value);
                        break;
                    case 'assignTo':
                        await this.assignTo(message.uniqueName);
                        break;
                    case 'uploadAttachment':
                        await this.uploadAttachment();
                        break;
                    case 'downloadAttachment':
                        await this.downloadAttachment(message.url, message.name);
                        break;
                    case 'deleteAttachment':
                        await this.deleteAttachment(message.url);
                        break;
                    case 'updateTags':
                        await this.updateTags(message.tags);
                        break;
                }
            },
            null,
            this._disposables
        );
    }

    public update(workItem: WorkItem) {
        this._workItem = workItem;
        this._panel.title = WorkItemPanel.panelTitle(workItem);
        this._update();
    }

    private async saveWorkItem(data: { title: string; description: string; acceptanceCriteria?: string }) {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const patchDocument: any[] = [];

            if (data.title !== this._workItem.fields['System.Title']) {
                patchDocument.push({
                    op: 'replace',
                    path: '/fields/System.Title',
                    value: data.title
                });
            }

            if (data.description !== this._workItem.fields['System.Description']) {
                patchDocument.push({
                    op: data.description ? 'replace' : 'remove',
                    path: '/fields/System.Description',
                    value: data.description
                });
            }

            if (data.acceptanceCriteria !== undefined && data.acceptanceCriteria !== (this._workItem.fields as any)['Microsoft.VSTS.Common.AcceptanceCriteria']) {
                patchDocument.push({
                    op: data.acceptanceCriteria ? 'replace' : 'remove',
                    path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria',
                    value: data.acceptanceCriteria
                });
            }

            if (patchDocument.length > 0) {
                await axiosInstance.patch(
                    `/_apis/wit/workitems/${this._workItem.id}`,
                    patchDocument,
                    { headers: { 'Content-Type': 'application/json-patch+json' } }
                );

                // Broadcast update to all views
                this.eventManager.notifyWorkItemUpdated({
                    workItemId: this._workItem.id,
                    updateType: 'update',
                    changes: patchDocument.map(p => ({
                        field: p.path,
                        newValue: p.value
                    }))
                });

                notifySuccess(`✓ Saved`);
                await this.refreshWorkItem();
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save: ${error}`);
        }
    }

    private async changeState(newState: string) {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [{ op: 'replace', path: '/fields/System.State', value: newState }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast state change to all views
            this.eventManager.notifyWorkItemUpdated({
                workItemId: this._workItem.id,
                updateType: 'state-change',
                changes: [{ field: '/fields/System.State', newValue: newState }]
            });

            notifySuccess(`State changed to ${newState}`);
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to change state: ${error}`);
        }
    }

    private async assignToMe() {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const currentUser = await this.authenticationManager.getCurrentUser();
            if (!currentUser?.uniqueName) return;

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [{ op: 'replace', path: '/fields/System.AssignedTo', value: currentUser.uniqueName }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast assignment to all views
            this.eventManager.notifyWorkItemUpdated({
                workItemId: this._workItem.id,
                updateType: 'assign',
                changes: [{ field: '/fields/System.AssignedTo', newValue: currentUser.uniqueName }]
            });

            notifySuccess('Assigned to you');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to assign: ${error}`);
        }
    }

    private async assignTo(uniqueName: string) {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const patchOp = uniqueName
                ? { op: 'replace', path: '/fields/System.AssignedTo', value: uniqueName }
                : { op: 'remove', path: '/fields/System.AssignedTo' };

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [patchOp],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            // Broadcast assignment to all views
            this.eventManager.notifyWorkItemUpdated({
                workItemId: this._workItem.id,
                updateType: 'assign',
                changes: [{ field: '/fields/System.AssignedTo', newValue: uniqueName }]
            });

            notifySuccess(uniqueName ? 'Assignee updated' : 'Assignee removed');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update assignee: ${error}`);
        }
    }

    private async updateField(field: string, value: any) {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const fieldPath = `/fields/${field}`;
            const patchOp = value !== null && value !== '' && value !== undefined
                ? { op: 'replace', path: fieldPath, value: value }
                : { op: 'remove', path: fieldPath };

            log.debug(`[WorkItemPanel] Updating field ${field} with value:`, value);
            log.debug('[WorkItemPanel] Patch operation:', JSON.stringify(patchOp));

            const response = await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [patchOp],
                {
                    headers: { 'Content-Type': 'application/json-patch+json' },
                    params: { 'api-version': '7.0' }
                }
            );

            log.debug('[WorkItemPanel] Update successful:', response.status);

            // Broadcast field update to all views
            this.eventManager.notifyWorkItemUpdated({
                workItemId: this._workItem.id,
                updateType: 'update',
                changes: [{ field: fieldPath, newValue: value }]
            });

            notifySuccess('Field updated');
            await this.refreshWorkItem();
        } catch (error: any) {
            log.error('[WorkItemPanel] Failed to update field:', error);
            log.error('[WorkItemPanel] Error response:', error.response?.data);
            log.error('[WorkItemPanel] Error status:', error.response?.status);
            vscode.window.showErrorMessage(`Failed to update field: ${error.response?.data?.message || error.message}`);
        }
    }

    private async updateTags(tags: string) {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const patchOp = tags && tags.trim()
                ? { op: 'replace', path: '/fields/System.Tags', value: tags }
                : { op: 'remove', path: '/fields/System.Tags' };

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [patchOp],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            notifySuccess('Tags updated');
            // A new tag should show up in the suggestions straight away
            sharedMetadataCache.invalidate(this.tagsCacheKey());
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update tags: ${error}`);
        }
    }

    private async uploadAttachment() {
        if (!this._workItem) return;

        const fileUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: 'Upload',
            title: 'Select file to attach'
        });

        if (!fileUri || fileUri.length === 0) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return;

            const filePath = fileUri[0].fsPath;
            const fileName = filePath.split(/[\\/]/).pop() || 'attachment';

            const fs = require('fs');
            const fileContent = fs.readFileSync(filePath);

            const uploadResponse = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/attachments`,
                fileContent,
                {
                    params: { fileName: fileName, 'api-version': '7.0' },
                    headers: { 'Content-Type': 'application/octet-stream' }
                }
            );

            const attachmentUrl = uploadResponse.data.url;

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [{
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: 'AttachedFile',
                        url: attachmentUrl,
                        attributes: { comment: `Uploaded from VS Code: ${fileName}` }
                    }
                }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            notifySuccess(`Uploaded: ${fileName}`);
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to upload attachment: ${error}`);
        }
    }

    private async downloadAttachment(url: string, name: string) {
        try {
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(name),
                saveLabel: 'Download'
            });

            if (!saveUri) return;

            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            // The request carries the Azure DevOps credentials, so only fetch from the organization
            if (!isOrganizationUrl(url, this.authenticationManager.getConfig()?.organizationUrl)) {
                vscode.window.showErrorMessage('This attachment is not on your Azure DevOps organization, so it was not downloaded.');
                return;
            }

            const response = await axiosInstance.get(url, { responseType: 'arraybuffer' });

            const fs = require('fs');
            fs.writeFileSync(saveUri.fsPath, Buffer.from(response.data));

            notifySuccess(`Downloaded: ${name}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to download attachment: ${error}`);
        }
    }

    private async deleteAttachment(url: string) {
        if (!this._workItem) return;

        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to remove this attachment?',
            { modal: true },
            'Remove'
        );

        if (confirm !== 'Remove') return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const relations = this._workItem.relations || [];
            const relationIndex = relations.findIndex((r: any) => r.url === url);

            if (relationIndex === -1) {
                vscode.window.showErrorMessage('Attachment not found');
                return;
            }

            await axiosInstance.patch(
                `/_apis/wit/workitems/${this._workItem.id}`,
                [{ op: 'remove', path: `/relations/${relationIndex}` }],
                { headers: { 'Content-Type': 'application/json-patch+json' } }
            );

            notifySuccess('Attachment removed');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to remove attachment: ${error}`);
        }
    }

    private async uploadImageForComment(base64Data: string): Promise<void> {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return;

            // Convert base64 to buffer
            const base64Image = base64Data.split(',')[1];
            const buffer = Buffer.from(base64Image, 'base64');

            // Upload as attachment
            const uploadResponse = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/attachments`,
                buffer,
                {
                    params: { fileName: `image-${Date.now()}.png`, 'api-version': '7.0' },
                    headers: { 'Content-Type': 'application/octet-stream' }
                }
            );

            // Send URL back to webview
            this._panel.webview.postMessage({
                command: 'imageUploaded',
                url: uploadResponse.data.url
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to upload image: ${error}`);
        }
    }

    private async addComment(commentHtml: string) {
        if (!this._workItem || !commentHtml.trim()) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return;

            await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${this._workItem.id}/comments`,
                { text: commentHtml },
                { params: { 'api-version': '7.0-preview.3' } }
            );

            notifySuccess('Comment added');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add comment: ${error}`);
        }
    }

    private async updateComment(commentId: number, commentHtml: string) {
        if (!this._workItem || !commentHtml.trim()) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return;

            await axiosInstance.patch(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${this._workItem.id}/comments/${commentId}`,
                { text: commentHtml },
                { params: { 'api-version': '7.0-preview.3' } }
            );

            notifySuccess('Comment updated');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to update comment: ${error}`);
        }
    }

    private async deleteComment(commentId: number) {
        if (!this._workItem) return;

        const confirm = await vscode.window.showWarningMessage(
            'Delete this comment?',
            { modal: true },
            'Delete'
        );

        if (confirm !== 'Delete') return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return;

            await axiosInstance.delete(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${this._workItem.id}/comments/${commentId}`,
                { params: { 'api-version': '7.0-preview.3' } }
            );

            notifySuccess('Comment deleted');
            await this.refreshWorkItem();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete comment: ${error}`);
        }
    }

    private async refreshWorkItem() {
        if (!this._workItem) return;

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            if (!axiosInstance) return;

            const response = await axiosInstance.get(`/_apis/wit/workitems/${this._workItem.id}`, {
                params: { '$expand': 'all', 'api-version': '7.0' }
            });
            this._workItem = response.data;
            this._panel.title = WorkItemPanel.panelTitle(response.data);
            this._update();
        } catch (error) {
            log.error('Failed to refresh:', error);
        }
    }

    private openInBrowser() {
        if (!this._workItem) return;

        const config = this.authenticationManager.getConfig();
        if (config) {
            const url = `${config.organizationUrl}/${config.defaultProject}/_workitems/edit/${this._workItem.id}`;
            vscode.env.openExternal(vscode.Uri.parse(url));
        }
    }

    private _updateGeneration = 0;
    private _disposed = false;

    /**
     * Loads everything the page shows and renders it. Each lookup falls back to an empty value
     * on its own, so one failing request (for example no permission to read team members)
     * leaves that part empty instead of leaving the whole panel blank.
     */
    private async _update(): Promise<void> {
        const generation = ++this._updateGeneration;
        const settle = async <T>(what: string, promise: Promise<T>, fallback: T): Promise<T> => {
            try {
                return await promise;
            } catch (error) {
                log.error(`[WorkItemPanel] Failed to load ${what}:`, error);
                return fallback;
            }
        };

        try {
            const [comments, linkedItems, iterations, areas, teamMembers, existingTags, attachments, availableStates, currentUser] = await Promise.all([
                settle('comments', this.getComments(), [] as any[]),
                settle('linked items', this.getLinkedItems(), [] as any[]),
                settle('iterations', this.getIterations(), [] as IterationInfo[]),
                settle('areas', this.getAreas(), [] as AreaInfo[]),
                settle('team members', this.getTeamMembers(), [] as TeamMemberInfo[]),
                settle('tags', this.getExistingTags(), [] as string[]),
                settle('attachments', this.getAttachments(), [] as any[]),
                settle('states', this.getAvailableStates(), ['New', 'Active', 'Resolved', 'Closed']),
                settle('current user', this.authenticationManager.getCurrentUser(), null)
            ]);

            // A newer update started while this one was loading; let that one render.
            if (generation !== this._updateGeneration || this._disposed) {
                return;
            }

            this._iterations = iterations;
            this._areas = areas;
            this._teamMembers = teamMembers;
            this._existingTags = existingTags;
            this._availableStates = availableStates;
            this._panel.webview.html = this._getHtmlForWebview(comments, linkedItems, attachments, currentUser);
        } catch (error: any) {
            log.error('[WorkItemPanel] Failed to render work item:', error);
            if (generation === this._updateGeneration && !this._disposed) {
                this._panel.webview.html = this._getErrorHtml(error?.message || String(error));
            }
        }
    }

    /** Shown when the page itself can't be built, with a way to try again. */
    private _getErrorHtml(message: string): string {
        const id = this._workItem?.id ?? '';
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(this._panel.webview, nonce)}">
    <style>
        body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 24px; }
        button { margin-top: 12px; padding: 4px 12px; border: none; cursor: pointer;
            color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
        button:hover { background: var(--vscode-button-hoverBackground); }
        p { color: var(--vscode-descriptionForeground); }
    </style>
</head>
<body>
    <h2>Couldn't show work item #${escapeHtml(id)}</h2>
    <p>${escapeHtml(message)}</p>
    <button id="retry">Try again</button>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        document.getElementById('retry').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    </script>
</body>
</html>`;
    }

    /** Cache key scope: the connection's organization, project and team. */
    private metadataScope(): string[] {
        const config = this.authenticationManager.getConfig();
        return [config?.organizationUrl ?? '', config?.defaultProject ?? '', config?.defaultTeam ?? ''];
    }

    // Team and project metadata is shared by every open work item panel for 10 minutes.
    private async getIterations(): Promise<IterationInfo[]> {
        const iterations = await azureDevOps().getTeamIterations();
        return iterations.map(({ id, name, path, startDate, finishDate }) => ({ id, name, path, startDate, finishDate }));
    }

    private async getAreas(): Promise<AreaInfo[]> {
        const { areaPaths } = await azureDevOps().getTeamFieldValues();
        // The path doubles as the id, since team field values don't carry node ids
        return areaPaths.map(path => ({ id: path, name: path.split('\\').pop() || path, path }));
    }

    private getTeamMembers(): Promise<TeamMemberInfo[]> {
        return sharedMetadataCache.getOrLoad(metadataKey('panel-members', ...this.metadataScope()), METADATA_TTL_MS, () => this.loadTeamMembers());
    }

    private tagsCacheKey(): string {
        const [org, project] = this.metadataScope();
        return metadataKey('tags', org, project);
    }

    private getExistingTags(): Promise<string[]> {
        return sharedMetadataCache.getOrLoad(this.tagsCacheKey(), METADATA_TTL_MS, () => this.loadExistingTags());
    }

    private async getAvailableStates(): Promise<string[]> {
        const workItemType = this._workItem?.fields['System.WorkItemType'];
        if (!workItemType) return [];
        const states = await azureDevOps().getWorkItemTypeStates(workItemType);
        return states.length > 0 ? states : ['New', 'Active', 'Resolved', 'Closed'];
    }

    /** The work item's relations, from the loaded item when it has them, otherwise fetched once. */
    private async getRelations(): Promise<any[]> {
        if (!this._workItem) return [];
        if (Array.isArray(this._workItem.relations)) {
            return this._workItem.relations;
        }
        const axiosInstance = this.authenticationManager.getAxiosInstance();
        if (!axiosInstance) return [];
        const response = await axiosInstance.get(`/_apis/wit/workitems/${this._workItem.id}`, {
            params: { '$expand': 'relations', 'api-version': '7.0' }
        });
        this._workItem.relations = response.data.relations || [];
        return this._workItem.relations || [];
    }

    private async getLinkedItems(): Promise<any[]> {
        if (!this._workItem) return [];

        const axiosInstance = this.authenticationManager.getAxiosInstance();
        if (!axiosInstance) return [];

        const links: Array<{ id: number; rel: string }> = [];
        for (const relation of await this.getRelations()) {
            if (relation.rel && relation.url && relation.url.includes('workItems')) {
                const linkedIdMatch = relation.url.match(/workItems\/(\d+)/);
                if (linkedIdMatch) {
                    links.push({ id: parseInt(linkedIdMatch[1], 10), rel: relation.rel });
                }
            }
        }
        if (links.length === 0) return [];

        // One request per 200 linked items instead of one per item.
        const linked = (await azureDevOps()
            .getWorkItems(links.map(link => link.id), { fields: ['System.Title', 'System.State', 'System.WorkItemType'] })
            .catch(error => {
                log.error('[WorkItemPanel] Failed to load linked items:', error);
                return [] as any[];
            }))
            .filter((item: any) => item.fields);
        const byId = new Map(linked.map((item: any) => [item.id, item]));

        return links
            .filter(link => byId.has(link.id))
            .map(link => {
                const fields = byId.get(link.id).fields;
                return {
                    id: link.id,
                    title: fields['System.Title'],
                    state: fields['System.State'],
                    type: fields['System.WorkItemType'],
                    linkType: this.getLinkTypeName(link.rel)
                };
            });
    }

    private getLinkTypeName(rel: string): string {
        const map: Record<string, string> = {
            'System.LinkTypes.Hierarchy-Reverse': 'Parent',
            'System.LinkTypes.Hierarchy-Forward': 'Child',
            'System.LinkTypes.Related': 'Related',
            'System.LinkTypes.Dependency-Reverse': 'Predecessor',
            'System.LinkTypes.Dependency-Forward': 'Successor'
        };
        return map[rel] || 'Related';
    }

    private async getAttachments(): Promise<any[]> {
        if (!this._workItem) return [];

        try {
            const relations = await this.getRelations();
            const attachments: any[] = [];

            for (const relation of relations) {
                if (relation.rel === 'AttachedFile') {
                    const urlParts = relation.url.split('/');
                    const fileName = relation.attributes?.name ||
                                   decodeURIComponent(urlParts[urlParts.length - 1].split('?')[0]) ||
                                   'attachment';

                    attachments.push({
                        name: fileName,
                        url: relation.url,
                        comment: relation.attributes?.comment || '',
                        resourceSize: relation.attributes?.resourceSize || 0
                    });
                }
            }

            return attachments;
        } catch (error) {
            log.error('Failed to load attachments:', error);
            return [];
        }
    }

    /** People to offer as assignees: project team members who have work assigned in the team's area. */
    private async loadTeamMembers(): Promise<TeamMemberInfo[]> {
        const members = await azureDevOps().getProjectMembers();
        const filtered = await this.filterTeamMembersWithWorkItems(members);
        log.debug(`[WorkItemPanel] ${filtered.length} of ${members.length} members have work items`);
        return filtered;
    }

    private async filterTeamMembersWithWorkItems(members: TeamMemberInfo[]): Promise<TeamMemberInfo[]> {
        try {
            const service = azureDevOps();
            const teamAreaPath = (await service.getTeamFieldValues().catch(() => undefined))?.defaultValue ?? '';
            const areaFilter = teamAreaPath ? `AND [System.AreaPath] UNDER '${teamAreaPath.replace(/'/g, "''")}'` : '';
            const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] <> '' ${areaFilter}`;
            const ids = await service.queryWorkItemIds(wiql, 200);
            if (ids.length === 0) {
                return members;
            }
            const items = await service.getWorkItems(ids, { fields: ['System.AssignedTo'] });
            const assignees = new Set<string>();
            for (const item of items) {
                const uniqueName = item.fields?.['System.AssignedTo']?.uniqueName;
                if (uniqueName) {
                    assignees.add(uniqueName);
                }
            }
            return members.filter(member => assignees.has(member.uniqueName));
        } catch (error) {
            log.error('[WorkItemPanel] Failed to filter team members, showing all:', error);
            return members;
        }
    }

    private async loadExistingTags(): Promise<string[]> {
        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();

            if (!axiosInstance || !config?.defaultProject) return [];

            // The tags API lists every tag in the project in one call.
            try {
                const tagsResponse = await axiosInstance.get(
                    `/${encodeURIComponent(config.defaultProject)}/_apis/wit/tags`,
                    { params: { 'api-version': '7.1-preview.1' } }
                );
                const names: string[] = (tagsResponse.data?.value || [])
                    .map((tag: any) => String(tag?.name ?? '').trim())
                    .filter((name: string) => name);
                return Array.from(new Set(names)).sort((a, b) => a.localeCompare(b));
            } catch (tagsError) {
                // Older Azure DevOps Server versions lack the tags API; fall back to recent work items.
                log.warn('[WorkItemPanel] Tags API unavailable, reading tags from recent work items:', (tagsError as any)?.message || tagsError);
            }

            const wiql = `SELECT [System.Id], [System.Tags] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC`;

            const response = await axiosInstance.post(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/wiql`,
                { query: wiql },
                { params: { 'api-version': '7.0', '$top': 100 } }
            );

            const workItemRefs = response.data.workItems || [];
            if (workItemRefs.length === 0) return [];

            const ids = workItemRefs.slice(0, 50).map((w: any) => w.id).join(',');
            const detailsResponse = await axiosInstance.get('/_apis/wit/workitems', {
                params: { 'ids': ids, 'fields': 'System.Tags', 'api-version': '7.0' }
            });

            const tagSet = new Set<string>();
            (detailsResponse.data.value || []).forEach((item: any) => {
                const tags = item.fields?.['System.Tags'] || '';
                if (tags) {
                    tags.split(';').forEach((tag: string) => {
                        const trimmed = tag.trim();
                        if (trimmed) tagSet.add(trimmed);
                    });
                }
            });

            return Array.from(tagSet).sort();
        } catch (error) {
            log.error('Failed to load existing tags:', error);
            throw error;
        }
    }

    private async getComments(): Promise<any[]> {
        if (!this._workItem) return [];

        try {
            const axiosInstance = this.authenticationManager.getAxiosInstance();
            const config = this.authenticationManager.getConfig();
            
            if (!axiosInstance || !config?.defaultProject) return [];

            const response = await axiosInstance.get(
                `/${encodeURIComponent(config.defaultProject)}/_apis/wit/workItems/${this._workItem.id}/comments`,
                { params: { 'api-version': '7.0-preview.3' } }
            );
            
            return response.data.comments || [];
        } catch (error) {
            return [];
        }
    }

    private _getHtmlForWebview(comments: any[] = [], linkedItems: any[] = [], attachments: any[] = [], currentUser: any = null): string {
        const quillCssUri = vendorAssetUri(this._panel.webview, this._extensionUri, 'quill', 'quill.snow.css');
        const quillJsUri = vendorAssetUri(this._panel.webview, this._extensionUri, 'quill', 'quill.min.js');
        if (!this._workItem) return '<html><body><p>No work item loaded</p></body></html>';

        const fields = this._workItem.fields;
        const title = this.escapeHtml(fields['System.Title'] || '');
        const description = sanitizeRichText(fields['System.Description'] || '');
        const acceptanceCriteria = sanitizeRichText((fields as any)['Microsoft.VSTS.Common.AcceptanceCriteria'] || '');
        const state = fields['System.State'] || '';
        const type = fields['System.WorkItemType'] || '';
        const assignedTo = fields['System.AssignedTo']?.displayName || 'Unassigned';
        const assignedToUniqueName = fields['System.AssignedTo']?.uniqueName || '';
        const createdDate = new Date(fields['System.CreatedDate']).toLocaleDateString();
        const changedDate = new Date(fields['System.ChangedDate']).toLocaleDateString();
        const priority = fields['Microsoft.VSTS.Common.Priority'] || 0;
        const effort = fields['Microsoft.VSTS.Scheduling.Effort'] || (fields as any)['Microsoft.VSTS.Scheduling.StoryPoints'] || '';
        const iterationPath = fields['System.IterationPath'] || '';
        const areaPath = fields['System.AreaPath'] || '';
        const tags = fields['System.Tags'] || '';

        // Log the current work item's paths to understand the expected format
        console.log('[WorkItemPanel] Current work item paths:');
        console.log('  - IterationPath:', iterationPath);
        console.log('  - AreaPath:', areaPath);

        // Get current user info for comment section
        // Azure DevOps API returns customDisplayName, not displayName
        const currentUserDisplayName = currentUser?.customDisplayName || currentUser?.providerDisplayName || currentUser?.displayName || 'You';
        const currentUserInitials = this.getInitials(currentUserDisplayName);
        const currentUserColor = this.getAvatarColor(currentUserDisplayName);

        // Use dynamically fetched available states for this work item type
        const stateOptions = this._availableStates.length > 0
            ? this._availableStates
            : ['New', 'Active', 'Resolved', 'Closed'];

        const getStateColor = (state: string) => {
            const map: Record<string, string> = {
                'New': '#0078d4', 'To Do': '#0078d4',
                'Active': '#ffa500', 'In Progress': '#ffa500',
                'Resolved': '#8b8b00',
                'Done': '#107c10', 'Closed': '#107c10',
                'Removed': '#d13438'
            };
            return map[state] || '#8b8b8b';
        };

        // Styles and script live in media/workItem; data for the script goes in #work-item-data
        const nonce = getNonce();
        const mediaUri = (...segments: string[]) =>
            this._panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', ...segments));
        const workItemCssUri = mediaUri('workItem', 'workItem.css');
        const workItemJsUri = mediaUri('workItem', 'workItem.js');
        const handlersJsUri = mediaUri('shared', 'webviewHandlers.js');
        const workItemData = {
            description: description || '',
            acceptanceCriteria: acceptanceCriteria || '',
            existingTags: this._existingTags,
            currentTags: tags ? tags.split(';').map((t: string) => t.trim()).filter((t: string) => t) : []
        };

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${webviewCsp(this._panel.webview, nonce)}">
    <title>#${this._workItem.id}</title>
    <link href="${quillCssUri}" rel="stylesheet">
    <link href="${workItemCssUri}" rel="stylesheet">
    <style>:root { --state-color: ${safeCssColor(getStateColor(state), '#8b8b8b')}; }</style>
    <script nonce="${nonce}" src="${quillJsUri}"></script>
</head>
<body>
    <div class="container">
        <div class="header">
            <span class="type-icon" title="${this.escapeHtml(type)}">${this.getWorkItemTypeIcon(type)}</span>
            <span class="work-item-id">#${this._workItem.id}</span>
            <span class="title-display">${title}</span>
            <span class="state-pill" data-click="scrollToState">${this.escapeHtml(state)}</span>
            <div class="quick-actions">
                ${assignedTo === 'Unassigned' ? '<button class="btn-icon" data-click="assignToMe">Assign to me</button>' : ''}
                <button class="btn-icon" data-click="toggleMenu" data-click-args='[{"$ref": "event"}]'>⋯</button>
                <div id="menuDropdown" class="menu-dropdown" style="display: none;">
                    <div class="menu-item" data-click="menuOpenInBrowser">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 8px;">
                            <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 0 0-.656 2.5h2.49zM4.847 5a12.5 12.5 0 0 0-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 0 0-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 0 0 .337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 0 1-.597-.933A9.268 9.268 0 0 1 4.09 12H2.255a7.024 7.024 0 0 0 3.072 2.472zM3.82 11a13.652 13.652 0 0 1-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A7.024 7.024 0 0 0 13.745 12H11.91a9.27 9.27 0 0 1-.64 1.539 6.688 6.688 0 0 1-.597.933zM8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.65 13.65 0 0 1-.312 2.5zm2.802-3.5a6.959 6.959 0 0 0-.656-2.5H12.18c.174.782.282 1.623.312 2.5h2.49zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7.024 7.024 0 0 0-3.072-2.472c.218.284.418.598.597.933zM10.855 4a7.966 7.966 0 0 0-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4h2.355z"/>
                        </svg>
                        Open in Browser
                    </div>
                    <div class="menu-item" data-click="menuRefresh">
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 8px;">
                            <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                            <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                        </svg>
                        Refresh
                    </div>
                </div>
            </div>
        </div>

        <div class="card details-card">
            <div class="card-title">Details</div>
            <div class="form-group">
                <label>Title</label>
                <input type="text" id="title" value="${title}" data-blur="saveTitleOnBlur">
            </div>
            <div class="form-group">
                <label>Description</label>
                <div id="descriptionDisplay" class="description-display" data-click="showDescriptionEditor" style="min-height: 40px; cursor: text; padding: 12px;">${description || '<span style="color: var(--vscode-input-placeholderForeground);">Click to add description...</span>'}</div>
                <div id="descriptionEditorContainer">
                    <div id="descriptionEditor" style="background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px;"></div>
                </div>
            </div>
            <div class="form-group">
                <label>Acceptance Criteria</label>
                <div id="acceptanceCriteriaDisplay" class="description-display" data-click="showAcceptanceCriteriaEditor" style="min-height: 40px; cursor: text; padding: 12px;">${acceptanceCriteria || '<span style="color: var(--vscode-input-placeholderForeground);">Click to add acceptance criteria...</span>'}</div>
                <div id="acceptanceCriteriaEditorContainer">
                    <div id="acceptanceCriteriaEditor" style="background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px;"></div>
                </div>
            </div>
            <div class="action-bar" style="display: none;">
                <button class="btn-primary" data-click="saveWorkItem">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
                        <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
                    </svg>
                    Save
                </button>
                <button class="btn-secondary" data-click="openInBrowser">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
                        <path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm7.5-6.923c-.67.204-1.335.82-1.887 1.855A7.97 7.97 0 0 0 5.145 4H7.5V1.077zM4.09 4a9.267 9.267 0 0 1 .64-1.539 6.7 6.7 0 0 1 .597-.933A7.025 7.025 0 0 0 2.255 4H4.09zm-.582 3.5c.03-.877.138-1.718.312-2.5H1.674a6.958 6.958 0 0 0-.656 2.5h2.49zM4.847 5a12.5 12.5 0 0 0-.338 2.5H7.5V5H4.847zM8.5 5v2.5h2.99a12.495 12.495 0 0 0-.337-2.5H8.5zM4.51 8.5a12.5 12.5 0 0 0 .337 2.5H7.5V8.5H4.51zm3.99 0V11h2.653c.187-.765.306-1.608.338-2.5H8.5zM5.145 12c.138.386.295.744.468 1.068.552 1.035 1.218 1.65 1.887 1.855V12H5.145zm.182 2.472a6.696 6.696 0 0 1-.597-.933A9.268 9.268 0 0 1 4.09 12H2.255a7.024 7.024 0 0 0 3.072 2.472zM3.82 11a13.652 13.652 0 0 1-.312-2.5h-2.49c.062.89.291 1.733.656 2.5H3.82zm6.853 3.472A7.024 7.024 0 0 0 13.745 12H11.91a9.27 9.27 0 0 1-.64 1.539 6.688 6.688 0 0 1-.597.933zM8.5 12v2.923c.67-.204 1.335-.82 1.887-1.855.173-.324.33-.682.468-1.068H8.5zm3.68-1h2.146c.365-.767.594-1.61.656-2.5h-2.49a13.65 13.65 0 0 1-.312 2.5zm2.802-3.5a6.959 6.959 0 0 0-.656-2.5H12.18c.174.782.282 1.623.312 2.5h2.49zM11.27 2.461c.247.464.462.98.64 1.539h1.835a7.024 7.024 0 0 0-3.072-2.472c.218.284.418.598.597.933zM10.855 4a7.966 7.966 0 0 0-.468-1.068C9.835 1.897 9.17 1.282 8.5 1.077V4h2.355z"/>
                    </svg>
                    Open in Browser
                </button>
                <button class="btn-secondary" data-click="refresh">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="margin-right: 6px;">
                        <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z"/>
                        <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z"/>
                    </svg>
                    Refresh
                </button>
            </div>
        </div>

        <div class="card">
            <div class="card-title">Metadata</div>
            <div class="metadata-grid">
                <div class="meta-item" style="z-index: 9;">
                    <span class="meta-label">Assigned To</span>
                    <div class="custom-dropdown-wrapper" id="assigneeDropdownWrapper">
                        <button class="meta-select custom-dropdown-btn" id="assigneeDropdownBtn" type="button" data-click="toggleAssigneeDropdown">
                            ${assignedToUniqueName ? this.escapeHtml(this._teamMembers.find(m => m.uniqueName === assignedToUniqueName)?.displayName || 'Unassigned') : 'Unassigned'}
                        </button>
                        <div class="assignee-dropdown-list" id="assigneeDropdownList">
                            <div class="assignee-dropdown-item ${!assignedToUniqueName ? 'selected' : ''}" data-click="selectAssignee" data-click-args='["", "Unassigned"]'>
                                Unassigned
                            </div>
                            ${this._teamMembers.map(m => {
                                const isSelected = m.uniqueName === assignedToUniqueName;
                                return `<div class="assignee-dropdown-item ${isSelected ? 'selected' : ''}" data-click="selectAssignee" data-click-args='[${jsArg(m.uniqueName)}, ${jsArg(m.displayName)}]'>
                                    ${this.escapeHtml(m.displayName)}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Priority</span>
                    <div class="priority-select-wrapper">
                        ${[1, 2, 3, 4].map(p => `<button class="priority-btn p${p} ${priority === p ? 'active' : ''}" data-click="updatePriority" data-click-args='[${p}]'>${p}</button>`).join('')}
                    </div>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Effort / Story Points</span>
                    <input type="number" class="meta-input effort-input" id="effortInput" value="${this.escapeHtml(String(effort))}" placeholder="0" data-change="updateEffort">
                </div>
                <div class="meta-item" style="z-index: 10;">
                    <span class="meta-label">Iteration</span>
                    <div class="custom-dropdown-wrapper" id="iterationDropdownWrapper">
                        <button class="meta-select custom-dropdown-btn" id="iterationDropdownBtn" type="button" data-click="toggleIterationDropdown">
                            ${iterationPath ? this.escapeHtml(iterationPath.split('\\').pop() || iterationPath) : 'None'}
                        </button>
                        <div class="iteration-dropdown-list" id="iterationDropdownList">
                            <div class="iteration-dropdown-item ${!iterationPath ? 'selected' : ''}" data-click="selectIteration" data-click-args='["", "None"]'>
                                <span class="iteration-item-name">None</span>
                            </div>
                            ${this._iterations.map(iter => {
                                const dateRange = iter.startDate && iter.finishDate
                                    ? `${new Date(iter.startDate).toLocaleDateString()} - ${new Date(iter.finishDate).toLocaleDateString()}`
                                    : '';
                                const isSelected = iter.path === iterationPath;
                                return `<div class="iteration-dropdown-item ${isSelected ? 'selected' : ''}"
                                    data-path="${this.escapeHtml(iter.path)}"
                                    data-name="${this.escapeHtml(iter.name)}"
                                    data-click="selectIterationFromData" data-click-args='[{"$ref": "el"}]'>
                                    <span class="iteration-item-name">${this.escapeHtml(iter.name)}</span>
                                    ${dateRange ? `<span class="iteration-item-dates">${dateRange}</span>` : ''}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Tags</span>
                    <div class="tags-editor-container">
                        <div class="tags-display" id="tagsDisplay">
                            ${tags ? tags.split(';').map(t => `<span class="tag-chip-editable">${this.escapeHtml(t.trim())}<button class="tag-remove" data-click="removeTag" data-click-args='[${jsArg(t.trim())}]'>×</button></span>`).join('') : ''}
                            <input type="text" class="tag-input" id="tagInput" placeholder="Add tag..." data-input="handleTagInput" data-keydown="handleTagKeydown" data-keydown-args='[{"$ref": "event"}]' data-focus="showTagSuggestions" data-blur="hideTagSuggestions">
                        </div>
                        <div class="tag-suggestions" id="tagSuggestions"></div>
                    </div>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Created</span>
                    <span class="meta-value">${createdDate}</span>
                </div>
                <div class="meta-item">
                    <span class="meta-label">Modified</span>
                    <span class="meta-value">${changedDate}</span>
                </div>
                <div class="meta-item" style="z-index: 8;">
                    <span class="meta-label">Area</span>
                    <div class="custom-dropdown-wrapper" id="areaDropdownWrapper">
                        <button class="meta-select custom-dropdown-btn" id="areaDropdownBtn" type="button" data-click="toggleAreaDropdown">
                            ${areaPath ? this.escapeHtml(areaPath.split('\\').pop() || areaPath) : 'Select Area'}
                        </button>
                        <div class="area-dropdown-list" id="areaDropdownList">
                            ${this._areas.map(area => {
                                const isSelected = area.path === areaPath;
                                return `<div class="area-dropdown-item ${isSelected ? 'selected' : ''}"
                                    data-path="${this.escapeHtml(area.path)}"
                                    data-name="${this.escapeHtml(area.name)}"
                                    data-click="selectAreaFromData" data-click-args='[{"$ref": "el"}]'>
                                    ${this.escapeHtml(area.name)}
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        ${linkedItems.length > 0 ? `
        <div class="card">
            <div class="card-title">🔗 Linked Work Items (${linkedItems.length})</div>
            <div class="linked-items">
                ${Object.entries(linkedItems.reduce((groups: any, item: any) => {
                    if (!groups[item.linkType]) groups[item.linkType] = [];
                    groups[item.linkType].push(item);
                    return groups;
                }, {})).map(([linkType, items]: [string, any]) => `
                    <div class="link-group">
                        <div class="link-group-title">${this.escapeHtml(linkType)} (${items.length})</div>
                        ${items.map((item: any) => `
                            <div class="linked-item" data-click="openLinkedItem" data-click-args='[${item.id}]'>
                                <span class="linked-item-id">#${item.id}</span>
                                <span class="linked-item-title">${this.escapeHtml(item.title)}</span>
                                <span class="linked-item-state" style="background: ${this.getStateColorForLinked(item.state)}">${this.escapeHtml(item.state)}</span>
                            </div>
                        `).join('')}
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}

        <div class="card">
            <div class="attachments-header">
                <div class="card-title" style="margin-bottom: 0;">📎 Attachments (${attachments.length})</div>
                <button class="upload-btn" data-click="uploadAttachment">+ Upload File</button>
            </div>
            ${attachments.length > 0 ? `
            <div class="attachments-list">
                ${attachments.map((att: any) => `
                    <div class="attachment-item">
                        <span class="attachment-icon">${this.getFileIcon(att.name)}</span>
                        <div class="attachment-info">
                            <div class="attachment-name" data-click="downloadAttachment" data-click-args='[${jsArg(att.url)}, ${jsArg(att.name)}]'>${this.escapeHtml(att.name)}</div>
                            <div class="attachment-meta">${att.resourceSize ? this.formatFileSize(att.resourceSize) : ''}${att.comment ? ' • ' + this.escapeHtml(att.comment) : ''}</div>
                        </div>
                        <div class="attachment-actions">
                            <button class="attachment-btn" data-click="downloadAttachment" data-click-args='[${jsArg(att.url)}, ${jsArg(att.name)}]' title="Download">↓</button>
                            <button class="attachment-btn delete" data-click="deleteAttachment" data-click-args='[${jsArg(att.url)}]' title="Remove">×</button>
                        </div>
                    </div>
                `).join('')}
            </div>
            ` : `
            <div class="no-attachments">No attachments yet. Click "Upload File" to add one.</div>
            `}
        </div>

        <div class="card" id="stateSection">
            <div class="card-title">Change State</div>
            <div class="state-pills">
                ${stateOptions.map(s => `<button class="state-option ${s === state ? 'active' : ''}" data-click="changeState" data-click-args='[${jsArg(s)}]'>${this.escapeHtml(s)}</button>`).join('')}
            </div>
        </div>

        <div class="card">
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                <div style="width: 32px; height: 32px; border-radius: 50%; background: ${currentUserColor}; color: white; display: flex; align-items: center; justify-content: center; font-weight: 600; font-size: 12px;">${this.escapeHtml(currentUserInitials)}</div>
                <div class="card-title" style="margin-bottom: 0;">Add a comment</div>
            </div>
            <div class="comment-input-area">
                <div id="commentEditor" style="width: 100%; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px;"></div>
                <button id="addCommentBtn" class="btn-secondary" data-click="addComment" style="display: none;">Add Comment</button>
            </div>
        </div>

        ${comments.length > 0 ? `
        <div class="card">
            <div class="card-title">Activity (${comments.length})</div>
            <div class="timeline">
                ${comments.map(c => `
                    <div class="timeline-item">
                        <div class="timeline-icon" style="background: ${this.getAvatarColor(c.createdBy?.displayName || 'Unknown')}; color: white; font-weight: 600; font-size: 12px;">${this.escapeHtml(this.getInitials(c.createdBy?.displayName || 'Unknown'))}</div>
                        <div class="timeline-content">
                            <div class="timeline-header">
                                <span class="timeline-author">${this.escapeHtml(c.createdBy?.displayName || 'Unknown')} <span style="text-decoration: underline; font-weight: normal;">commented ${this.formatRelativeTime(c.createdDate)}</span></span>
                                <div class="comment-actions">
                                    <button class="comment-action-btn" data-click="editComment" data-click-args='[${c.id}]' title="Edit">✏️</button>
                                    <button class="comment-action-btn" data-click="deleteComment" data-click-args='[${c.id}]' title="Delete">🗑️</button>
                                </div>
                            </div>
                            <div class="timeline-text" id="comment-${c.id}" style="word-wrap: break-word;">${sanitizeRichText(c.text || '')}</div>
                            <div id="edit-${c.id}" style="display: none;">
                                <div id="editor-${c.id}" style="background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 6px; margin-top: 8px;"></div>
                                <div style="margin-top: 8px; display: flex; gap: 8px;">
                                    <button class="btn-secondary" data-click="saveEdit" data-click-args='[${c.id}]'>Save</button>
                                    <button class="btn-secondary" data-click="cancelEdit" data-click-args='[${c.id}]'>Cancel</button>
                                </div>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
    </div>

    <script nonce="${nonce}" id="work-item-data" type="application/json">${serializeForScript(workItemData)}</script>
    <script nonce="${nonce}" src="${handlersJsUri}"></script>
    <script nonce="${nonce}" src="${workItemJsUri}"></script>
</body>
</html>`;
    }

    private formatRelativeTime(dateStr: string): string {
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const minutes = Math.floor(diff / (1000 * 60));
        
        if (minutes < 1) return 'just now';
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        const weeks = Math.floor(days / 7);
        if (weeks < 4) return `${weeks}w ago`;
        return date.toLocaleDateString();
    }

    private getWorkItemTypeIcon(type: string): string {
        // Use SVG icons with Azure DevOps standard colors
        switch(type) {
            case 'User Story':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>`;

            case 'Feature':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#773B93" d="M145.619 384H128c-17.674 0-32 14.326-32 32v32h256v-32c0-17.674-14.327-32-32-32h-17.619c-7.434-36.47-39.75-64-78.381-64s-70.947 27.53-78.381 64zM224 352c20.832 0 38.425 13.418 45.053 32h-90.106c6.627-18.582 24.221-32 45.053-32zM352 64V32H96v32H32v80c0 40.051 29.686 73.018 68.153 78.8C114.003 278.531 163.984 320 224 320c60.016 0 109.997-41.469 123.846-97.2C386.313 217.018 416 184.051 416 144V64h-64zM96 189.053C77.417 182.426 64 164.832 64 144V96h32v93.053zM384 144c0 20.832-13.418 38.426-32 45.053V96h32v48z" /></svg>`;

            case 'Epic':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#FF8C00" d="M448 96c0 17.672-14.326 32-32 32v288H32V128c-17.674 0-32-14.328-32-32 0-17.674 14.326-32 32-32s32 14.326 32 32c0 11.191-6.094 20.564-14.797 26.283L136.727 256 216.79 94.543C202.699 91.191 192 79.113 192 64c0-17.674 14.326-32 32-32s32 14.326 32 32c0 15.113-10.699 27.191-24.789 30.543L311.273 256l87.523-133.717C390.094 116.564 384 107.191 384 96c0-17.674 14.326-32 32-32s32 14.326 32 32z" /></svg>`;

            case 'Task':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#FFC107" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm56 287.758l-79.844-79.828 31.688-31.688L184 320.414l128.156-128.172 31.688 31.688L184 383.758z" /></svg>`;

            case 'Issue':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#28A745" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zm-71.469 352h-49.063v-49.094h49.063V416zm0-84.109h-49.063V164.109h49.063v167.782zM320 128H128V96h64V64c0-17.643 14.357-32 32-32 17.641 0 32 14.357 32 32v32h64v32z" /></svg>`;

            case 'Bug':
                return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="20" height="20"><path fill="#CC293D" d="M352 224c0-17.672 14.328-32 32-32h32v-32h-32c-8.828 0-16.938 2.797-23.656 7.516C350.391 140.234 324.078 120 293 120.781 287.016 108.297 275.547 99.828 262 96.781V64h32V32h-96v32h32v32.781c-13.547 3.047-25.016 11.516-31 24-31.078.781-57.391 21.016-67.344 48.297C125.938 163.797 117.828 161 109 161H77v32h32c17.672 0 32 14.328 32 32v32c0 17.672-14.328 32-32 32H77v32h32c8.828 0 16.938-2.797 23.656-7.516C142.609 340.766 168.922 361 200 360.219c5.984 12.484 17.453 20.953 31 24V417h-32v32h96v-32h-32v-32.781c13.547-3.047 25.016-11.516 31-24 31.078-.781 57.391-21.016 67.344-48.297C366.062 317.203 374.172 320 383 320h32v-32h-32c-17.672 0-32-14.328-32-32v-32zm-80 48c-26.469 0-48-21.531-48-48s21.531-48 48-48 48 21.531 48 48-21.531 48-48 48z" /></svg>`;

            default:
                return type;
        }
    }

    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }


    private getStateColorForLinked(state: string): string {
        const map: Record<string, string> = {
            'New': '#0078d4', 'To Do': '#0078d4',
            'Active': '#ffa500', 'In Progress': '#ffa500',
            'Resolved': '#8b8b00',
            'Done': '#107c10', 'Closed': '#107c10',
            'Removed': '#d13438'
        };
        return map[state] || '#8b8b8b';
    }

    private getFileIcon(fileName: string): string {
        const ext = fileName.split('.').pop()?.toLowerCase() || '';
        const iconMap: Record<string, string> = {
            'pdf': '📄',
            'doc': '📝', 'docx': '📝',
            'xls': '📊', 'xlsx': '📊',
            'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️',
            'zip': '📦', 'rar': '📦',
            'txt': '📃', 'md': '📃',
            'js': '💻', 'ts': '💻', 'py': '💻'
        };
        return iconMap[ext] || '📎';
    }

    private formatFileSize(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    private getInitials(name: string): string {
        return name
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .substring(0, 2);
    }

    private getAvatarColor(name: string): string {
        const colors = ['#0078d4', '#8764b8', '#00b7c3', '#8cbd18', '#ffb900', '#d13438', '#00cc6a', '#e3008c'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    public dispose() {
        this._disposed = true;
        if (this._workItem && WorkItemPanel.openPanels.get(this._workItem.id) === this) {
            WorkItemPanel.openPanels.delete(this._workItem.id);
        }
        // Unsubscribe from events
        if (this.eventSubscription) {
            this.eventSubscription.dispose();
            this.eventSubscription = null;
        }

        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
