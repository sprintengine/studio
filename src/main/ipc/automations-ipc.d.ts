import type { AutomationActionProvider, AutomationDefinition, AutomationDefinitionDraft, AutomationTriggerProvider, AutomationsDefinitionResult, AutomationsResult, AutomationsRunNowResult as AutomationsRunNowIpcResult } from '../../shared/automations/contracts';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import { type AutomationsInstanceProjectFolder } from '../automations/instance-index';
import { type AutomationsEngine } from '../automations/engine';
import { type AutomationProviderPermissionChecker, type RegisteredAutomationProvider } from '../automations/provider-registry';
import { AutomationsStore } from '../automations/store';
import type { IpcInvokeHandler, SidecarRuntimeStatus } from '../module-host/main-host';
export type AutomationsIpcHost = {
    registerIpc(channel: string, handler: IpcInvokeHandler): void;
};
export type AutomationsIpcDependencies = {
    engine: Pick<AutomationsEngine, 'runNow' | 'finalizeRun'>;
    createStore?: (workspaceRoot: string) => AutomationsStore;
    triggerProviders?: AutomationTriggerProvider[];
    actionProviders?: AutomationActionProvider[];
    triggerProviderRegistrations?: RegisteredAutomationProvider<AutomationTriggerProvider>[];
    actionProviderRegistrations?: RegisteredAutomationProvider<AutomationActionProvider>[];
    getTriggerProviders?: () => AutomationTriggerProvider[];
    getActionProviders?: () => AutomationActionProvider[];
    getTriggerProviderRegistrations?: () => RegisteredAutomationProvider<AutomationTriggerProvider>[];
    getActionProviderRegistrations?: () => RegisteredAutomationProvider<AutomationActionProvider>[];
    checkProviderPermission?: AutomationProviderPermissionChecker;
    isIntegrationAvailable?: (id: string) => boolean | undefined;
    getWorkspaceSyncSnapshot?: () => WorkspaceSyncSnapshot;
    /**
     * Known project roots the instance-wide index scans. Defaults to deriving them
     * from the workspace-sync snapshot (every open workspace's folder, deduped) —
     * the same source the engine and webhook receiver use — so the module normally
     * omits it.
     */
    getProjectFolders?: () => AutomationsInstanceProjectFolder[];
    /**
     * Reads the kernel-tracked status of the Automations engine/scheduler sidecar
     * (kernel.sidecarStatuses() filtered to this module's sidecar, via the handle
     * registerSidecar returns). Absent/undefined means the sidecar is not wired,
     * which the engine-status channel reports as 'unavailable'.
     */
    getEngineSidecarStatus?: () => SidecarRuntimeStatus | undefined;
    onDefinitionsChanged?: (workspaceRoot: string) => void | Promise<void>;
    now?: () => number;
    createAutomationId?: (draft: AutomationDefinitionDraft) => string;
};
export declare function registerAutomationsIpc(host: AutomationsIpcHost, deps: AutomationsIpcDependencies): AutomationsAppFrontDoor;
/**
 * What a marketplace install landed: the definition (existing one when the
 * project already had this catalogue entry) and the project it lives in, so the
 * caller can name the target it used rather than leaving the user to guess.
 */
export type AutomationsCatalogueInstall = {
    definition: AutomationDefinition;
    alreadyAdded: boolean;
    workspaceRoot: string;
};
export type AutomationsCatalogueInstallResult = AutomationsResult<AutomationsCatalogueInstall>;
export type AutomationsAppFrontDoor = {
    createDefinition(input: unknown): Promise<AutomationsDefinitionResult>;
    updateDefinition(input: unknown): Promise<AutomationsDefinitionResult>;
    /**
     * Adds a marketplace catalogue entry's automation to a project. The
     * marketplace install path reaches the automations store only through here —
     * there is no file for it to copy, so this is its equivalent of the
     * `.agents/<kind>/` unpack every other component kind does.
     */
    installCatalogueDefinition(input: unknown): Promise<AutomationsCatalogueInstallResult>;
    runNow(input: unknown): Promise<AutomationsRunNowIpcResult>;
};
