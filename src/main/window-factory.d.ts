import { BrowserWindow } from 'electron';
import type { WindowMaterial } from '../shared/electron-api';
type CreateMainWindowOptions = {
    diagnosticsEnabled: boolean;
    windowId?: string;
    bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    isMaximized?: boolean;
    deferShow?: boolean;
};
export declare function applyWindowMaterialToWorkspaceWindows(material: WindowMaterial): void;
export declare function revealMainWindow(win: BrowserWindow): void;
export declare function markAppQuitInProgressForWindowClose(): void;
export declare function confirmWorkspaceWindowClose(win: BrowserWindow): void;
export declare function createMainWindow({ diagnosticsEnabled, windowId, bounds, isMaximized, deferShow, }: CreateMainWindowOptions): BrowserWindow;
export declare function createDiagnosticsWindow(): BrowserWindow;
export type AuxWindowKind = 'diff' | 'file';
type CreateAuxWindowOptions = {
    kind: AuxWindowKind;
    singletonKey: string;
    params: Record<string, string>;
    bounds?: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
};
export declare function openAuxWindow({ kind, singletonKey, params, bounds, }: CreateAuxWindowOptions): {
    retargeted: boolean;
};
export {};
