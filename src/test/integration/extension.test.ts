import * as assert from 'assert';
import * as vscode from 'vscode';

// Smoke tests that run inside VS Code: the bundled extension activates and every
// command it contributes is registered. Run with `npm run test:integration`.
suite('ADO Boards extension', () => {
    const findExtension = () =>
        vscode.extensions.all.find(ext => ext.packageJSON?.name === 'azure-devops-boards');

    test('is installed and activates', async () => {
        const extension = findExtension();
        assert.ok(extension, 'extension not found');
        await extension.activate();
        assert.equal(extension.isActive, true);
    });

    test('registers every contributed command', async () => {
        const extension = findExtension();
        assert.ok(extension);
        await extension.activate();

        const contributed: string[] = (extension.packageJSON.contributes?.commands ?? []).map(
            (c: { command: string }) => c.command
        );
        const registered = new Set(await vscode.commands.getCommands(true));
        const missing = contributed.filter(id => !registered.has(id));
        assert.deepEqual(missing, [], `contributed but not registered: ${missing.join(', ')}`);
    });
});
