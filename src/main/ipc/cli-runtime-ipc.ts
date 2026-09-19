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
    if (result.ok && result.installed) invalidateCliAvailability(input.cli)
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
    if (result.ok && result.installed) invalidateCliAvailability(input.cli)
    return result
  })
}
