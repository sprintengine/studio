import { type ModelTokenUsage } from './types';
export declare function readClaudeCodeUsage(cliSessionId: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<ModelTokenUsage[] | null>;
