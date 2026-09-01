import { type BackgroundStatus } from '../shared/background-mode';
import type { MulticodeUpdateService } from './update-service';
type RegisterAppLifecycleOptions = {
    diagnosticsEnabled: boolean;
    allowMultipleInstances?: boolean;
    terminalRuntime: {
        shutdown(): Promise<void>;
    };
    conversationRuntime?: {
        shutdown(): Promise<void>;
    };
    automationService?: {
        initialize(): Promise<unknown>;
        shutdown(): Promise<void>;
    };
    agentStateService?: {
        initialize(): Promise<void>;
        shutdown(): Promise<void>;
    };
    workspaceSyncService?: {
        /** Persist the debounced workspace registry write before the app exits. */
        flush(): Promise<void>;
    };
    sprintRuntime?: {
        shutdown(): void;
    };
    moduleKernel?: {
        runStartup(): Promise<void>;
        runShutdownBegin(): Promise<void>;
        runShutdown(): Promise<void>;
    };
    updateService: MulticodeUpdateService;
    handleAuthCallback(argv: string[]): void;
    backgroundMode?: {
        isEnabled(): boolean;
        readStatus(): BackgroundStatus;
    };
};
export declare function registerAppLifecycle({ diagnosticsEnabled, allowMultipleInstances, terminalRuntime, conversationRuntime, automationService, agentStateService, workspaceSyncService, sprintRuntime, moduleKernel, updateService, handleAuthCallback, backgroundMode, }: RegisterAppLifecycleOptions): void;
export {};
