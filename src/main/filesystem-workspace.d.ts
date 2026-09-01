import type { WorkspaceFolderCheckResult } from '../shared/electron-api';
export declare function isMissingPathError(error: unknown): boolean;
export declare function pathExists(targetPath: string): Promise<boolean>;
export declare function checkWorkspaceFolder(targetPath: string): Promise<WorkspaceFolderCheckResult>;
