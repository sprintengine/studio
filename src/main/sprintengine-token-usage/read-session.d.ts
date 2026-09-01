import type { AgentCli } from '../../shared/electron-api';
import type { SessionTokenUsage, TokenUsageDeps } from './types';
export declare function readSessionTokenUsage(cli: AgentCli, cliSessionId: string, deps?: TokenUsageDeps): Promise<SessionTokenUsage>;
