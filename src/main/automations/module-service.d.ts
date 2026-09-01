import type { AutomationDefinition, AutomationRun, AutomationsRunEvent, ModuleAutomationsResult } from '../../shared/automations/contracts';
import type { WorkspaceSyncSnapshot } from '../../shared/workspace-sync';
import { type DefinitionWriteDeps } from './definition-write';
export type ModuleAutomationsRegistry = {
    create(moduleId: string, input: {
        workspaceRoot: string;
        draft: unknown;
    }): Promise<ModuleAutomationsResult<{
        automation: AutomationDefinition;
    }>>;
    update(moduleId: string, input: {
        workspaceRoot: string;
        automationId: string;
        patch: unknown;
    }): Promise<ModuleAutomationsResult<{
        automation: AutomationDefinition;
    }>>;
    delete(moduleId: string, input: {
        workspaceRoot: string;
        automationId: string;
    }): Promise<ModuleAutomationsResult<object>>;
    list(moduleId: string, input: {
        workspaceRoot: string;
    }): Promise<ModuleAutomationsResult<{
        automations: AutomationDefinition[];
    }>>;
    listRuns(moduleId: string, input: {
        workspaceRoot: string;
        automationId: string;
    }): Promise<ModuleAutomationsResult<{
        runs: AutomationRun[];
    }>>;
    onRunEvent(moduleId: string, listener: (event: AutomationsRunEvent) => void): () => void;
    /**
     * Engine-side fan-out entry: notify subscribers owning the event's
     * automation. The definition arrives from the engine's emit site (which
     * always has it), so ownership is never re-derived from the event's
     * workspaceId — that can name the run-hosting workspace, not the one whose
     * store holds the definition.
     */
    deliverRunEvent(event: AutomationsRunEvent, definition: AutomationDefinition): void;
    /** Drop all subscribers (automations module teardown). */
    dispose(): void;
};
export type ModuleAutomationsRegistryDeps = DefinitionWriteDeps & {
    /** Same snapshot the IPC front door validates workspace roots against. */
    getWorkspaceSyncSnapshot?: () => WorkspaceSyncSnapshot;
};
export declare function createModuleAutomationsRegistry(deps: ModuleAutomationsRegistryDeps): ModuleAutomationsRegistry;
