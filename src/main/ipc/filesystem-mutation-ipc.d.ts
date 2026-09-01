import type { IpcMain } from 'electron';
type FilesystemMutationIpcDependencies = {
    assertNotDirectSprintEngineStateMutation(targetPath: string): Promise<void>;
    getUniqueCopyPath(destinationDir: string, sourceName: string, sourcePath: string): Promise<string>;
    pathExists(targetPath: string): Promise<boolean>;
    trashItem(targetPath: string): Promise<void>;
};
export declare function registerFilesystemMutationIpc(ipcMain: IpcMain, deps: FilesystemMutationIpcDependencies): void;
export {};
