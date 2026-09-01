import type { TerminalReapEvent } from '../shared/electron-api';
export declare const MAX_REAP_EVENTS = 200;
export declare function recordReapEvent(event: TerminalReapEvent): void;
export declare function listRecentReapEvents(): TerminalReapEvent[];
export declare function clearReapEvents(): void;
