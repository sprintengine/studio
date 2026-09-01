import { invalidateCliAvailability } from '../cli-availability';
import { cliInstallMethods, detectCli, installCli, updateCli } from '../cli-runtime-install';
export function registerCliRuntimeIpc(ipcMain) {
    ipcMain.handle('cli-runtime:detect', (_, input) => detectCli(input.cli, input.runtime));
    ipcMain.handle('cli-runtime:install-methods', (_, input) => cliInstallMethods(input.cli, input.runtime));
    ipcMain.handle('cli-runtime:install', async (event, input) => {
        const channel = `cli-runtime:install-output:${input.cli}`;
        const result = await installCli({ cli: input.cli, methodId: input.methodId }, input.runtime, (chunk) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send(channel, chunk);
            }
        });
        // Drop any cached "not installed" probe so the next availability detect for
        // this CLI re-runs against the freshly installed binary.
        if (result.ok && result.installed)
            invalidateCliAvailability(input.cli);
        return result;
    });
    // Update action (MC-1873): the CLI's own updater where the manifest declares
    // one, else a re-run of the install spec. Streams onto the same output
    // channel installs use so one listener serves both flows.
    ipcMain.handle('cli-runtime:update', async (event, input) => {
        const channel = `cli-runtime:install-output:${input.cli}`;
        const result = await updateCli(input.cli, input.runtime, (chunk) => {
            if (!event.sender.isDestroyed()) {
                event.sender.send(channel, chunk);
            }
        });
        if (result.ok && result.installed)
            invalidateCliAvailability(input.cli);
        return result;
    });
}
