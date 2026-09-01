import { type ModelTokenUsage } from './types';
export declare function readGrokUsage(cliSessionId: string, homeDir: string, env: NodeJS.ProcessEnv): Promise<ModelTokenUsage[] | null>;
