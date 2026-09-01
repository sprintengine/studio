import { MAX_IMAGE_DATA_URL_BYTES, MAX_TEXT_FILE_READ_BYTES } from './filesystem-read-limits';
import { checkWorkspaceFolder, pathExists } from './filesystem-workspace';
export { MAX_IMAGE_DATA_URL_BYTES, MAX_TEXT_FILE_READ_BYTES, };
export declare function createFilesystemReadHandlers(): {
    detectProjectLogo(folderPath: string): Promise<import("../shared/electron-api").ProjectLogo | null>;
    readDirectory(dirPath: string): Promise<{
        name: string;
        isDir: boolean;
    }[]>;
    readTextFile(filePath: string): Promise<string>;
    readImageDataUrl(filePath: string): Promise<string>;
    statPath(targetPath: string): Promise<{
        isFile: boolean;
        isDirectory: boolean;
        sizeBytes: number;
        modifiedAt: string;
        modifiedAtMs: number;
    }>;
    pathExists: typeof pathExists;
    checkWorkspaceFolder: typeof checkWorkspaceFolder;
    showItemInFolder(targetPath: string): Promise<void>;
    openHtmlFileInBrowser(targetPath: string): Promise<void>;
};
export declare function assertReportSymlinkContained(filePath: string): Promise<void>;
export declare function looksLikeBinary(content: Buffer): boolean;
