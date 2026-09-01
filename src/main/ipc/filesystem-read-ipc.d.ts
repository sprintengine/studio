import type { IpcMain } from 'electron';
import type { FileSystemStat, ProjectLogo, WorkspaceFolderCheckResult } from '../../shared/electron-api';
export type FileSystemDirectoryEntry = {
    name: string;
    isDir: boolean;
};
type FilesystemReadIpcDependencies = {
    readDirectory(dirPath: string): Promise<FileSystemDirectoryEntry[]>;
    readTextFile(filePath: string): Promise<string>;
    readImageDataUrl(filePath: string): Promise<string>;
    pathExists(targetPath: string): Promise<boolean>;
    statPath(targetPath: string): Promise<FileSystemStat>;
    checkWorkspaceFolder(targetPath: string): Promise<WorkspaceFolderCheckResult>;
    detectProjectLogo(folderPath: string): Promise<ProjectLogo | null>;
    showItemInFolder(targetPath: string): Promise<void>;
    openHtmlFileInBrowser(targetPath: string): Promise<void>;
};
export declare function registerFilesystemReadIpc(ipcMain: IpcMain, deps: FilesystemReadIpcDependencies): void;
export {};
