import type { BacklogReadResult } from '../../../shared/electron-api';
import type { ProxyItemLookup } from './engine';
export type ProxyItemLookupDeps = {
    readObjectStore(workspaceRoot: string): Promise<BacklogReadResult>;
    readItemFrontmatter(workspaceRoot: string, relativePath: string): Promise<Record<string, string> | null>;
};
export declare function createProxyItemLookup(deps?: ProxyItemLookupDeps): ProxyItemLookup;
