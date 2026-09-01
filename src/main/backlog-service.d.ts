import type { BacklogAddOrUpdateLinkInput, BacklogCreateEpicInput, BacklogCreateEpicResult, BacklogEnsureIdsInput, BacklogEnsureIdsResult, BacklogEpicColorInput, BacklogDependenciesInput, BacklogDependenciesPlannedInput, BacklogEpicInput, BacklogHighlightInput, BacklogItemRecordInput, BacklogMockupsInput, BacklogModuleMetadataInput, BacklogMutationResult, BacklogObjectRecordPayload, BacklogObjectStorePayload, BacklogReadResult, BacklogRemoveLinkInput, BacklogRemoveRecordInput, BacklogStatusInput, BacklogTriageInput, BacklogTypeInput, BacklogMoveSourceInput, BacklogWorkspaceKeyResult } from '../shared/electron-api';
export declare function isBacklogEpicRelativePath(relativePath: string): boolean;
type BacklogObjectRecord = BacklogObjectRecordPayload;
export declare function readBacklogObjectStore(workspaceRoot: string): Promise<BacklogReadResult>;
export declare function readBacklogWorkspaceKey(workspaceRoot: string): Promise<BacklogWorkspaceKeyResult>;
export declare function ensureBacklogItemIds(input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult>;
export type BacklogRecordFrontmatterMigration = {
    relativePath: string;
    updates: Record<string, string>;
};
export type BacklogStoreMigrationPlan = {
    migrations: BacklogRecordFrontmatterMigration[];
    slimRecords: Record<string, unknown>[];
    changed: boolean;
};
export declare function planBacklogStoreMigration(parsed: unknown): BacklogStoreMigrationPlan;
export type BacklogFrontmatterFields = {
    status?: BacklogObjectRecord['status'];
    type?: BacklogObjectRecord['type'];
    difficulty?: BacklogObjectRecord['difficulty'];
    criticality?: BacklogObjectRecord['criticality'];
    risk?: BacklogObjectRecord['risk'];
    epic?: string;
    dependsOn?: string[];
    dependenciesPlanned?: boolean;
};
export declare function readBacklogFrontmatterFields(content: string): BacklogFrontmatterFields;
export type BacklogListedItem = {
    relativePath: string;
    title: string;
    /** Frontmatter numeric id when assigned (display id = `<key>-<id>`). */
    id?: number;
    isEpic: boolean;
    isRoadmap?: boolean;
    status: BacklogObjectRecord['status'];
    type?: BacklogObjectRecord['type'];
    difficulty?: BacklogObjectRecord['difficulty'];
    criticality?: BacklogObjectRecord['criticality'];
    risk?: BacklogObjectRecord['risk'];
    epic?: string;
    dependsOn?: string[];
    dependenciesPlanned?: boolean;
};
export type BacklogListItemsResult = {
    ok: true;
    key: string | null;
    items: BacklogListedItem[];
} | {
    ok: false;
    message: string;
};
export declare function listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult>;
export type BacklogReadItemResult = {
    ok: true;
    item: BacklogListedItem;
    body: string;
} | {
    ok: false;
    message: string;
};
export declare function readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult>;
export type BacklogCreateInput = {
    workspaceRoot: string;
    title: string;
    description?: string;
    type?: string;
    difficulty?: string;
    criticality?: string;
    risk?: string;
    epic?: string;
};
export type BacklogCreateResult = {
    ok: true;
    id: string;
    relativePath: string;
    store: BacklogObjectStorePayload;
} | {
    ok: false;
    message: string;
};
export type BacklogIntegrityRepairInput = {
    workspaceRoot: string;
    relativePath: string;
    issue: 'embedded_nul' | 'duplicate_id';
};
export type BacklogIntegrityRepairResult = {
    ok: true;
    relativePath: string;
    issue: BacklogIntegrityRepairInput['issue'];
    replacements?: number;
    previousNumericId?: number;
    numericId?: number;
} | {
    ok: false;
    message: string;
};
export declare function createBacklogItem(input: BacklogCreateInput): Promise<BacklogCreateResult>;
export declare function repairBacklogIntegrity(input: BacklogIntegrityRepairInput): Promise<BacklogIntegrityRepairResult>;
export declare function createBacklogEpic(input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult>;
export type ProxyMaterializeInput = {
    workspaceRoot: string;
    provider: string;
    connectionId: string;
    externalId: string;
    externalKey: string;
    externalUrl: string;
    title: string;
    body: string;
};
export type ProxyMaterializeResult = {
    ok: true;
    outcome: 'added' | 'refreshed';
    relativePath: string;
} | {
    ok: false;
    message: string;
};
export declare function materializeProxyBacklogItem(input: ProxyMaterializeInput): Promise<ProxyMaterializeResult>;
export type ProxyUnavailableInput = {
    workspaceRoot: string;
    connectionId: string;
    externalId: string;
    providerLabel: string;
    reason: string;
};
export type ProxyUnavailableResult = {
    ok: true;
    found: boolean;
    relativePath?: string;
} | {
    ok: false;
    message: string;
};
export declare function markProxyBacklogItemUnavailable(input: ProxyUnavailableInput): Promise<ProxyUnavailableResult>;
export declare function ensureBacklogObjectRecords(workspaceRoot: string, items: BacklogItemRecordInput[]): Promise<BacklogReadResult>;
export declare function updateBacklogStatus(input: BacklogStatusInput): Promise<BacklogMutationResult>;
export declare function updateBacklogType(input: BacklogTypeInput): Promise<BacklogMutationResult>;
export declare function updateBacklogTriage(input: BacklogTriageInput): Promise<BacklogMutationResult>;
export declare function updateBacklogEpic(input: BacklogEpicInput): Promise<BacklogMutationResult>;
export declare function updateBacklogEpicColor(input: BacklogEpicColorInput): Promise<BacklogMutationResult>;
export declare function updateBacklogDependencies(input: BacklogDependenciesInput): Promise<BacklogMutationResult>;
export declare function updateBacklogDependenciesPlanned(input: BacklogDependenciesPlannedInput): Promise<BacklogMutationResult>;
export declare function updateBacklogMockups(input: BacklogMockupsInput): Promise<BacklogMutationResult>;
export declare function updateBacklogHighlight(input: BacklogHighlightInput): Promise<BacklogMutationResult>;
export declare function addOrUpdateBacklogLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult>;
export declare function removeBacklogLink(input: BacklogRemoveLinkInput): Promise<BacklogMutationResult>;
export declare function updateBacklogModuleMetadata(input: BacklogModuleMetadataInput): Promise<BacklogMutationResult>;
export declare function moveBacklogObjectSource(input: BacklogMoveSourceInput): Promise<BacklogMutationResult>;
export declare function removeBacklogObjectRecord(input: BacklogRemoveRecordInput): Promise<BacklogMutationResult>;
export {};
