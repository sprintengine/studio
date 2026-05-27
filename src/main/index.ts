import { ipcMain } from 'electron'
import { parseAuthCallbackFromArgv } from './auth-service'
import { registerAppLifecycle } from './app-lifecycle'
import { createAppServices } from './app-services'
import { registerCoreIpc } from './register-core-ipc'
import { registerWorkflowIpc } from './register-workflow-ipc'

const MULTICODE_DIAGNOSTICS = process.env['MULTICODE_DIAGNOSTICS'] === '1'
const services = createAppServices(MULTICODE_DIAGNOSTICS)

registerCoreIpc(ipcMain, services, MULTICODE_DIAGNOSTICS)
registerWorkflowIpc(ipcMain, services)

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
