import type { SprintEngineProjectionReadResult } from '../../../shared/electron-api';
import type { RunStateReader } from './engine';
export type WriteBackProjectionReader = {
    readProjection(input: {
        statePath: string;
    }): Promise<SprintEngineProjectionReadResult>;
};
export declare function createRunStateReader(reader: WriteBackProjectionReader): RunStateReader;
