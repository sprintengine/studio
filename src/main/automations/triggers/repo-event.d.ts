import { REPO_EVENT_TRIGGER_KIND, type AutomationTriggerProvider, type RepoEventTriggerConfig } from '../../../shared/automations/contracts';
import { type SwitchboardAutomationFrontDoors } from '../actions/switchboard';
export { REPO_EVENT_TRIGGER_KIND };
export type { RepoEventTriggerConfig };
type RepoEventTriggerValidationResult = {
    ok: true;
    value: RepoEventTriggerConfig;
} | {
    ok: false;
    error: string;
};
export declare function createRepoEventTriggerProvider(frontDoors: Pick<SwitchboardAutomationFrontDoors, 'readAllTasks'>): AutomationTriggerProvider;
export declare function validateRepoEventTriggerConfig(config: unknown): RepoEventTriggerValidationResult;
