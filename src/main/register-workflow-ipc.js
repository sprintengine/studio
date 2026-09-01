import { registerTerminalIpc } from './ipc/terminal-ipc';
// Switchboard + Watchtower, Sprint Engine, and the mobile relay IPC
// all moved to their capability modules (src/main/modules/), registered through
// the host kernel. What remains here is the always-on terminal runtime
// (agent-runtime), not yet migrated.
export function registerWorkflowIpc(ipcMain, services) {
    registerTerminalIpc(ipcMain, {
        ...services.terminalRuntime.ipcHandlers,
        // One idle-suspend setting governs both agent runtimes: PTY terminals and
        // headless conversation child processes share the threshold.
        setIdleSuspendThresholdMs: (value) => {
            services.terminalRuntime.ipcHandlers.setIdleSuspendThresholdMs(value);
            services.conversationRuntime.setIdleThresholdMs(value);
        },
    });
}
