import type { AutomationActionProvider, AutomationTriggerProvider } from '../../shared/automations/contracts'
import { createRunSkillLoopActionProvider } from './actions/run-skill-loop'
import { createSpawnAgentActionProvider } from './actions/spawn-agent'
import { scheduleTriggerProvider } from './schedule'

export const AUTOMATIONS_PROVIDER_MODULE_ID = 'automations'

type RegisteredProviderType = 'trigger' | 'action'

export class AutomationProviderRegistrationError extends Error {
  constructor(message: string, readonly providerId: string) {
    super(message)
    this.name = 'AutomationProviderRegistrationError'
  }
}

export class AutomationProviderRegistry {
  private readonly registeredProviderIds = new Set<string>()
  private readonly triggerProviders = new Map<string, AutomationTriggerProvider>()
  private readonly actionProviders = new Map<string, AutomationActionProvider>()

  registerTriggerProvider(moduleId: string, provider: AutomationTriggerProvider): string {
    const providerId = namespacedProviderId(moduleId, provider.kind)
    this.registerProviderId(providerId, 'trigger')
    this.triggerProviders.set(providerId, provider)
    return providerId
  }

  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string {
    const providerId = namespacedProviderId(moduleId, provider.kind)
    this.registerProviderId(providerId, 'action')
    this.actionProviders.set(providerId, provider)
    return providerId
  }

  getTriggerProvider(providerId: string): AutomationTriggerProvider | undefined {
    return this.triggerProviders.get(providerId)
  }

  getActionProvider(providerId: string): AutomationActionProvider | undefined {
    return this.actionProviders.get(providerId)
  }

  listTriggerProviders(): AutomationTriggerProvider[] {
    return [...this.triggerProviders.values()]
  }

  listActionProviders(): AutomationActionProvider[] {
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

export function createBuiltInAutomationProviderRegistry(): AutomationProviderRegistry {
  const registry = createAutomationProviderRegistry()
  registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, scheduleTriggerProvider)
  registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createSpawnAgentActionProvider())
  registry.registerActionProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createRunSkillLoopActionProvider())
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
