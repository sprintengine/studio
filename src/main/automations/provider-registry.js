import { BUNDLED_MODULE_IDS } from '../../shared/modules/manifest';
import { createRunSkillLoopActionProvider } from './actions/run-skill-loop';
import { createSpawnAgentActionProvider } from './actions/spawn-agent';
import { createSprintEngineRunActionProvider, createSprintEngineStartActionProvider, } from './actions/sprint-engine';
import { createSwitchboardAutomationActionProviders } from './actions/switchboard';
import { scheduleTriggerProvider } from './schedule';
import { createRepoEventTriggerProvider } from './triggers/repo-event';
import { createSprintEngineRunCompletedTriggerProvider, createSprintEngineRunNeedsInputTriggerProvider, } from './triggers/sprint-engine-run-events';
import { createSprintEngineRunLandedTriggerProvider } from './triggers/sprint-engine-run-landed';
import { createWebhookTriggerProvider } from './triggers/webhook';
export const AUTOMATIONS_PROVIDER_MODULE_ID = 'automations';
export const SWITCHBOARD_PROVIDER_MODULE_ID = 'switchboard';
export const SPRINT_ENGINE_PROVIDER_MODULE_ID = 'sprint-engine';
export class AutomationProviderRegistrationError extends Error {
    providerId;
    constructor(message, providerId) {
        super(message);
        this.providerId = providerId;
        this.name = 'AutomationProviderRegistrationError';
    }
}
export class AutomationProviderRegistry {
    registeredProviderIds = new Set();
    triggerProviders = new Map();
    actionProviders = new Map();
    registerTriggerProvider(moduleId, provider) {
        const metadata = snapshotProviderMetadata(provider);
        const providerId = namespacedProviderId(moduleId, metadata.kind);
        this.registerProviderId(providerId, 'trigger');
        this.triggerProviders.set(providerId, { providerId, moduleId, providerType: 'trigger', ...metadata, provider });
        return providerId;
    }
    registerActionProvider(moduleId, provider) {
        const metadata = snapshotProviderMetadata(provider);
        const providerId = namespacedProviderId(moduleId, metadata.kind);
        this.registerProviderId(providerId, 'action');
        this.actionProviders.set(providerId, { providerId, moduleId, providerType: 'action', ...metadata, provider });
        return providerId;
    }
    getTriggerProvider(providerId) {
        return this.triggerProviders.get(providerId)?.provider;
    }
    getActionProvider(providerId) {
        return this.actionProviders.get(providerId)?.provider;
    }
    listTriggerProviders() {
        return this.listTriggerProviderRegistrations().map((entry) => entry.provider);
    }
    listActionProviders() {
        return this.listActionProviderRegistrations().map((entry) => entry.provider);
    }
    listTriggerProviderRegistrations() {
        return [...this.triggerProviders.values()];
    }
    listActionProviderRegistrations() {
        return [...this.actionProviders.values()];
    }
    registerProviderId(providerId, providerType) {
        if (this.registeredProviderIds.has(providerId)) {
            throw new AutomationProviderRegistrationError(`Duplicate automation ${providerType} provider registration for "${providerId}".`, providerId);
        }
        this.registeredProviderIds.add(providerId);
    }
}
export function createAutomationProviderRegistry() {
    return new AutomationProviderRegistry();
}
export function createBuiltInAutomationProviderRegistry(options = {}) {
    const registry = createAutomationProviderRegistry();
    registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, scheduleTriggerProvider);
    registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createWebhookTriggerProvider());
    registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createSpawnAgentActionProvider());
    registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createRunSkillLoopActionProvider());
    if (options.switchboard) {
        registry.registerTriggerProvider(SWITCHBOARD_PROVIDER_MODULE_ID, createRepoEventTriggerProvider(options.switchboard));
        for (const provider of createSwitchboardAutomationActionProviders(options.switchboard)) {
            registry.registerActionProvider(SWITCHBOARD_PROVIDER_MODULE_ID, provider);
        }
    }
    if (options.sprintEngine) {
        registry.registerActionProvider(SPRINT_ENGINE_PROVIDER_MODULE_ID, createSprintEngineRunActionProvider(options.sprintEngine));
        registry.registerTriggerProvider(SPRINT_ENGINE_PROVIDER_MODULE_ID, createSprintEngineRunLandedTriggerProvider(options.sprintEngine));
        registry.registerTriggerProvider(SPRINT_ENGINE_PROVIDER_MODULE_ID, createSprintEngineRunNeedsInputTriggerProvider(options.sprintEngine));
        registry.registerTriggerProvider(SPRINT_ENGINE_PROVIDER_MODULE_ID, createSprintEngineRunCompletedTriggerProvider(options.sprintEngine));
        if (options.createSprint) {
            registry.registerActionProvider(SPRINT_ENGINE_PROVIDER_MODULE_ID, createSprintEngineStartActionProvider({ createSprint: options.createSprint }));
        }
    }
    return registry;
}
export function namespacedProviderId(moduleId, providerId) {
    const moduleKey = moduleId.trim();
    const providerKey = providerId.trim();
    if (!moduleKey) {
        throw new AutomationProviderRegistrationError('Automation provider module id is required.', '');
    }
    if (!providerKey) {
        throw new AutomationProviderRegistrationError('Automation provider id is required.', moduleKey);
    }
    return `${moduleKey}.${providerKey}`;
}
export function allowAutomationProvider() {
    return { ok: true };
}
export function isFirstPartyAutomationProviderModule(moduleId) {
    return BUNDLED_MODULE_IDS.includes(moduleId);
}
export function automationProviderBlockedReason(registration, permission) {
    if (permission.ok)
        return undefined;
    return `Automation ${registration.providerType} provider "${registration.kind}" from module "${registration.moduleId}" is blocked: ${permission.reason}`;
}
export function executableTriggerProviders(registrations, checkPermission) {
    return registrations.map((registration) => {
        const permission = checkPermission(registration);
        if (permission.ok)
            return registration.provider;
        return blockedTriggerProvider(registration, permission);
    });
}
export function executableActionProviders(registrations, checkPermission) {
    return registrations.map((registration) => {
        const permission = checkPermission(registration);
        if (permission.ok)
            return registration.provider;
        return blockedActionProvider(registration, permission);
    });
}
function blockedTriggerProvider(registration, permission) {
    const blockedReason = automationProviderBlockedReason(registration, permission)
        ?? `Automation trigger provider "${registration.kind}" is blocked.`;
    return {
        kind: registration.kind,
        configSchema: registration.configSchema,
        subscribe: () => () => undefined,
        computeNextRun: () => null,
        poll: async () => ({ ok: false, blockedReason }),
    };
}
function blockedActionProvider(registration, permission) {
    const blockedReason = automationProviderBlockedReason(registration, permission)
        ?? `Automation action provider "${registration.kind}" is blocked.`;
    return {
        kind: registration.kind,
        configSchema: registration.configSchema,
        run: async () => ({
            status: 'blocked',
            blockedReason,
            summary: 'Automation action blocked before launch.',
        }),
    };
}
function snapshotProviderMetadata(provider) {
    return {
        kind: provider.kind,
        configSchema: ownDataProperty(provider, 'configSchema', fallbackConfigSchema()),
        requiredIntegrations: snapshotRequiredIntegrations(provider),
    };
}
function snapshotRequiredIntegrations(provider) {
    const value = ownDataProperty(provider, 'requiredIntegrations', []);
    if (!Array.isArray(value))
        return [];
    return value.filter((integration) => typeof integration === 'string');
}
function ownDataProperty(target, key, fallback) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !('value' in descriptor))
        return fallback;
    return descriptor.value;
}
function fallbackConfigSchema() {
    return { type: 'object' };
}
