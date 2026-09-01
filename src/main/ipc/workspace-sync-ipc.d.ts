import { type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { WorkspaceSyncService } from '../workspace-sync-service';
import type { WorkspaceRegistryService } from '../workspace-registry-service';
type BroadcastTarget = {
    isDestroyed(): boolean;
    webContents: WebContents;
};
type RegisterWorkspaceSyncIpcOptions = {
    listWindows?: () => BroadcastTarget[];
    getSourceWindowId?: (event: IpcMainInvokeEvent) => string;
    /**
     * The registry behind the bus, for the one-time localStorage hydration
     * channel. Omitted in tests that only exercise the bus.
     */
    registry?: WorkspaceRegistryService;
};
export declare function registerWorkspaceSyncIpc(ipcMain: IpcMain, service: WorkspaceSyncService, options?: RegisterWorkspaceSyncIpcOptions): void;
export {};
