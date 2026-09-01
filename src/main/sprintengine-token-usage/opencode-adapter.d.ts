import { type FetchLike, type ModelTokenUsage } from './types';
export declare function readOpenCodeUsage(cliSessionId: string, env: NodeJS.ProcessEnv, fetchImpl: FetchLike): Promise<ModelTokenUsage[] | null>;
