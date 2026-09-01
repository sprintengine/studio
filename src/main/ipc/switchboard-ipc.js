export function registerSwitchboardIpc(ipcMain, deps) {
    ipcMain.handle('switchboard:init', async (_, input) => {
        return deps.initialize(input);
    });
    ipcMain.handle('switchboard:read-all', async (_, input) => {
        return deps.readAll(input);
    });
    ipcMain.handle('switchboard:create-task', async (_, input) => {
        return deps.createTask(input);
    });
    ipcMain.handle('switchboard:update-task', async (_, input) => {
        return deps.updateTask(input);
    });
    ipcMain.handle('switchboard:move-task', async (_, input) => {
        return deps.moveTask(input);
    });
    ipcMain.handle('switchboard:promote-inbox-task', async (_, input) => {
        return deps.promoteInboxTask(input);
    });
    ipcMain.handle('switchboard:cancel-task', async (_, input) => {
        return deps.cancelTask(input);
    });
    ipcMain.handle('switchboard:add-comment', async (_, input) => {
        return deps.addComment(input);
    });
    ipcMain.handle('switchboard:claim-task', async (_, input) => {
        return deps.claimTask(input);
    });
    ipcMain.handle('switchboard:publish-task', async (_, input) => {
        return deps.publishTask(input);
    });
    ipcMain.handle('switchboard:recover-lock', async (_, input) => {
        return deps.recoverLock(input);
    });
    ipcMain.handle('switchboard:requeue-task', async (_, input) => {
        return deps.requeueTask(input);
    });
    ipcMain.handle('switchboard:runner:start', async (_, input) => {
        return deps.startRunner(input);
    });
    ipcMain.handle('switchboard:runner:pause', async (_, workspaceRoot) => {
        return deps.pauseRunner(workspaceRoot);
    });
    ipcMain.handle('switchboard:runner:resume', async (_, input) => {
        return deps.resumeRunner(input);
    });
    ipcMain.handle('switchboard:runner:stop', async (_, workspaceRoot) => {
        return deps.stopRunner(workspaceRoot);
    });
    ipcMain.handle('switchboard:runner:tick', async (_, input) => {
        return deps.tickRunner(input);
    });
    ipcMain.handle('switchboard:runner:state', async (_, input) => {
        return deps.getRunnerState(input);
    });
    ipcMain.handle('switchboard:execution:stop', async (_, input) => {
        return deps.stopExecution(input);
    });
    ipcMain.handle('switchboard:execution:status', async (_, input) => {
        return deps.getExecutionStatus(input);
    });
    ipcMain.handle('switchboard:execution:logs', async (_, input) => {
        return deps.getExecutionLogs(input);
    });
    ipcMain.handle('switchboard:watchtower:start-review', async (_, input) => {
        return deps.startWatchtowerReview(input);
    });
    ipcMain.handle('switchboard:watchtower:start-triage', async (_, input) => {
        return deps.startWatchtowerTriage(input);
    });
    ipcMain.handle('switchboard:watchtower:get-run', async (_, input) => {
        return deps.getWatchtowerRun(input);
    });
    ipcMain.handle('switchboard:watchtower:list-runs', async (_, workspaceRoot) => {
        return deps.listWatchtowerRuns(workspaceRoot);
    });
    ipcMain.handle('switchboard:import:github-issues', async (_, workspaceRoot) => {
        return deps.importGitHubIssues(workspaceRoot);
    });
    ipcMain.handle('switchboard:import:jira-issues', async (_, workspaceRoot) => {
        return deps.importJiraIssues(workspaceRoot);
    });
}
