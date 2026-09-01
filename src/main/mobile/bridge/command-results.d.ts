import type { MobileControlCommand, MobileSprintEngineCommandResult } from '../sprintengine/command';
import type { MobileControlErrorCode, RelayCommandEnvelope } from './index';
export declare const relayResultSummaryMaxBytes: number;
export declare function relaySummaryByteLength(value: unknown): number;
export declare function acceptedBridgeCommand(command: MobileControlCommand, data: unknown): Extract<MobileSprintEngineCommandResult, {
    ok: true;
}>;
export declare function failedCommandResult(command: Pick<MobileControlCommand, 'commandId' | 'type' | 'idempotencyKey'> | RelayCommandEnvelope, code: MobileControlErrorCode, message: string): Extract<MobileSprintEngineCommandResult, {
    ok: false;
}>;
export declare function summarizeCommandResult(result: MobileSprintEngineCommandResult): Record<string, unknown>;
