type RunnerLockOwner = {
    pid: number;
    workspaceRoot: string;
    appInstanceId: string;
    createdAt: string;
    heartbeatAt: string;
};
type HeldRunnerLock = {
    workspaceRoot: string;
    lockDir: string;
    ownerPath: string;
    owner: RunnerLockOwner;
    heartbeat: NodeJS.Timeout | null;
};
type RunnerLockAcquireResult = {
    ok: true;
    lock: HeldRunnerLock;
} | {
    ok: false;
    message: string;
};
export declare const APP_INSTANCE_ID: `${string}-${string}-${string}-${string}-${string}`;
export declare function acquireWorkspaceRunnerLock(workspaceRoot: string): Promise<RunnerLockAcquireResult>;
export declare function releaseWorkspaceRunnerLock(workspaceRoot: string): Promise<void>;
export declare function releaseAllWorkspaceRunnerLocks(): Promise<void>;
export {};
