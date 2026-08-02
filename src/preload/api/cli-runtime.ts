import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentCli,
  CliDetectResult,
  CliInstallInput,
  CliInstallMethodInfo,
  CliInstallResult,
  CliRuntimeSettings,
  ElectronApi,
} from '../../shared/electron-api'

// The renderer passes the per-CLI runtime override (command path + WSL flag) so
// detection/install run against the same binary and execution mode the agent
// will actually launch with.
type RuntimeOverride = Partial<CliRuntimeSettings> | undefined

export const cliRuntimeApi = {
  cliDetect: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliDetectResult> =>
    ipcRenderer.invoke('cli-runtime:detect', { cli, runtime }),
  cliInstallMethods: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliInstallMethodInfo[]> =>
    ipcRenderer.invoke('cli-runtime:install-methods', { cli, runtime }),
  cliInstall: (input: CliInstallInput, runtime?: RuntimeOverride): Promise<CliInstallResult> =>
    ipcRenderer.invoke('cli-runtime:install', { ...input, runtime }),
  cliUpdate: (cli: AgentCli, runtime?: RuntimeOverride): Promise<CliInstallResult> =>
    ipcRenderer.invoke('cli-runtime:update', { cli, runtime }),
  onCliInstallOutput: (cli: AgentCli, cb: (chunk: string) => void): (() => void) => {
    const ch = `cli-runtime:install-output:${cli}`
    const handler = (_: IpcRendererEvent, chunk: string): void => cb(chunk)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<ElectronApi, 'cliDetect' | 'cliInstallMethods' | 'cliInstall' | 'cliUpdate' | 'onCliInstallOutput'>
