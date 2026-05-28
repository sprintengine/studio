import { app, ipcMain } from 'electron'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import {
  GitHubTokenStoreToken,
  SprintEngineArtifactsToken,
  TerminalRuntimeToken,
} from './module-host/service-tokens'
import { BUNDLED_MAIN_MODULES } from './modules'
import { registerCoreIpc } from './register-core-ipc'
import { registerWorkflowIpc } from './register-workflow-ipc'

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const services = createAppServices(MULTICODE_DIAGNOSTICS)

registerCoreIpc(ipcMain, services, MULTICODE_DIAGNOSTICS)
registerWorkflowIpc(ipcMain, services)

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. See
// future-plans/2026-05-28-feature-level-pluggable-architecture.md.
const moduleOverrides = readModuleEnablementOverrides()
const moduleLoad = loadMainModules({
  ipcMain,
  modules: BUNDLED_MAIN_MODULES,
  overrides: moduleOverrides,
  provideServices: (host) => {
    host.provideService(TerminalRuntimeToken, () => services.terminalRuntime)
    host.provideService(GitHubTokenStoreToken, () => services.githubTokenStore)
    host.provideService(SprintEngineArtifactsToken, () => services.sprintEngineArtifacts)
  },
})
if (MULTICODE_DIAGNOSTICS) {
  console.info(
    '[modules] loaded:', moduleLoad.report.loaded,
    'disabled:', moduleLoad.report.disabled,
    'sidecars:', moduleLoad.report.sidecars.map((s) => s.id)
  )
  if (moduleLoad.report.errors.length > 0) {
    console.warn('[modules] load errors:', moduleLoad.report.errors)
  }
}

function readModuleEnablementOverrides(): Record<string, boolean> {
  try {
    return readModuleOverridesSync(app.getPath('userData'))
  } catch {
    return {}
  }
}

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  mobileBridge: services.mobileBridge,
  terminalRuntime: services.terminalRuntime,
  sprintEngineMcpHub: services.sprintEngineMcpHub,
  moduleKernel: moduleLoad.kernel,
  updateService: services.updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.multicodeAuth, argv)
  },
})
