import type { AutomationActionProvider } from '../../../shared/automations/contracts';
import type { SwitchboardReadResult, SwitchboardRunnerResult, SwitchboardRunnerWorkspaceInput, WatchtowerRunResult, WatchtowerStartReviewInput } from '../../../shared/switchboard';
export declare const SWITCHBOARD_AUTOMATION_INTEGRATION_ID = "module:switchboard";
export declare const WATCHTOWER_AUTOMATION_INTEGRATION_ID = "module:watchtower";
export declare const SWITCHBOARD_RUNNER_TICK_ACTION_KIND = "switchboard-runner-tick";
export declare const WATCHTOWER_REVIEW_ACTION_KIND = "watchtower-review";
export type SwitchboardAutomationFrontDoors = {
    readAllTasks(input: {
        workspaceRoot: string;
    }): Promise<SwitchboardReadResult>;
    tickRunner(input: SwitchboardRunnerWorkspaceInput): Promise<SwitchboardRunnerResult>;
    startWatchtowerReview(input: WatchtowerStartReviewInput): Promise<WatchtowerRunResult>;
};
export declare function createSwitchboardAutomationActionProviders(frontDoors: SwitchboardAutomationFrontDoors): AutomationActionProvider[];
