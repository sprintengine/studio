import type { SprintCreateRequest, SprintCreateResult } from '../../shared/sprint-create';
import type { AutomationActionProvider, AutomationTriggerProvider, JsonSchema } from '../../shared/automations/contracts';
import { type SprintEngineAutomationFrontDoors } from './actions/sprint-engine';
import { type SwitchboardAutomationFrontDoors } from './actions/switchboard';
export declare const AUTOMATIONS_PROVIDER_MODULE_ID = "automations";
export declare const SWITCHBOARD_PROVIDER_MODULE_ID = "switchboard";
export declare const SPRINT_ENGINE_PROVIDER_MODULE_ID = "sprint-engine";
export type BuiltInAutomationProviderRegistryOptions = {
    switchboard?: SwitchboardAutomationFrontDoors;
    sprintEngine?: SprintEngineAutomationFrontDoors;
    /**
     * Sprint creation for the `sprint-engine-start` action, backed by main's
     * SprintCreateService (MC-2160). The action is only registered when a
     * creator is supplied, so a host without one advertises no way to start a
     * run rather than one that fails at execution time.
     */
    createSprint?: (request: SprintCreateRequest) => Promise<SprintCreateResult>;
};
type RegisteredProviderType = 'trigger' | 'action';
export type RegisteredAutomationProvider<T extends AutomationTriggerProvider | AutomationActionProvider> = {
    providerId: string;
    moduleId: string;
    providerType: RegisteredProviderType;
    kind: string;
    configSchema: JsonSchema;
    requiredIntegrations: string[];
    provider: T;
};
export type AutomationProviderPermission = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
export type AutomationProviderPermissionChecker = (registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>) => AutomationProviderPermission;
export type AutomationProviderRegistryService = Pick<AutomationProviderRegistry, 'registerTriggerProvider' | 'registerActionProvider'>;
export declare class AutomationProviderRegistrationError extends Error {
    readonly providerId: string;
    constructor(message: string, providerId: string);
}
export declare class AutomationProviderRegistry {
    private readonly registeredProviderIds;
    private readonly triggerProviders;
    private readonly actionProviders;
    registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string;
    registerActionProvider(moduleId: string, provider: AutomationActionProvider): string;
    getTriggerProvider(providerId: string): AutomationTriggerProvider | undefined;
    getActionProvider(providerId: string): AutomationActionProvider | undefined;
    listTriggerProviders(): AutomationTriggerProvider[];
    listActionProviders(): AutomationActionProvider[];
    listTriggerProviderRegistrations(): RegisteredAutomationProvider<AutomationTriggerProvider>[];
    listActionProviderRegistrations(): RegisteredAutomationProvider<AutomationActionProvider>[];
    private registerProviderId;
}
export declare function createAutomationProviderRegistry(): AutomationProviderRegistry;
export declare function createBuiltInAutomationProviderRegistry(options?: BuiltInAutomationProviderRegistryOptions): AutomationProviderRegistry;
export declare function namespacedProviderId(moduleId: string, providerId: string): string;
export declare function allowAutomationProvider(): AutomationProviderPermission;
export declare function isFirstPartyAutomationProviderModule(moduleId: string): boolean;
export declare function automationProviderBlockedReason(registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>, permission: AutomationProviderPermission): string | undefined;
export declare function executableTriggerProviders(registrations: RegisteredAutomationProvider<AutomationTriggerProvider>[], checkPermission: AutomationProviderPermissionChecker): AutomationTriggerProvider[];
export declare function executableActionProviders(registrations: RegisteredAutomationProvider<AutomationActionProvider>[], checkPermission: AutomationProviderPermissionChecker): AutomationActionProvider[];
export {};
