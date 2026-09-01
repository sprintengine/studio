import { BrowserWindow, type IpcMain } from 'electron';
import type { AuxWindowKind } from '../../shared/electron-api';
type WindowBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export declare function sendWindowState(win: BrowserWindow): void;
export declare function sendWindowPlacement(win: BrowserWindow): void;
type RegisterWindowIpcOptions = {
    createWorkspaceWindow(input: {
        windowId: string;
        bounds?: WindowBounds | null;
        isMaximized?: boolean;
    }): void;
    confirmWindowClose(win: BrowserWindow): void;
    openAuxWindow(input: {
        kind: AuxWindowKind;
        singletonKey: string;
        params: Record<string, string>;
        bounds?: WindowBounds | null;
    }): {
        retargeted: boolean;
    };
};
export declare function registerWindowIpc(ipcMain: IpcMain, options: RegisterWindowIpcOptions): void;
export {};
