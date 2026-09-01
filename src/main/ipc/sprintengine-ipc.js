export function registerSprintEngineIpc(ipcMain, deps) {
    ipcMain.handle('sprintengine:artifact:open', async (_, payload) => {
        return deps.openArtifact(payload);
    });
    ipcMain.handle('sprintengine:artifact:approve', async (_, payload) => {
        return deps.reviewArtifact(payload, 'approve', 'user');
    });
    ipcMain.handle('sprintengine:artifact:auto-approve', async (_, payload) => {
        return deps.reviewArtifact(payload, 'approve', 'auto-run');
    });
    ipcMain.handle('sprintengine:artifact:request-changes', async (_, payload) => {
        return deps.reviewArtifact(payload, 'request-changes', 'user');
    });
    ipcMain.handle('sprintengine:state:initialize', async (_, payload) => {
        return deps.initializeSprintEngineState(payload);
    });
    ipcMain.handle('sprintengine:task:update', async (_, payload) => {
        return deps.updateTask(payload);
    });
    ipcMain.handle('sprintengine:task:create', async (_, payload) => {
        return deps.createTask(payload);
    });
    ipcMain.handle('sprintengine:task:comment', async (_, payload) => {
        return deps.commentTask(payload);
    });
    ipcMain.handle('sprintengine:task:resolve-input', async (_, payload) => {
        return deps.resolveTaskInput(payload);
    });
    ipcMain.handle('sprintengine:task:set-status', async (_, payload) => {
        return deps.setTaskStatus(payload);
    });
    // User-initiated sprint cancellation (MC-1604b): runs the engine `cancel` op
    // and parks the automation runtime (the dep composes both in the module).
    ipcMain.handle('sprintengine:run:cancel', async (_, payload) => {
        return deps.cancelRun(payload);
    });
    // `sprintengine:runner:set-mode` was removed (MC-1567): the renderer no
    // longer writes the cliWatchPolling hint — the main automation service's
    // set-mode path bridges it in-process (`deps.setRunnerMode` is still the
    // in-process seam it and the automations front door use).
    ipcMain.handle('sprintengine:vcs:pr', async (_, payload) => {
        return deps.createPullRequest(payload);
    });
    ipcMain.handle('sprintengine:vcs:pr-status', async (_, payload) => {
        return deps.refreshPullRequestStatus(payload);
    });
    // Merging is user-initiated and per project (MC-1612); the engine refuses an
    // out-of-order merge. Nothing here decides WHEN to merge.
    ipcMain.handle('sprintengine:vcs:pr-merge', async (_, payload) => {
        return deps.mergePullRequest(payload);
    });
    // Per-task isolation (MC-2136): provision one task's worktree BEFORE its agent
    // spawns, because a terminal cannot be moved into it afterwards. A no-op with
    // `isolated: false` on every run that shares one worktree.
    ipcMain.handle('sprintengine:vcs:task-worktree', async (_, payload) => {
        return deps.ensureTaskWorktree(payload);
    });
    ipcMain.handle('sprintengine:roster:runtime', async (_, payload) => {
        return deps.setRoleRuntime(payload);
    });
    ipcMain.handle('sprintengine:roster:enable', async (_, payload) => {
        return deps.enableRole(payload);
    });
    ipcMain.handle('sprintengine:projection:read', async (_, payload) => {
        return deps.readProjection(payload);
    });
    ipcMain.handle('sprintengine:registry:roles:read', async (_, payload) => {
        return deps.readRegistryRoles(payload);
    });
    ipcMain.handle('sprintengine:registry:role:read', async (_, payload) => {
        return deps.readRegistryRole(payload);
    });
    ipcMain.handle('sprintengine:feedback:summarize', async (_, payload) => {
        return deps.summarizeFeedback(payload);
    });
    ipcMain.handle('sprintengine:token-usage:read', async (_, payload) => {
        return deps.readTokenUsage(payload);
    });
    // Cross-project run index (MC-1761): every sprint run under the given project
    // roots as a compact summary, live and historical, with no resident workspace.
    ipcMain.handle('sprintengine:runs:list', async (_, payload) => {
        return deps.listRuns(payload);
    });
}
