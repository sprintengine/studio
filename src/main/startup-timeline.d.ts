import type { IpcMain } from 'electron';
import { type StartupMarkId } from '../shared/startup-timeline';
export declare function startupTimelineEnabled(): boolean;
export declare function markStartup(id: StartupMarkId): void;
export declare function attachStartupTimeline(ipcMain: IpcMain): void;
