import type { IpcMain } from 'electron'

import type { ModuleEventEnvelope } from '../../shared/modules/events'
import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { sanitizeNotificationText, type ModuleNotificationDelivery } from '../../shared/modules/notifications'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import {
  createMainKernel,
  type MainHost,
  type MainKernel,
  type ModuleSkillHostRegistry,
  type SidecarSpec,
} from './main-host'
import { errorMessage } from '../../shared/errors'

export type CapabilityModule = {
  manifest: CapabilityManifest
  /**
   * Wire the module's services, IPC, sidecars, and lifecycle into the host. A
   * returned promise is awaited (bounded; see REGISTER_MAIN_TIMEOUT_MS) before
   * the app runs startup hooks.
   */
  registerMain?: (host: MainHost) => void | Promise<void>
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
  /**
   * Settles once every asynchronous `registerMain` has resolved, failed, or
   * timed out. A failure unregisters that module and lands in
   * `report.errors`, so read the report after this. Never rejects.
   */
  ready: Promise<void>
  applyEnablement(
    overrides: ModuleEnablementOverrides,
    options: MainModuleLiveUpdateOptions,
  ): Promise<MainModuleLiveUpdateReport>
}

// How long an asynchronous registerMain may take before its module is dropped.
// Startup waits on it, so one hung module must not hold the app's boot.
export const REGISTER_MAIN_TIMEOUT_MS = 10_000

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

// The returned promise of a registerMain, raced against the timeout. The
// timer is cleared on settle so a quick module leaves nothing behind.
async function settleRegistration(id: string, pending: PromiseLike<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Module "${id}" registerMain did not settle within ${timeoutMs / 1000}s.`)),
      timeoutMs,
    )
  })
  try {
    await Promise.race([pending, timeout])
  } finally {
    clearTimeout(timer)
  }
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
  /** Sends a module's bell row to every attached client (shared/modules/notifications.ts). */
  deliverModuleNotification?: (notification: ModuleNotificationDelivery) => void
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
  /** Async registerMain bound override, for tests. */
  registerTimeoutMs?: number
  /** False in the Studio server out of process: see `MainKernelOptions.electronMain`. */
  electronMain?: boolean
}): LoadMainModulesResult {
  const { ipcMain, modules, overrides = {}, provideServices, ineligible, launchErrors = [] } = options
  const registerTimeoutMs = options.registerTimeoutMs ?? REGISTER_MAIN_TIMEOUT_MS
  const byId = new Map(modules.map((module) => [module.manifest.id, module]))
  const resolution = resolveModuleEnablement(
    modules.map((module) => module.manifest),
    overrides,
    { ineligible },
  )

  const kernel = createMainKernel(ipcMain, {
    ...(options.electronMain === undefined ? {} : { electronMain: options.electronMain }),
    deliverModuleEvent: options.deliverModuleEvent,
    ...(options.deliverModuleNotification ? { deliverModuleNotification: options.deliverModuleNotification } : {}),
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
    })),
  )
  const activeMainModules = new Set<string>()
  const activeManifestOnlyModules = new Set<string>()
  const pendingRegistrations: Promise<void>[] = []

  // Blocked or failed third-party modules graduate from log lines to
  // user-visible status: every load error attributable to an installed
  // third-party module becomes an error notification under that module's
  // identity. Manifest-rejection launch errors are keyed by file path, not
  // module id, so they stay out (no identity to stamp, and the path would
  // leak the install location). Bundled-module failures remain log-only.
  const notifyLoadError = (loadError: MainModuleLoadError): void => {
    if (byId.get(loadError.id)?.manifest.source !== 'third-party') return
    kernel.emitNotification(loadError.id, {
      severity: 'error',
      title: `Module "${loadError.id}" failed to load`,
      body: sanitizeNotificationText(loadError.message, 'Module startup failed.'),
    })
  }

  // An async registerMain that rejects or times out takes back whatever it
  // had already registered, exactly as a module that never loaded.
  const failAsyncRegistration = async (id: string, err: unknown): Promise<void> => {
    await kernel.unregisterModule(id)
    activeMainModules.delete(id)
    const index = loaded.indexOf(id)
    if (index >= 0) loaded.splice(index, 1)
    const loadError = { id, message: errorMessage(err) }
    errors.push(loadError)
    notifyLoadError(loadError)
  }

  for (const id of resolution.order) {
    const module = byId.get(id)
    if (!module) continue
    if (!module.registerMain) {
      manifestOnly.push(id)
      activeManifestOnlyModules.add(id)
      continue
    }
    try {
      const registered = module.registerMain(kernel.hostFor(id))
      loaded.push(id)
      activeMainModules.add(id)
      if (isThenable(registered)) {
        pendingRegistrations.push(
          settleRegistration(id, registered, registerTimeoutMs).catch((err) => failAsyncRegistration(id, err)),
        )
      }
    } catch (err) {
      errors.push({ id, message: errorMessage(err) })
    }
  }

  for (const loadError of errors) notifyLoadError(loadError)

  return {
    report: {
      loaded,
      manifestOnly,
      disabled: resolution.disabled,
      errors,
      // Read live: an async registerMain can declare a sidecar after this returns.
      get sidecars() {
        return kernel.sidecars()
      },
    },
    kernel,
    ready: Promise.all(pendingRegistrations).then(() => undefined),
    async applyEnablement(
      nextOverrides: ModuleEnablementOverrides,
      liveOptions: MainModuleLiveUpdateOptions,
    ): Promise<MainModuleLiveUpdateReport> {
      const liveModuleIds = new Set(liveOptions.liveModuleIds)
      const liveErrors: MainModuleLoadError[] = []
      const nextResolution = resolveModuleEnablement(
        modules.map((module) => module.manifest),
        nextOverrides,
        { ineligible },
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
          const registered = module.registerMain(kernel.hostFor(id))
          if (isThenable(registered)) await settleRegistration(id, registered, registerTimeoutMs)
          activeMainModules.add(id)
          if (kernel.isStarted()) await kernel.runStartupForModule(id)
        } catch (err) {
          await kernel.unregisterModule(id)
          activeMainModules.delete(id)
          const loadError = { id, message: errorMessage(err) }
          liveErrors.push(loadError)
          notifyLoadError(loadError)
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
