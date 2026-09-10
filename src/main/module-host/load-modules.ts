import type { IpcMain } from 'electron'

import type { ModuleEventEnvelope } from '../../shared/modules/events'
import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { sanitizeNotificationText } from '../../shared/modules/notifications'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import {
  createMainKernel,
  type MainHost,
  type MainKernel,
  type ModuleSkillHostRegistry,
  type SidecarSpec,
} from './main-host'

export type CapabilityModule = {
  manifest: CapabilityManifest
  /** Wire the module's services, IPC, sidecars, and lifecycle into the host. */
  registerMain?: (host: MainHost) => void
}

export type MainModuleLoadError = {
  id: string
  message: string
}

export type MainModuleLoadReport = {
  loaded: string[]
  manifestOnly: string[]
  disabled: string[]
  errors: MainModuleLoadError[]
  sidecars: ReadonlyArray<SidecarSpec>
}

type MainModuleLiveUpdateReport = {
  loaded: string[]
  disabled: string[]
  errors: MainModuleLoadError[]
}

type MainModuleLiveUpdateOptions = {
  /** Modules whose tracked main-process registrations can be changed without restart. */
  liveModuleIds: readonly string[]
}

export type LoadMainModulesResult = {
  report: MainModuleLoadReport
  kernel: MainKernel
  applyEnablement(
    overrides: ModuleEnablementOverrides,
    options: MainModuleLiveUpdateOptions
  ): Promise<MainModuleLiveUpdateReport>
}

// Resolve enablement, then register each enabled module through the kernel in
// dependency-safe order. A module whose `registerMain` throws is recorded as an
// error and skipped — one bad module must not abort the rest of startup.
//
// `provideServices` runs first (on a synthetic host) so the host's existing
// services — terminal runtime, token stores — are available for modules to
// requireService before any module registers.
export function loadMainModules(options: {
  ipcMain: IpcMain
  modules: CapabilityModule[]
  overrides?: ModuleEnablementOverrides
  provideServices?: (host: MainHost) => void
  /**
   * Modules that must not load regardless of enablement, keyed by id to the
   * reason. The trust gate for third-party modules: when a future increment
   * adds discovered third-party modules to `modules`, it MUST pass each
   * non-`trusted` module here (e.g. `'untrusted'` / `'invalid_signature'`) so
   * its `registerMain` never runs. Bundled modules never appear here.
   */
  ineligible?: Record<string, ModuleResolutionErrorCode>
  /** Pre-resolution launch errors from module discovery/validation. */
  launchErrors?: MainModuleLoadError[]
  /** Sends a module event to every open renderer window. */
  deliverModuleEvent?: (event: ModuleEventEnvelope) => void
  /** Clock override for notification flood-bound tests. */
  now?: () => number
  /**
   * Root directory per module id, for containment-checking the skill
   * directories a module registers. Third-party modules have one (their
   * install folder); bundled modules do not appear here.
   */
  moduleRoots?: Record<string, string>
  /** Skill registry override, for tests. Defaults to the process-wide one. */
  skillRegistry?: ModuleSkillHostRegistry
}): LoadMainModulesResult {
  const { ipcMain, modules, overrides = {}, provideServices, ineligible, launchErrors = [] } = options
  const byId = new Map(modules.map((module) => [module.manifest.id, module]))
  const resolution = resolveModuleEnablement(
    modules.map((module) => module.manifest),
    overrides,
    { ineligible }
  )

  const kernel = createMainKernel(ipcMain, {
    deliverModuleEvent: options.deliverModuleEvent,
    now: options.now,
    resolveModuleManifest: (moduleId) => byId.get(moduleId)?.manifest,
    resolveModuleRoot: (moduleId) => options.moduleRoots?.[moduleId],
    ...(options.skillRegistry ? { skillRegistry: options.skillRegistry } : {}),
  })
  const hostScope = kernel.hostFor('@host')
  provideServices?.(hostScope)
  const loaded: string[] = []
  const manifestOnly: string[] = []
  const errors: MainModuleLoadError[] = launchErrors.concat(
    resolution.errors.map((error) => ({
      id: error.id,
      message: error.message,
    }))
  )
  const activeMainModules = new Set<string>()
  const activeManifestOnlyModules = new Set<string>()

  for (const id of resolution.order) {
    const module = byId.get(id)
    if (!module) continue
    if (!module.registerMain) {
      manifestOnly.push(id)
      activeManifestOnlyModules.add(id)
      continue
    }
    try {
      module.registerMain(kernel.hostFor(id))
      loaded.push(id)
      activeMainModules.add(id)
    } catch (err) {
      errors.push({ id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // Blocked or failed third-party modules graduate from log lines to
  // user-visible status: every load error attributable to an installed
  // third-party module becomes an error notification under that module's
  // identity. Manifest-rejection launch errors are keyed by file path, not
  // module id, so they stay out (no identity to stamp, and the path would
  // leak the install location). Bundled-module failures remain log-only.
  for (const loadError of errors) {
    if (byId.get(loadError.id)?.manifest.source !== 'third-party') continue
    kernel.emitNotification(loadError.id, {
      severity: 'error',
      title: `Module "${loadError.id}" failed to load`,
      body: sanitizeNotificationText(loadError.message, 'Module startup failed.'),
    })
  }

  return {
    report: { loaded, manifestOnly, disabled: resolution.disabled, errors, sidecars: kernel.sidecars() },
    kernel,
    async applyEnablement(
      nextOverrides: ModuleEnablementOverrides,
      liveOptions: MainModuleLiveUpdateOptions
    ): Promise<MainModuleLiveUpdateReport> {
      const liveModuleIds = new Set(liveOptions.liveModuleIds)
      const liveErrors: MainModuleLoadError[] = []
      const nextResolution = resolveModuleEnablement(
        modules.map((module) => module.manifest),
        nextOverrides,
        { ineligible }
      )
      const nextEnabled = new Set(nextResolution.order)

      for (const error of nextResolution.errors) {
        if (liveModuleIds.has(error.id)) liveErrors.push({ id: error.id, message: error.message })
      }

      const currentLiveOrder = modules.map((module) => module.manifest.id).filter((id) => liveModuleIds.has(id))
      for (const id of [...currentLiveOrder].reverse()) {
        if (!activeMainModules.has(id) || nextEnabled.has(id)) continue
        await kernel.unregisterModule(id)
        activeMainModules.delete(id)
      }
      for (const id of [...activeManifestOnlyModules]) {
        if (!liveModuleIds.has(id) || nextEnabled.has(id)) continue
        activeManifestOnlyModules.delete(id)
      }

      for (const id of nextResolution.order) {
        if (!liveModuleIds.has(id) || activeMainModules.has(id) || activeManifestOnlyModules.has(id)) continue
        const module = byId.get(id)
        if (!module) continue
        if (!module.registerMain) {
          activeManifestOnlyModules.add(id)
          continue
        }
        try {
          module.registerMain(kernel.hostFor(id))
          activeMainModules.add(id)
          if (kernel.isStarted()) await kernel.runStartupForModule(id)
        } catch (err) {
          await kernel.unregisterModule(id)
          activeMainModules.delete(id)
          liveErrors.push({ id, message: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        loaded: [...activeMainModules].filter((id) => liveModuleIds.has(id)).sort(),
        disabled: [...liveModuleIds].filter((id) => !nextEnabled.has(id)).sort(),
        errors: liveErrors,
      }
    },
  }
}
