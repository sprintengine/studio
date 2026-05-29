import type { IpcMain } from 'electron'

import type {
  CapabilityManifest,
  ModuleEnablementOverrides,
  ModuleResolutionErrorCode,
} from '../../shared/modules/manifest'
import { resolveModuleEnablement } from '../../shared/modules/resolve'
import { createMainKernel, type MainHost, type MainKernel, type SidecarSpec } from './main-host'

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
  disabled: string[]
  errors: MainModuleLoadError[]
  sidecars: ReadonlyArray<SidecarSpec>
}

export type LoadMainModulesResult = {
  report: MainModuleLoadReport
  kernel: MainKernel
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
}): LoadMainModulesResult {
  const { ipcMain, modules, overrides = {}, provideServices, ineligible } = options
  const byId = new Map(modules.map((module) => [module.manifest.id, module]))
  const resolution = resolveModuleEnablement(
    modules.map((module) => module.manifest),
    overrides,
    { ineligible }
  )

  const kernel = createMainKernel(ipcMain)
  provideServices?.(kernel.hostFor('@host'))
  const loaded: string[] = []
  const errors: MainModuleLoadError[] = resolution.errors.map((error) => ({
    id: error.id,
    message: error.message,
  }))

  for (const id of resolution.order) {
    const module = byId.get(id)
    if (!module) continue
    try {
      module.registerMain?.(kernel.hostFor(id))
      loaded.push(id)
    } catch (err) {
      errors.push({ id, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return {
    report: { loaded, disabled: resolution.disabled, errors, sidecars: kernel.sidecars() },
    kernel,
  }
}
