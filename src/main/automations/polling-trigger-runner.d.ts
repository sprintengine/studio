import type { AutomationDefinition, AutomationRun, AutomationTriggerPollContext, AutomationTriggerProvider } from '../../shared/automations/contracts';
import type { AutomationRunExecutor, AutomationsEngineEvaluationResult, AutomationsProjectFolder } from './engine';
import { AutomationsStore, type AutomationStoreState } from './store';
export { TRIGGER_EVENT_DEDUP_RETENTION_LIMIT } from './trigger-event-runner';
export type PollingTriggerEvaluationInput = {
    store: AutomationsStore;
    state: AutomationStoreState;
    projectFolder: AutomationsProjectFolder;
    definition: AutomationDefinition;
    triggerProvidersByKind: ReadonlyMap<string, AutomationTriggerProvider>;
    pollContext: AutomationTriggerPollContext;
    isIntegrationAvailable?: (id: string) => boolean | undefined;
    runAutomation: AutomationRunExecutor;
    now: () => number;
    createRunId: (input: {
        workspaceRoot: string;
        automationId: string;
        dueAt: string;
    }) => string;
    inFlight: Set<string>;
    emitRunEvent(input: {
        workspaceId?: string | null;
        definition: AutomationDefinition;
        run: AutomationRun;
    }): void;
    result: AutomationsEngineEvaluationResult;
};
export declare function evaluatePollingTriggerDefinition(input: PollingTriggerEvaluationInput): Promise<void>;
