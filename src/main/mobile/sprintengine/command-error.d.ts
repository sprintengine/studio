import type { MobileControlError } from './command';
export declare class MobileSprintEngineCommandError extends Error {
    readonly code: MobileControlError['code'];
    readonly retryable: boolean;
    constructor(code: MobileControlError['code'], message: string, retryable: boolean);
}
export declare function getMobileSprintEngineCommandErrorMessage(error: unknown): string;
