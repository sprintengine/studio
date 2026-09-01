import type { AutomationRun, AutomationRunStatus } from '../../shared/automations/contracts';
export declare function completeAutomationRun(run: AutomationRun, patch: Partial<AutomationRun>, completedAt: string): AutomationRun;
export declare function isTerminalRunStatus(status: AutomationRunStatus): boolean;
