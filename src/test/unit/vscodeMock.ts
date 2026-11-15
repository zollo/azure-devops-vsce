/**
 * A tiny stand-in for the `vscode` module so unit tests can run in plain Node.
 * Import this before any module that imports 'vscode'. Tests adjust `mock` as needed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');

export const mock = {
    installedExtensions: new Set<string>(),
    errorMessages: [] as string[],
    executedCommands: [] as unknown[][],
    warningMessages: [] as string[],
    settings: {} as Record<string, unknown>,
    /** What vscode.authentication.getSession returns. */
    authSession: undefined as { id: string; accessToken: string; account: { id: string; label: string }; scopes: string[] } | undefined,
    getSessionCalls: [] as unknown[][],
    /** Webview panel serializers registered with vscode.window.registerWebviewPanelSerializer. */
    serializers: new Map<string, { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }>()
};

class EventEmitter<T> {
    private listeners: Array<(value: T) => void> = [];
    event = (listener: (value: T) => void) => {
        this.listeners.push(listener);
        return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire(value: T): void {
        for (const listener of [...this.listeners]) {
            listener(value);
        }
    }
    dispose(): void {
        this.listeners = [];
    }
}

const vscodeStub = {
    extensions: {
        getExtension: (id: string) =>
            [...mock.installedExtensions].some(e => e.toLowerCase() === id.toLowerCase()) ? { id } : undefined
    },
    window: {
        showErrorMessage: (message: string) => {
            mock.errorMessages.push(message);
            return Promise.resolve(undefined);
        },
        showInformationMessage: () => Promise.resolve(undefined),
        registerWebviewPanelSerializer: (viewType: string, serializer: { deserializeWebviewPanel(panel: unknown, state: unknown): Promise<void> }) => {
            mock.serializers.set(viewType, serializer);
            return { dispose: () => mock.serializers.delete(viewType) };
        },
        showWarningMessage: (message: string) => {
            mock.warningMessages.push(message);
            return Promise.resolve(undefined);
        }
    },
    workspace: {
        getConfiguration: (section?: string) => ({
            get: <T>(key: string, defaultValue?: T) => {
                const fullKey = section ? `${section}.${key}` : key;
                return (fullKey in mock.settings ? mock.settings[fullKey] : defaultValue) as T;
            },
            inspect: () => undefined,
            update: () => Promise.resolve()
        }),
        workspaceFolders: undefined
    },
    authentication: {
        getSession: (...args: unknown[]) => {
            mock.getSessionCalls.push(args);
            return Promise.resolve(mock.authSession);
        },
        onDidChangeSessions: () => ({ dispose: () => {} })
    },
    EventEmitter,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    commands: {
        executeCommand: (...args: unknown[]) => {
            mock.executedCommands.push(args);
            return Promise.resolve(undefined);
        }
    },
    Uri: {
        joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join('/') })
    },
    TreeItem: class {
        [key: string]: unknown;
        constructor(public label: unknown, public collapsibleState?: number) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string, public color?: unknown) {} },
    ThemeColor: class { constructor(public id: string) {} },
    MarkdownString: class {
        value = '';
        appendMarkdown(text: string) { this.value += text; return this; }
        appendText(text: string) { this.value += text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&'); return this; }
    }
};

const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
        return vscodeStub;
    }
    return originalLoad.call(this, request, ...rest);
};

export function resetMock(): void {
    mock.installedExtensions.clear();
    mock.errorMessages.length = 0;
    mock.executedCommands.length = 0;
    mock.warningMessages.length = 0;
    mock.settings = {};
    mock.authSession = undefined;
    mock.getSessionCalls.length = 0;
    mock.serializers.clear();
}
