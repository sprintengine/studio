import type { AgentConfigAdoptInput, AgentConfigAdoptResult, AgentConfigDetectInput, AgentConfigDetectResult, BuiltinSkill, BuiltinSkillInstallResult } from '../shared/electron-api';
import { type McpConfigService } from './mcp-config-service';
type BuiltinSkillInstaller = {
    list(): Promise<BuiltinSkill[]>;
    install(workspaceRoot: string | null, skillId: string): Promise<BuiltinSkillInstallResult>;
};
export type AgentConfigImportService = {
    detect(input?: AgentConfigDetectInput): Promise<AgentConfigDetectResult>;
    adopt(input: AgentConfigAdoptInput): Promise<AgentConfigAdoptResult>;
};
export type AgentConfigImportServiceOptions = {
    mcpConfigService: Pick<McpConfigService, 'sync'>;
    builtinSkillManager: BuiltinSkillInstaller;
    homeDir?: () => string;
};
export declare function createAgentConfigImportService(options: AgentConfigImportServiceOptions): AgentConfigImportService;
export {};
