import type { AutomationDefinition, AutomationRun, AutomationTriggerPollEvent } from '../../shared/automations/contracts';
import type { AutomationRunExecutor, AutomationsEngineEvaluationResult, AutomationsEngineProblem, AutomationsEngineRunSummary, AutomationsProjectFolder } from './engine';
import { AutomationsStore, type AutomationStoreState } from './store';
export declare const TRIGGER_EVENT_DEDUP_RETENTION_LIMIT = 100;
export type TriggerEventRunResult = {
    status: 'duplicate';
} | {
    status: 'in_flight';
} | {
    status: 'fired';
    summary: AutomationsEngineRunSummary;
    run: AutomationRun;
} | {
    status: 'problem';
    problem: AutomationsEngineProblem;
};
export type TriggerEventRunInput = {
    store: AutomationsStore;
    state: AutomationStoreState;
    projectFolder: AutomationsProjectFolder;
    definition: AutomationDefinition;
    event: AutomationTriggerPollEvent;
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
    result?: AutomationsEngineEvaluationResult;
};
export declare function enqueueTriggerEventRun(input: TriggerEventRunInput): Promise<TriggerEventRunResult>;
export declare function clearTriggerBlockedReasonState(state: AutomationStoreState, automationId: string): void;
export declare function triggerEventInFlightKey(workspaceRoot: string, automationId: string): string;
