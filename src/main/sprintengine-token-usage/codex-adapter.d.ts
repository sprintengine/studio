import { type ModelTokenUsage } from './types';
export declare function readCodexUsage(cliSessionId: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<ModelTokenUsage[] | null>;
