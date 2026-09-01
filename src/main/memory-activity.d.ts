export type ActivityEvent = {
    workspaceRoot: string;
    sessionId: string;
    nodeId: string;
    prevNodeId: string | null;
    tool: string;
    ts: number;
    synapseCount: number;
};
export type ActivitySynapseSnapshot = {
    src: string;
    dst: string;
    count: number;
    lastTs: number;
};
export type ActivityStatus = {
    workspaceRoot: string | null;
    isInstalled: boolean;
    isWatching: boolean;
    sessionsRecorded: number;
    totalEvents: number;
    eventsToday: number;
    lastEventAt: number | null;
};
export type ActivityInstallResult = {
    ok: true;
    settingsPath: string;
    hookScriptPath: string;
} | {
    ok: false;
    message: string;
};
export type ActivityUninstallResult = {
    ok: true;
} | {
    ok: false;
    message: string;
};
export declare function installMemoryActivityHook(workspaceRoot: string, memoryRelativeRoot: string): Promise<ActivityInstallResult>;
export declare function uninstallMemoryActivityHook(workspaceRoot: string): Promise<ActivityUninstallResult>;
export declare function isMemoryActivityInstalled(workspaceRoot: string): Promise<boolean>;
export declare function startMemoryActivityWatcher(workspaceRoot: string, memoryRelativeRoot: string): Promise<void>;
export declare function stopMemoryActivityWatcher(workspaceRoot: string): void;
export declare function getMemoryActivityStatus(workspaceRoot: string | null): ActivityStatus;
export declare function getMemoryActivitySynapses(workspaceRoot: string): ActivitySynapseSnapshot[];
export declare function clearMemoryActivityHistory(workspaceRoot: string): Promise<void>;
