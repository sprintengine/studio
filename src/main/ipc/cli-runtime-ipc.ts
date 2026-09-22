import type { IpcMain } from 'electron'

import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../../shared/electron-api'
import { invalidateCliAvailability } from '../cli-availability'
import { cliInstallMethods, detectCli, installCli, updateCli } from '../cli-runtime-install'
import { discoverAndBroadcastCliModels } from './cli-model-discovery-ipc'

type DetectInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type MethodsInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type InstallIpcInput = CliInstallInput & { runtime?: Partial<CliRuntimeSettings> }

export function registerCliRuntimeIpc(ipcMain: IpcMain): void {
  ipcMain.handle('cli-runtime:detect', (_, input: DetectInput): Promise<CliDetectResult> =>
    detectCli(input.cli, input.runtime),
  )
  ipcMain.handle('cli-runtime:install-methods', (_, input: MethodsInput): Promise<CliInstallMethodInfo[]> =>
    cliInstallMethods(input.cli, input.runtime),
  )
  ipcMain.handle('cli-runtime:install', async (event, input: InstallIpcInput): Promise<CliInstallResult> => {
    const channel = `cli-runtime:install-output:${input.cli}`
    const result = await installCli({ cli: input.cli, methodId: input.methodId }, input.runtime, (chunk) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, chunk)
      }
    })
    // Drop any cached "not installed" probe so the next availability detect for
    // this CLI re-runs against the freshly installed binary.
    if (result.ok && result.installed) refreshAfterInstall(input.cli, input.runtime)
    return result
  })
  // Update action: the CLI's own updater where the manifest declares
  // one, else a re-run of the install spec. Streams onto the same output
  // channel installs use so one listener serves both flows.
  ipcMain.handle('cli-runtime:update', async (event, input: DetectInput): Promise<CliInstallResult> => {
    const channel = `cli-runtime:install-output:${input.cli}`
    const result = await updateCli(input.cli, input.runtime, (chunk) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channel, chunk)
      }
    })
    if (result.ok && result.installed) refreshAfterInstall(input.cli, input.runtime)
    return result
  })
}

// A new binary is a new model list: the version it reports no longer matches
// the one that produced the stored catalog, so this pass re-probes it (and a
// first install gets its first catalog) without waiting for the next refresh.
// Not awaited — the install result goes back to Settings at once.
function refreshAfterInstall(cli: AgentCli, runtime: Partial<CliRuntimeSettings> | undefined): void {
  invalidateCliAvailability(cli)
  void discoverAndBroadcastCliModels({ clis: [cli], ...(runtime ? { cliRuntimes: { [cli]: runtime } } : {}) }).catch(
    () => undefined,
  )
}
