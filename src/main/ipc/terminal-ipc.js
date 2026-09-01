import { resolveDefaultShellName } from '../terminal-launch';
export function registerTerminalIpc(ipcMain, deps) {
    ipcMain.handle('terminal:spawn', async (event, payload) => {
        return deps.spawnTerminal(event.sender, payload);
    });
    ipcMain.handle('terminal:write', (_, { sessionId, data }) => {
        deps.writeTerminal(sessionId, data);
    });
    ipcMain.on('terminal:write-fast', (_, payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { sessionId, data } = payload;
        if (typeof sessionId !== 'string' || typeof data !== 'string')
            return;
        deps.writeTerminal(sessionId, data);
    });
    ipcMain.handle('terminal:resize', (_, { sessionId, cols, rows }) => {
        deps.resizeTerminal(sessionId, cols, rows);
    });
    // The sender matters: a status lookup can rehydrate a suspended placeholder
    // from its snapshot sidecar, and the placeholder must target the window that
    // is about to reveal it.
    ipcMain.handle('terminal:status', (event, sessionId) => {
        return deps.getTerminalStatus(sessionId, event.sender);
    });
    ipcMain.handle('terminal:list', () => {
        return deps.listTerminals();
    });
    // The name of the shell a plain terminal actually launches, for surfaces that
    // name it rather than saying "terminal" (MC-2122). Resolved by the launcher
    // itself, so the name and the process cannot drift.
    ipcMain.handle('terminal:default-shell-name', () => resolveDefaultShellName());
    ipcMain.handle('terminal:set-visible', (event, { sessionId, visible }) => {
        deps.setTerminalVisible(sessionId, visible, event.sender);
    });
    ipcMain.handle('terminal:suspend', (_, sessionId) => {
        deps.suspendTerminal(sessionId);
    });
    ipcMain.handle('terminal:resume', async (event, payload) => {
        return deps.resumeTerminal(event.sender, payload);
    });
    ipcMain.handle('terminal:kill', (_, sessionId) => {
        deps.killTerminal(sessionId);
    });
    // Renderer pushes the user's "Pause idle terminals after" setting (ms). The
    // reap policy clamps it; an out-of-range or non-numeric value falls back to the
    // default. Fire-and-forget — the next reap sweep reads the latest value.
    ipcMain.handle('terminal:set-idle-suspend-ms', (_, value) => {
        deps.setIdleSuspendThresholdMs(value);
    });
    // Per-terminal user lock: while set, the reaper never suspends or disposes
    // this session. Validated here — it arrives straight off a renderer click.
    ipcMain.handle('terminal:set-reap-exempt', (_, payload) => {
        if (!payload || typeof payload !== 'object')
            return;
        const { sessionId, exempt } = payload;
        if (typeof sessionId !== 'string' || typeof exempt !== 'boolean')
            return;
        deps.setTerminalReapExempt(sessionId, exempt);
    });
    // Renderer pushes the user's "Always keep running" count — the recency floor
    // below which the idle reaper never suspends live agent terminals. The reap
    // policy clamps it; out-of-range or non-numeric falls back to the default.
    ipcMain.handle('terminal:set-keep-recent-alive-count', (_, value) => {
        deps.setKeepRecentTerminalsAlive(value);
    });
    // Renderer pushes the set of SprintEngine run statePaths whose dispatch loop is
    // actively running, so the idle reaper protects those runs' agents (the
    // claim-aware 5-min retirement owns them) and only reclaims inactive-run agents.
    ipcMain.handle('terminal:set-active-sprint-runs', (_, value) => {
        deps.setActiveSprintRunStatePaths(value);
    });
}
