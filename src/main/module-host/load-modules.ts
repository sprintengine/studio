import type { IpcMain } from 'electron'

import type { CapabilityManifest, ModuleEnablementOverrides } from '../../shared/modules/manifest'
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
export function loadMainModules(options: {
  ipcMain: IpcMain
  modules: CapabilityModule[]
  overrides?: ModuleEnablementOverrides
}): LoadMainModulesResult {
  const { ipcMain, modules, overrides = {} } = options
  const byId = new Map(modules.map((module) => [module.manifest.id, module]))
  const resolution = resolveModuleEnablement(
    modules.map((module) => module.manifest),
    overrides
  )

  const kernel = createMainKernel(ipcMain)
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
