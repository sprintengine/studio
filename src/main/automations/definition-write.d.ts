import type { AutomationActionProvider, AutomationDefinition, AutomationDefinitionDraft, AutomationTriggerProvider, AutomationsResult } from '../../shared/automations/contracts';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import { type AutomationProviderPermissionChecker, type RegisteredAutomationProvider } from './provider-registry';
import { AutomationsStore, type AutomationStoreProblem } from './store';
export type ParsedDefinitionPatch = Partial<Pick<AutomationDefinition, 'name' | 'status' | 'trigger' | 'condition' | 'action' | 'runInWorktree' | 'disableAfterRun'>>;
/**
 * A marketplace catalogue entry's automation payload, plus the provenance the
 * host stamps onto the record it creates. `payload` stays `unknown` — the parse
 * below is the authoritative one; the bundle manifest's structural check is not.
 */
export type CatalogueDefinitionInstallInput = {
    payload: unknown;
    sourceCatalogueId: string;
    sourcePublisher?: string;
};
export type CatalogueDefinitionInstall = {
    definition: AutomationDefinition;
    /** True when the project already had this catalogue entry: nothing was written. */
    alreadyAdded: boolean;
};
export type DefinitionWriteDeps = {
    createStore: (workspaceRoot: string) => AutomationsStore;
    getTriggerProviderRegistrations: () => RegisteredAutomationProvider<AutomationTriggerProvider>[];
    getActionProviderRegistrations: () => RegisteredAutomationProvider<AutomationActionProvider>[];
    checkProviderPermission: AutomationProviderPermissionChecker;
    now: () => number;
    createAutomationId?: (draft: AutomationDefinitionDraft) => string;
    /**
     * The zone a catalogue schedule is resolved into at install. Defaults to the
     * host's own IANA zone, which is what the renderer's editor already stamps on
     * a schedule the user authors — injected only so tests can install as a user
     * somewhere else.
     */
    hostTimeZone?: () => string;
    /**
     * Post-write hook (e.g. webhook receiver refresh, renderer notification). A
     * throw never fails the operation — the write already persisted — it is
     * surfaced as `postWriteFailure` on the success result for each front door
     * to report in its own vocabulary.
     */
    onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>;
};
export type PostWriteFailure = {
    code: string;
    message: string;
};
export type DefinitionWriteResult<T> = {
    ok: true;
    value: T;
    postWriteFailure?: PostWriteFailure;
} | {
    ok: false;
    code: string;
    message: string;
};
/**
 * Evaluated against the record read inside the same read→write sequence, so a
 * caller's guard (e.g. module ownership) cannot be split from the write by a
 * concurrent delete-and-recreate between two separate reads.
 */
export type DefinitionPrecondition = (existing: AutomationDefinition) => {
    ok: true;
} | {
    ok: false;
    code: string;
    message: string;
};
export type DefinitionWriteCore = {
    get(workspaceRoot: string, automationId: string): Promise<DefinitionWriteResult<AutomationDefinition>>;
    create(workspaceRoot: string, draft: AutomationDefinitionDraft): Promise<DefinitionWriteResult<AutomationDefinition>>;
    /**
     * The marketplace install path: parse a catalogue payload, resolve the install
     * defaults, stamp provenance, and create — or report the entry as already
     * added when this project has it. The third front door onto this core, so a
     * shelf install gets the same validation, next-run computation, next-run cache
     * write and definitions-changed notification the panel and modules get.
     */
    installFromCatalogue(workspaceRoot: string, input: CatalogueDefinitionInstallInput): Promise<DefinitionWriteResult<CatalogueDefinitionInstall>>;
    update(workspaceRoot: string, automationId: string, patch: ParsedDefinitionPatch, precondition?: DefinitionPrecondition): Promise<DefinitionWriteResult<AutomationDefinition>>;
    remove(workspaceRoot: string, automationId: string, precondition?: DefinitionPrecondition): Promise<DefinitionWriteResult<{
        automationId: string;
    }>>;
};
export declare function createDefinitionWriteCore(deps: DefinitionWriteDeps): DefinitionWriteCore;
/**
 * A write may only target a folder the workspace-sync snapshot knows about:
 * anything else would create records the engine's project-folder scan never
 * schedules and no panel ever lists. Both front doors (user IPC, module
 * service) run this before touching a store. Returns the canonical folder
 * path on success.
 */
export declare function validateKnownWorkspaceRoot(workspaceRoot: string, getWorkspaceSyncSnapshot: (() => WorkspaceSyncSnapshot) | undefined): AutomationsResult<string>;
export declare function buildDefinitionForCreate(draft: AutomationDefinitionDraft, timestamp: string, createAutomationId?: (draft: AutomationDefinitionDraft) => string): AutomationDefinition;
export declare function prepareDefinitionForWrite(definition: AutomationDefinition, triggerProviders: RegisteredAutomationProvider<AutomationTriggerProvider>[], actionProviders: RegisteredAutomationProvider<AutomationActionProvider>[], checkProviderPermission: AutomationProviderPermissionChecker, after: number): AutomationsResult<AutomationDefinition>;
export declare function parseDefinitionDraft(input: unknown): AutomationsResult<AutomationDefinitionDraft>;
export declare function parseDefinitionPatch(input: unknown): AutomationsResult<ParsedDefinitionPatch>;
export declare function parseKindConfig(input: unknown, label: string): AutomationsResult<{
    kind: string;
    config: unknown;
}>;
export declare function storeError<T>(error: AutomationStoreProblem): AutomationsResult<T>;
