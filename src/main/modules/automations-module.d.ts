import { type AutomationsEngine, type AutomationsEngineOptions } from '../automations/engine';
import { type AutomationProviderPermissionChecker } from '../automations/provider-registry';
import type { CapabilityModule } from '../module-host/load-modules';
import { type AutomationsDefinitionsChangedEvent, type AutomationsRunEvent } from '../../shared/automations/contracts';
export type AutomationsModuleOptions = {
    createEngine?: (options: AutomationsEngineOptions) => AutomationsEngine;
    deliverRunEvent?: (event: AutomationsRunEvent) => void;
    checkProviderPermission?: AutomationProviderPermissionChecker;
    isRoadmapReconcileEnabled?: () => boolean;
};
type RunEventWindow = {
    isDestroyed(): boolean;
    webContents: {
        isDestroyed(): boolean;
        send(channel: string, payload: AutomationsRunEvent | AutomationsDefinitionsChangedEvent): void;
    };
};
export declare function broadcastAutomationsRunEvent(event: AutomationsRunEvent, windows?: readonly RunEventWindow[]): void;
export declare function broadcastAutomationsDefinitionsChanged(event: AutomationsDefinitionsChangedEvent, windows?: readonly RunEventWindow[]): void;
export declare function createAutomationsModule(options?: AutomationsModuleOptions): CapabilityModule;
export declare const automationsModule: CapabilityModule;
export {};
