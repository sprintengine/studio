import type { IpcMain } from 'electron'

import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
} from '../../shared/electron-api'
import { recordCliDetection } from '../cli-availability'
import { cliInstallMethods, detectCli, installCli, updateCli } from '../cli-runtime-install'
import { noteCliDetected } from '../cli-version-advisory-service'
import { isWslHostId, LOCAL_HOST_ID } from '../../shared/execution-host'
import { discoverAndBroadcastCliModels } from './cli-model-discovery-ipc'

type DetectInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type MethodsInput = { cli: AgentCli; runtime?: Partial<CliRuntimeSettings> }
type InstallIpcInput = CliInstallInput & { runtime?: Partial<CliRuntimeSettings> }

export function registerCliRuntimeIpc(ipcMain: IpcMain): void {
  // A row's own detection (opening it, or its Re-check): a probe of this one
  // CLI on this one machine, which the shared answer takes on, so the list, the
  // pickers and the version check agree with what the row just found.
  ipcMain.handle('cli-runtime:detect', async (_, input: DetectInput): Promise<CliDetectResult> => {
    const result = await detectCli(input.cli, input.runtime)
    // A changed answer schedules the version check's comparison (app-services).
    if (result.error === null) recordCliDetection(input.runtime, result)
    return result
  })
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
    afterInstall(input.cli, input.runtime, result)
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
    afterInstall(input.cli, input.runtime, result)
    return result
  })
}

// Both flows end by detecting their CLI again on the machine they ran on. That
// answer is the new truth for that one CLI there: it replaces the cached one,
// and the version advisories are compared again from it, so the row's version
// moves and its update badge clears without re-scanning every CLI. Only a CLI
// found afterwards is recorded; one that was not may be a detection that could
// not run, and the next read looks again.
//
// A new binary is a new model list too: the version it reports no longer
// matches the one that produced the stored catalog, so this pass re-probes it
// (and a first install gets its first catalog) without waiting for the next
// refresh. Neither is awaited — the result goes back to Settings at once.
function afterInstall(cli: AgentCli, runtime: Partial<CliRuntimeSettings> | undefined, result: CliInstallResult): void {
  if (!result.installed) return
  const hostId = isWslHostId(runtime?.hostId) ? runtime.hostId : LOCAL_HOST_ID
  void noteCliDetected(runtime, {
    cli,
    binary: runtime?.command?.trim() || cli,
    installed: true,
    version: result.version,
    resolvedPath: result.resolvedPath,
    hostId,
    error: null,
  }).catch(() => undefined)
  if (!result.ok) return
  void discoverAndBroadcastCliModels({ clis: [cli], ...(runtime ? { cliRuntimes: { [cli]: runtime } } : {}) }).catch(
    () => undefined,
  )
}
