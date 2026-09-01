import type { IpcMain } from 'electron';
import { type FolderOpenTargetAvailability, type FolderOpenTargetId } from '../../shared/folder-open-targets';
/**
 * How a target is launched. `reveal` is the OS file manager and goes through
 * the existing show-item-in-folder path; `command` is an argv spawn — the
 * editor's own CLI, or `open -a <bundle>` on macOS when only the app is
 * installed. The folder path is always appended as the final argv element, so
 * no path text is ever interpreted as a flag or shell syntax.
 */
export type FolderOpenLauncher = {
    kind: 'reveal';
} | {
    kind: 'command';
    command: string;
    args: string[];
};
export type LauncherProbe = {
    platform: NodeJS.Platform;
    env: NodeJS.ProcessEnv;
    exists(candidatePath: string): boolean;
};
type LaunchOutcome = {
    ok: true;
} | {
    ok: false;
    message: string;
};
export type FolderOpenIpcDependencies = {
    showItemInFolder(targetPath: string): Promise<void>;
    resolveLauncher(target: FolderOpenTargetId): FolderOpenLauncher | null;
    runLauncher(command: string, args: string[]): Promise<LaunchOutcome>;
    /** Rejects when the folder cannot be reached; same rule show-item-in-folder applies. */
    assertPathReachable(targetPath: string): Promise<void>;
};
/**
 * The editor probe, as a plain call. Shared by the `fs:folder-open-targets`
 * handler and the boot-discovery pass so both answer "which editors are
 * installed" the same way. Cheap and synchronous — it walks PATH and
 * /Applications with `existsSync` and spawns nothing — so it needs no cache.
 */
export declare function listFolderOpenTargetAvailability(resolveLauncher: (target: FolderOpenTargetId) => FolderOpenLauncher | null): FolderOpenTargetAvailability[];
/** `resolveFolderOpenLauncher` against the real machine. */
export declare function resolveFolderOpenLauncherHere(target: FolderOpenTargetId): FolderOpenLauncher | null;
export declare function registerFolderOpenIpc(ipcMain: IpcMain, deps: FolderOpenIpcDependencies): void;
export declare function createFolderOpenIpcDependencies(showItemInFolder: (targetPath: string) => Promise<void>): FolderOpenIpcDependencies;
/**
 * The single source of truth for both channels: availability is "this returns a
 * launcher", so the menu can never offer an editor the open action would fail
 * to start. The file manager always resolves.
 */
export declare function resolveFolderOpenLauncher(target: FolderOpenTargetId, probe: LauncherProbe): FolderOpenLauncher | null;
export {};
