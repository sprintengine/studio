import type { AutomationActionProvider, AutomationTriggerProvider } from '../../shared/automations/contracts'
import { BUNDLED_MODULE_IDS } from '../../shared/modules/manifest'
import { createRunSkillLoopActionProvider } from './actions/run-skill-loop'
import { createSpawnAgentActionProvider } from './actions/spawn-agent'
import { createSprintEngineRunActionProvider, type SprintEngineAutomationFrontDoors } from './actions/sprint-engine'
import { createSwitchboardAutomationActionProviders, type SwitchboardAutomationFrontDoors } from './actions/switchboard'
import { scheduleTriggerProvider } from './schedule'
import { createRepoEventTriggerProvider } from './triggers/repo-event'

export const AUTOMATIONS_PROVIDER_MODULE_ID = 'automations'
export const SWITCHBOARD_PROVIDER_MODULE_ID = 'switchboard'
export const SPRINT_ENGINE_PROVIDER_MODULE_ID = 'sprint-engine'

export type BuiltInAutomationProviderRegistryOptions = {
  switchboard?: SwitchboardAutomationFrontDoors
  sprintEngine?: SprintEngineAutomationFrontDoors
}

type RegisteredProviderType = 'trigger' | 'action'

export type RegisteredAutomationProvider<T extends AutomationTriggerProvider | AutomationActionProvider> = {
  providerId: string
  moduleId: string
  providerType: RegisteredProviderType
  provider: T
}

export type AutomationProviderPermission =
  | { ok: true }
  | { ok: false; reason: string }

export type AutomationProviderPermissionChecker = (
  registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>
) => AutomationProviderPermission

export type AutomationProviderRegistryService = Pick<
  AutomationProviderRegistry,
  'registerTriggerProvider' | 'registerActionProvider'
>

export class AutomationProviderRegistrationError extends Error {
  constructor(message: string, readonly providerId: string) {
    super(message)
    this.name = 'AutomationProviderRegistrationError'
  }
}

export class AutomationProviderRegistry {
  private readonly registeredProviderIds = new Set<string>()
  private readonly triggerProviders = new Map<string, RegisteredAutomationProvider<AutomationTriggerProvider>>()
  private readonly actionProviders = new Map<string, RegisteredAutomationProvider<AutomationActionProvider>>()

  registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string {
    const providerId = namespacedProviderId(moduleId, provider.kind)
    this.registerProviderId(providerId, 'trigger')
    this.triggerProviders.set(providerId, { providerId, moduleId, providerType: 'trigger', provider })
    return providerId
  }

  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string {
    const providerId = namespacedProviderId(moduleId, provider.kind)
    this.registerProviderId(providerId, 'action')
    this.actionProviders.set(providerId, { providerId, moduleId, providerType: 'action', provider })
    return providerId
  }

  getTriggerProvider(providerId: string): AutomationTriggerProvider | undefined {
    return this.triggerProviders.get(providerId)?.provider
  }

  getActionProvider(providerId: string): AutomationActionProvider | undefined {
    return this.actionProviders.get(providerId)?.provider
  }

  listTriggerProviders(): AutomationTriggerProvider[] {
    return this.listTriggerProviderRegistrations().map((entry) => entry.provider)
  }

  listActionProviders(): AutomationActionProvider[] {
    return this.listActionProviderRegistrations().map((entry) => entry.provider)
  }

  listTriggerProviderRegistrations(): RegisteredAutomationProvider<AutomationTriggerProvider>[] {
    return [...this.triggerProviders.values()]
  }

  listActionProviderRegistrations(): RegisteredAutomationProvider<AutomationActionProvider>[] {
    return [...this.actionProviders.values()]
  }

  private registerProviderId(providerId: string, providerType: RegisteredProviderType): void {
    if (this.registeredProviderIds.has(providerId)) {
      throw new AutomationProviderRegistrationError(
        `Duplicate automation ${providerType} provider registration for "${providerId}".`,
        providerId
      )
    }
    this.registeredProviderIds.add(providerId)
  }
}

export function createAutomationProviderRegistry(): AutomationProviderRegistry {
  return new AutomationProviderRegistry()
}

