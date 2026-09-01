import type { IpcMain } from 'electron';
import type { SprintRuntime } from '../sprint-runtime';
type SprintRuntimeIpcDependencies = {
    sprintRuntime: Pick<SprintRuntime, 'registerRun' | 'unregisterRun' | 'applyStopReason' | 'applyResume'>;
};
export declare function registerSprintRuntimeIpc(ipcMain: IpcMain, deps: SprintRuntimeIpcDependencies): void;
export {};
