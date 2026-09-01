import { AGENT_CAPABILITIES_INVALIDATED_CHANNEL, AGENT_CAPABILITIES_WATCH_START_CHANNEL, AGENT_CAPABILITIES_WATCH_STOP_CHANNEL, } from '../../shared/skills';
export function registerWorkspaceSkillsIpc(ipcMain, services) {
    ipcMain.handle('skills:list-workspace', (_, input) => services.workspaceSkills.listWorkspaceSkills(input));
    ipcMain.handle('skills:agent-capabilities', (_, input) => services.agentCapabilities.resolve(input));
    ipcMain.handle('skills:agent-skill-attach', (_, input) => services.agentSkillInstaller.attach(input));
    ipcMain.handle('skills:agent-skill-remove', (_, input) => services.agentSkillInstaller.remove(input));
    // One subscription per (sender, workspace), refcounted in the watcher: the
    // first start attaches the watchers and the last stop tears them down. A
    // window that closes without stopping is released on `destroyed`; a window
    // that *reloads* keeps its sender id, and the re-subscribe is deduplicated by
    // that key, so it reuses the subscription instead of stacking a second one.
    const subscriptions = new Map();
    const trackedSenders = new Set();
    const key = (sender, workspaceRoot) => `${sender.id}::${workspaceRoot}`;
    ipcMain.handle(AGENT_CAPABILITIES_WATCH_START_CHANNEL, (event, input) => {
        const workspaceRoot = input.workspaceRoot?.trim();
        if (!workspaceRoot || subscriptions.has(key(event.sender, workspaceRoot)))
            return;
        const sender = event.sender;
        const release = services.capabilityWatcher.subscribe(workspaceRoot, (invalidation) => {
            if (sender.isDestroyed())
                return;
            sender.send(AGENT_CAPABILITIES_INVALIDATED_CHANNEL, invalidation);
        });
        subscriptions.set(key(sender, workspaceRoot), release);
        if (trackedSenders.has(sender.id))
            return;
        trackedSenders.add(sender.id);
        sender.once('destroyed', () => {
            trackedSenders.delete(sender.id);
            for (const [subscriptionKey, dispose] of subscriptions) {
                if (!subscriptionKey.startsWith(`${sender.id}::`))
                    continue;
                dispose();
                subscriptions.delete(subscriptionKey);
            }
        });
    });
    ipcMain.handle(AGENT_CAPABILITIES_WATCH_STOP_CHANNEL, (event, input) => {
        const workspaceRoot = input.workspaceRoot?.trim();
        if (!workspaceRoot)
            return;
        const subscriptionKey = key(event.sender, workspaceRoot);
        subscriptions.get(subscriptionKey)?.();
        subscriptions.delete(subscriptionKey);
    });
}
