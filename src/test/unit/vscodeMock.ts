/**
 * A tiny stand-in for the `vscode` module so unit tests can run in plain Node.
 * Import this before any module that imports 'vscode'. Tests adjust `mock` as needed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');

export const mock = {
    installedExtensions: new Set<string>(),
    errorMessages: [] as string[],
    executedCommands: [] as unknown[][]
};

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
        showInformationMessage: () => Promise.resolve(undefined)
    },
    commands: {
        executeCommand: (...args: unknown[]) => {
            mock.executedCommands.push(args);
            return Promise.resolve(undefined);
        }
    },
    Uri: {
        joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join('/') })
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
}
