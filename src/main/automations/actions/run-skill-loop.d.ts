import type { AutomationActionProvider } from '../../../shared/automations/contracts';
import { type SpawnAgentRuntime } from './spawn-agent';
export type RunSkillLoopConfig = {
    folderPath?: string;
    workspaceId?: string;
    cli?: string;
    name?: string;
    prompt: string;
    skill?: string;
    requiredIntegrations?: string[];
    includeTriggerContext?: boolean;
};
export declare function createRunSkillLoopActionProvider(): AutomationActionProvider;
export declare function runSkillLoopAction(config: unknown, runtime: SpawnAgentRuntime): Promise<Partial<import("../../../shared/automations/contracts").AutomationRun>>;
