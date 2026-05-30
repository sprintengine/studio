import { app, ipcMain } from 'electron'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { loadMainModules } from './module-host/load-modules'
import { readModuleOverridesSync } from './module-host/enablement-store'
import { createAgentRuntimeModule } from './modules/agent-runtime-module'
import { BUNDLED_MAIN_MODULES } from './modules'
import { registerCoreIpc } from './register-core-ipc'
import { registerWorkflowIpc } from './register-workflow-ipc'

configureDevUserData()

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const services = createAppServices(MULTICODE_DIAGNOSTICS)

registerCoreIpc(ipcMain, services, MULTICODE_DIAGNOSTICS)
registerWorkflowIpc(ipcMain, services)

// Capability modules register their own IPC/services/sidecars through the host
// kernel, gated by the user's enablement overrides (mirrored from the renderer
// into userData). A disabled module skips registration entirely. The
// agent-runtime core module seeds the shared services (terminal runtime, auth,
// token stores) that the optional modules consume via the service bridge; the
// resolver orders it first because every dependent declares
// `dependsOn: ['agent-runtime']`. See
// future-plans/2026-05-28-feature-level-pluggable-architecture.md.
const moduleOverrides = readModuleEnablementOverrides()
const moduleLoad = loadMainModules({
  ipcMain,
  modules: [createAgentRuntimeModule(services), ...BUNDLED_MAIN_MODULES],
  overrides: moduleOverrides,
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

function configureDevUserData(): void {
  const userDataDir = process.env['MULTICODE_USER_DATA_DIR']?.trim()
  if (!userDataDir || app.isPackaged) return

  app.setPath('userData', userDataDir)
}

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  allowMultipleInstances:
    !app.isPackaged &&
    process.env['MULTICODE_ALLOW_MULTI_INSTANCE'] === '1' &&
    Boolean(process.env['MULTICODE_USER_DATA_DIR']?.trim()),
  terminalRuntime: services.terminalRuntime,
  sprintEngineMcpHub: services.sprintEngineMcpHub,
  moduleKernel: moduleLoad.kernel,
  updateService: services.updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.multicodeAuth, argv)
  },
})
