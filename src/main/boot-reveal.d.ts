export declare const BOOT_REVEAL_TIMEOUT_MS = 10000;
export type BootRevealTimers = {
    setTimer: (handler: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
};
export type BootRevealOptions = {
    reveal: () => void;
    timeoutMs?: number;
    timers?: BootRevealTimers;
};
export type BootReveal = {
    trigger: () => void;
    get revealed(): boolean;
};
export declare function createBootReveal({ reveal, timeoutMs, timers, }: BootRevealOptions): BootReveal;
