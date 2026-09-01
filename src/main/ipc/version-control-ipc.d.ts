import type { IpcMain } from 'electron';
import { type VersionControlProbeDeps } from './version-control-probe';
export declare function createVersionControlProbeDeps(): VersionControlProbeDeps;
export declare function registerVersionControlIpc(ipcMain: IpcMain, deps?: VersionControlProbeDeps): void;
