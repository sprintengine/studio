import { type IpcMain } from 'electron';
import type { ContentSearchResult, FileSearchResult } from '../../shared/electron-api';
type FileSearchRequest = {
    rootPath: string;
    query: string;
    limit?: number;
    excludes?: string[];
};
type ContentSearchRequest = FileSearchRequest;
type FilesystemWatchSearchIpcDependencies = {
    pathExists(targetPath: string): Promise<boolean>;
    isMissingPathError(error: unknown): boolean;
    searchFiles(senderId: number, input: FileSearchRequest): Promise<FileSearchResult>;
    searchContent(senderId: number, input: ContentSearchRequest): Promise<ContentSearchResult>;
    cancelActiveContentSearch(senderId: number): void;
};
export declare function registerFilesystemWatchSearchIpc(ipcMain: IpcMain, deps: FilesystemWatchSearchIpcDependencies): void;
export {};
