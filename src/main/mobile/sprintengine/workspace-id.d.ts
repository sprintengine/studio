export declare function deriveWorkspaceId(workspaceRoot: string): string;
export declare function isWorkspaceIdToken(value: string): boolean;
export declare function resolveWorkspaceIdToRoot(workspaceId: string, candidateRoots: readonly string[]): string | null;
export declare function workspaceRootFromStatePath(statePath: string): string;