export function createBuiltInAutomationProviderRegistry(
  options: BuiltInAutomationProviderRegistryOptions = {}
): AutomationProviderRegistry {
  const registry = createAutomationProviderRegistry()
  registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, scheduleTriggerProvider)
  registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createSpawnAgentActionProvider())
  registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createRunSkillLoopActionProvider())
  if (options.switchboard) {
    registry.registerTriggerProvider(SWITCHBOARD_PROVIDER_MODULE_ID, createRepoEventTriggerProvider(options.switchboard))
    for (const provider of createSwitchboardAutomationActionProviders(options.switchboard)) {
      registry.registerActionProvider(SWITCHBOARD_PROVIDER_MODULE_ID, provider)
    }
  }
  if (options.sprintEngine) {
    registry.registerActionProvider(
      SPRINT_ENGINE_PROVIDER_MODULE_ID,
      createSprintEngineRunActionProvider(options.sprintEngine)
    )
  }
  return registry
}

export function namespacedProviderId(moduleId: string, providerId: string): string {
  const moduleKey = moduleId.trim()
  const providerKey = providerId.trim()
  if (!moduleKey) {
    throw new AutomationProviderRegistrationError('Automation provider module id is required.', '')
  }
  if (!providerKey) {
    throw new AutomationProviderRegistrationError('Automation provider id is required.', moduleKey)
  }
  return `${moduleKey}.${providerKey}`
}

export function allowAutomationProvider(): AutomationProviderPermission {
  return { ok: true }
}

export function isFirstPartyAutomationProviderModule(moduleId: string): boolean {
  return BUNDLED_MODULE_IDS.includes(moduleId)
}

export function automationProviderBlockedReason(
  registration: RegisteredAutomationProvider<AutomationTriggerProvider | AutomationActionProvider>,
  permission: AutomationProviderPermission
): string | undefined {
  if (permission.ok) return undefined
  return `Automation ${registration.providerType} provider "${registration.provider.kind}" from module "${registration.moduleId}" is blocked: ${permission.reason}`
}

export function executableTriggerProviders(
  registrations: RegisteredAutomationProvider<AutomationTriggerProvider>[],
  checkPermission: AutomationProviderPermissionChecker
): AutomationTriggerProvider[] {
  return registrations.map((registration) => {
    const permission = checkPermission(registration)
    if (permission.ok) return registration.provider
    return blockedTriggerProvider(registration, permission)
  })
}

export function executableActionProviders(
  registrations: RegisteredAutomationProvider<AutomationActionProvider>[],
  checkPermission: AutomationProviderPermissionChecker
): AutomationActionProvider[] {
  return registrations.map((registration) => {
    const permission = checkPermission(registration)
    if (permission.ok) return registration.provider
    return blockedActionProvider(registration, permission)
  })
}

function blockedTriggerProvider(
  registration: RegisteredAutomationProvider<AutomationTriggerProvider>,
  permission: AutomationProviderPermission
): AutomationTriggerProvider {
  const blockedReason = automationProviderBlockedReason(registration, permission)
    ?? `Automation trigger provider "${registration.provider.kind}" is blocked.`
  return {
    kind: registration.provider.kind,
    configSchema: registration.provider.configSchema,
    requiredIntegrations: registration.provider.requiredIntegrations,
    validateConfig: registration.provider.validateConfig,
    subscribe: () => () => undefined,
    computeNextRun: () => null,
    poll: async () => ({ ok: false, blockedReason }),
  }
}

function blockedActionProvider(
  registration: RegisteredAutomationProvider<AutomationActionProvider>,
  permission: AutomationProviderPermission
): AutomationActionProvider {
  const blockedReason = automationProviderBlockedReason(registration, permission)
    ?? `Automation action provider "${registration.provider.kind}" is blocked.`
  return {
    kind: registration.provider.kind,
    configSchema: registration.provider.configSchema,
    requiredIntegrations: registration.provider.requiredIntegrations,
    run: async () => ({
      status: 'blocked',
      blockedReason,
      summary: 'Automation action blocked before launch.',
    }),
  }
}
