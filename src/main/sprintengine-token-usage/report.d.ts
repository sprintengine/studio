import type { AgentCli } from '../../shared/electron-api';
import { type SprintEngineTokenUsageReport } from '../../shared/sprintengine-token-usage';
import type { SessionTokenUsage, TokenUsageDeps } from './types';
export type SprintEngineTokenReportDeps = TokenUsageDeps & {
    readUsage?: (cli: AgentCli, cliSessionId: string, deps?: TokenUsageDeps) => Promise<SessionTokenUsage>;
};
export declare function computeSprintEngineTokenUsageReport(statePath: string, deps?: SprintEngineTokenReportDeps): Promise<SprintEngineTokenUsageReport>;
