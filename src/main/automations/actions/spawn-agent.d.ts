import type { AutomationActionProvider, AutomationCliPermissionPreset, AutomationDefinition, AutomationRun } from '../../../shared/automations/contracts';
export type SpawnAgentConfig = {
    folderPath?: string;
    workspaceId?: string;
    cli?: string;
    cliModel?: string;
    permissionPreset: AutomationCliPermissionPreset;
    specialistId?: string;
    name?: string;
    prompt: string;
    requiredIntegrations?: string[];
    connectorId?: string;
    spawnSkillId?: string;
    includeTriggerContext?: boolean;
};
export type SpawnAgentRuntime = {
    definition: AutomationDefinition;
    runId: string;
    workspaceRoot: string;
    triggerPayload?: Record<string, unknown>;
    resolveSpawnAgentTarget(input: {
        workspaceId?: string;
        folderPath: string;
    }): Promise<SpawnAgentResolvedTarget>;
    spawnAgent(input: {
        workspaceId?: string;
        folderPath: string;
        resolvedTarget?: SpawnAgentResolvedTarget;
        cli?: string;
        cliModel?: string;
        permissionPreset?: AutomationCliPermissionPreset;
        specialistId?: string;
        name?: string;
        prompt: string;
        connectorId?: string;
        spawnSkillId?: string;
    }): Promise<{
        workspaceId: string;
        agentId: string;
        executionId?: string;
        worktreePath?: string;
        branch?: string;
    }>;
    requireIntegration(id: string): void;
};
export type SpawnAgentActionResult = Partial<AutomationRun>;
export type SpawnAgentResolvedTarget = {
    workspaceId?: string;
    folderPath: string;
};
export declare function createSpawnAgentActionProvider(): AutomationActionProvider;
export declare function runSpawnAgentAction(config: unknown, runtime: SpawnAgentRuntime): Promise<SpawnAgentActionResult>;
export declare function parseSpawnAgentConfig(config: unknown): SpawnAgentConfig;
export declare const WRITE_UP_ONLY_INSTRUCTION = "Open a pull request containing the write-up only; do not refactor.";
export declare function composeSpawnAgentPrompt(input: {
    userPrompt: string;
    automationId: string;
    runId: string;
    includeTriggerContext?: boolean;
    triggerPayload?: Record<string, unknown>;
    writeUpOnly?: boolean;
}): string;
export declare function fingerprintPrompt(prompt: string): string;
