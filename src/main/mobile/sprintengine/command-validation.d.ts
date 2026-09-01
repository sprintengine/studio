import type { MobileControlCommand, MobileControlError } from './command';
type ValidationResult<T> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: MobileControlError;
};
export declare function validateMobileControlCommand(input: unknown): ValidationResult<MobileControlCommand>;
export declare function buildError(code: MobileControlError['code'], message: string, retryable: boolean): MobileControlError;
export {};
