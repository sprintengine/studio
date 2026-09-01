export type MemoryGraphNodeKind = 'markdown' | 'image' | 'text' | 'asset';
export type MemoryGraphNode = {
    id: string;
    path: string;
    relativePath: string;
    name: string;
    kind: MemoryGraphNodeKind;
    extension: string;
    sizeBytes: number;
    degree: number;
    inboundDegree: number;
    group: string;
    /** Frontmatter title, falling back to first H1 in body, otherwise undefined. */
    title?: string;
    /** Frontmatter type — used for graph color and the modal badge. */
    type?: string;
    /** Frontmatter tags (string[] or comma-separated). */
    tags?: string[];
    /** Frontmatter `related` + `depends-on`, normalised to relative paths when resolvable. */
    related?: string[];
};
export type MemoryGraphEdge = {
    id: string;
    source: string;
    target: string;
    sourcePath: string;
    targetPath: string;
};
export type MemoryUnresolvedLink = {
    sourcePath: string;
    href: string;
    resolvedRelativePath: string | null;
    reason: 'missing' | 'outside-root';
};
export type MemoryRootStatus = {
    ok: true;
    rootPath: string;
    relativeRoot: string;
} | {
    ok: false;
    status: 'missing-workspace' | 'invalid-relative-path' | 'missing-memory-root' | 'inaccessible';
    relativeRoot: string | null;
    message: string;
};
export type MemoryGraphIndexResult = {
    ok: true;
    rootPath: string;
    relativeRoot: string;
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
    groups: string[];
    unresolvedLinks: MemoryUnresolvedLink[];
    indexedAt: number;
} | MemoryRootStatus;
export type MemoryPreviewResult = {
    ok: true;
    node: MemoryGraphNode;
    previewKind: 'markdown' | 'text';
    content: string;
} | {
    ok: true;
    node: MemoryGraphNode;
    previewKind: 'image';
    dataUrl: string;
} | {
    ok: true;
    node: MemoryGraphNode;
    previewKind: 'unsupported';
    message: string;
} | {
    ok: false;
    message: string;
};
export declare function normalizeMemoryRelativeRoot(value: string | null | undefined): string | null;
export declare function resolveMemoryRoot(workspaceRoot: string | null | undefined, relativeRootInput: string | null | undefined): Promise<MemoryRootStatus>;
export declare function indexMemoryGraph(workspaceRoot: string | null | undefined, relativeRootInput: string | null | undefined): Promise<MemoryGraphIndexResult>;
export declare function readMemoryPreview(workspaceRoot: string | null | undefined, relativeRootInput: string | null | undefined, relativePathInput: string): Promise<MemoryPreviewResult>;
