import type { MobileControlCommand, MobileSprintEngineCommandResult } from './command';
export type RememberedMobileSprintEngineCommandResult = {
    status: 'miss';
} | {
    status: 'conflict';
} | {
    status: 'hit';
    result: MobileSprintEngineCommandResult;
};
export declare function requestHashFor(command: MobileControlCommand): string;
export declare function cloneCommandResult(result: MobileSprintEngineCommandResult): MobileSprintEngineCommandResult;
export declare function idempotencyKeyForCommand(workspaceRoot: string, command: MobileControlCommand): string;
export declare function rememberedCommandResult(key: string, requestHash: string): RememberedMobileSprintEngineCommandResult;
export declare function rememberCommandResult(key: string, requestHash: string, result: MobileSprintEngineCommandResult): void;
