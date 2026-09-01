import type { MobileBridgeDiagnosticEntry, MobileBridgeState } from './index';
export declare function recordMobileBridgeDiagnostic(diagnostics: MobileBridgeDiagnosticEntry[], level: MobileBridgeDiagnosticEntry['level'], code: MobileBridgeDiagnosticEntry['code'], message: string, retryable: boolean): MobileBridgeDiagnosticEntry[];
export declare function emitMobileBridgeStateChanged(state: MobileBridgeState): void;
