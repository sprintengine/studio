import { stat } from 'node:fs/promises';
import { type IpcMain } from 'electron';
export declare const TEST_OPEN_DIR_ENV = "MULTICODE_TEST_OPEN_DIR";
export type TestOpenDirOverrideOptions = {
    isPackaged: boolean;
    env?: NodeJS.ProcessEnv;
    statPath?: typeof stat;
};
export declare function resolveTestOpenDirOverride({ isPackaged, env, statPath, }: TestOpenDirOverrideOptions): Promise<string | null>;
export declare function registerMenuDialogIpc(ipcMain: IpcMain): void;
