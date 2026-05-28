import { ipcMain } from 'electron'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { loadMainModules } from './module-host/load-modules'
import { BUNDLED_MAIN_MODULES } from './modules'
import { registerCoreIpc } from './register-core-ipc'
import { registerWorkflowIpc } from './register-workflow-ipc'

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const services = createAppServices(MULTICODE_DIAGNOSTICS)

registerCoreIpc(ipcMain, services, MULTICODE_DIAGNOSTICS)
registerWorkflowIpc(ipcMain, services)

// Capability modules register their own IPC/services/sidecars through the host
// kernel. Migrating one feature at a time; all bundled modules are enabled by
// default, so behavior is unchanged until the chooser lands (see
// future-plans/2026-05-28-feature-level-pluggable-architecture.md).
const moduleLoad = loadMainModules({ ipcMain, modules: BUNDLED_MAIN_MODULES })
if (MULTICODE_DIAGNOSTICS && moduleLoad.report.errors.length > 0) {
  console.warn('[modules] load errors:', moduleLoad.report.errors)
}

registerAppLifecycle({
  diagnosticsEnabled: MULTICODE_DIAGNOSTICS,
  mobileBridge: services.mobileBridge,
  terminalRuntime: services.terminalRuntime,
  sprintEngineMcpHub: services.sprintEngineMcpHub,
  updateService: services.updateService,
  handleAuthCallback: (argv) => {
    void parseAuthCallbackFromArgv(services.multicodeAuth, argv)
  },
})
