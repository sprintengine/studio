import type { AutomationTriggerProvider, ScheduleTriggerConfig } from '../../shared/automations/contracts';
export declare const MIN_INTERVAL_MINUTES = 5;
export type ScheduleValidationResult = {
    ok: true;
    value: ScheduleTriggerConfig;
} | {
    ok: false;
    error: string;
};
export declare const scheduleTriggerProvider: AutomationTriggerProvider;
export declare function validateScheduleTriggerConfig(config: unknown): ScheduleValidationResult;
/**
 * One-shot cadences legitimately run out: once an `at` automation's fire time
 * has passed, a null next run is the terminal "no upcoming run" state, not a
 * scheduling failure. Recurring cadences (interval/daily/weekly) must always
 * compute a next run, so null stays an error for them.
 */
export declare function scheduleCadenceCanExhaust(config: ScheduleTriggerConfig): boolean;
export declare function computeNextRun(config: ScheduleTriggerConfig, after: number): number | null;
export declare function isValidTimeZone(timeZone: string): boolean;
