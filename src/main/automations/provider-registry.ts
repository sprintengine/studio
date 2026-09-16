import type { AutomationActionProvider, AutomationProviderGlyph, AutomationTriggerProvider, JsonSchema } from '../../shared/automations/contracts'
import { BUNDLED_MODULE_IDS } from '../../shared/modules/manifest'
import { createRunSkillLoopActionProvider } from './actions/run-skill-loop'
import { createSpawnAgentActionProvider } from './actions/spawn-agent'
import { scheduleTriggerProvider } from './schedule'
import { createWebhookTriggerProvider } from './triggers/webhook'

const AUTOMATIONS_PROVIDER_MODULE_ID = 'automations'

type RegisteredProviderType = 'trigger' | 'action'

export type RegisteredAutomationProvider<T extends AutomationTriggerProvider | AutomationActionProvider> = {
  providerId: string
  moduleId: string
  providerType: RegisteredProviderType
  kind: string
  label?: string
  glyph?: AutomationProviderGlyph
  summary?: string
  configSchema: JsonSchema
  requiredIntegrations: string[]
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
    const metadata = snapshotProviderMetadata(provider)
    const providerId = namespacedProviderId(moduleId, metadata.kind)
    this.registerProviderId(providerId, 'trigger')
    this.triggerProviders.set(providerId, { providerId, moduleId, providerType: 'trigger', ...metadata, provider })
    return providerId
  }

  registerActionProvider(moduleId: string, provider: AutomationActionProvider): string {
    const metadata = snapshotProviderMetadata(provider)
    const providerId = namespacedProviderId(moduleId, metadata.kind)
    this.registerProviderId(providerId, 'action')
    this.actionProviders.set(providerId, { providerId, moduleId, providerType: 'action', ...metadata, provider })
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

export function createBuiltInAutomationProviderRegistry(): AutomationProviderRegistry {
  const registry = createAutomationProviderRegistry()
  registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, scheduleTriggerProvider)
  registry.registerTriggerProvider(AUTOMATIONS_PROVIDER_MODULE_ID, createWebhookTriggerProvider())
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
  return `Automation ${registration.providerType} provider "${registration.kind}" from module "${registration.moduleId}" is blocked: ${permission.reason}`
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
    ?? `Automation trigger provider "${registration.kind}" is blocked.`
  return {
    kind: registration.kind,
    ...(registration.label ? { label: registration.label } : {}),
    ...(registration.glyph ? { glyph: registration.glyph } : {}),
    ...(registration.summary ? { summary: registration.summary } : {}),
    configSchema: registration.configSchema,
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
    ?? `Automation action provider "${registration.kind}" is blocked.`
  return {
    kind: registration.kind,
    ...(registration.label ? { label: registration.label } : {}),
    ...(registration.glyph ? { glyph: registration.glyph } : {}),
    ...(registration.summary ? { summary: registration.summary } : {}),
    configSchema: registration.configSchema,
    run: async () => ({
      status: 'blocked',
      blockedReason,
      summary: 'Automation action blocked before launch.',
    }),
  }
}

function snapshotProviderMetadata(provider: AutomationTriggerProvider | AutomationActionProvider): {
  kind: string
  label?: string
  glyph?: AutomationProviderGlyph
  summary?: string
  configSchema: JsonSchema
  requiredIntegrations: string[]
} {
  const label = ownDataProperty<unknown>(provider, 'label', undefined)
  const glyph = ownDataProperty<unknown>(provider, 'glyph', undefined)
  const summary = ownDataProperty<unknown>(provider, 'summary', undefined)
  return {
    kind: provider.kind,
    ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    ...(isAutomationProviderGlyph(glyph) ? { glyph } : {}),
    ...(typeof summary === 'string' && summary.trim() ? { summary: summary.trim() } : {}),
    configSchema: ownDataProperty(provider, 'configSchema', fallbackConfigSchema()),
    requiredIntegrations: snapshotRequiredIntegrations(provider),
  }
}

function isAutomationProviderGlyph(value: unknown): value is AutomationProviderGlyph {
  return value === 'agent' || value === 'loop' || value === 'board' || value === 'clock'
}

function snapshotRequiredIntegrations(provider: AutomationTriggerProvider | AutomationActionProvider): string[] {
  const value = ownDataProperty<unknown>(provider, 'requiredIntegrations', [])
  if (!Array.isArray(value)) return []
  return value.filter((integration): integration is string => typeof integration === 'string')
}

function ownDataProperty<T>(
  target: object,
  key: string,
  fallback: T
): T {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (!descriptor || !('value' in descriptor)) return fallback
  return descriptor.value as T
}

function fallbackConfigSchema(): JsonSchema {
  return { type: 'object' }
}
