import { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND, type AutomationTriggerProvider, type SprintEngineRunLandedTriggerConfig } from '../../../shared/automations/contracts';
import { type SprintEngineAutomationFrontDoors } from '../actions/sprint-engine';
export { SPRINT_ENGINE_RUN_LANDED_TRIGGER_KIND };
export type { SprintEngineRunLandedTriggerConfig };
export declare const LANDED_CONFIRMATION_MS: number;
type SprintEngineRunLandedValidationResult = {
    ok: true;
    value: SprintEngineRunLandedTriggerConfig;
} | {
    ok: false;
    error: string;
};
export declare function createSprintEngineRunLandedTriggerProvider(frontDoors: Pick<SprintEngineAutomationFrontDoors, 'readProjection' | 'refreshPullRequestStatus'>): AutomationTriggerProvider;
export declare function validateSprintEngineRunLandedTriggerConfig(config: unknown): SprintEngineRunLandedValidationResult;
