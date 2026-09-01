import type { BacklogReadResult } from '../../shared/electron-api';
export type ConnectionSampleIssue = {
    externalId: string;
    nativeKey: string;
};
export type ConnectionSampleIssueDeps = {
    readObjectStore(workspaceRoot: string): Promise<BacklogReadResult>;
    readItemFrontmatter(workspaceRoot: string, relativePath: string): Promise<Record<string, string> | null>;
};
export declare function resolveConnectionSampleIssue(workspaceRoot: string, connectionId: string, deps?: ConnectionSampleIssueDeps): Promise<ConnectionSampleIssue | null>;
