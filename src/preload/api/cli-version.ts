import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CliVersionAdvisoriesInput, CliVersionAdvisoriesResult, ElectronApi } from '../../shared/electron-api'

export const cliVersionApi = {
  cliVersionAdvisories: (input?: CliVersionAdvisoriesInput): Promise<CliVersionAdvisoriesResult> =>
    ipcRenderer.invoke('cli-version:advisories', input),
  cliVersionChecksSetEnabled: (enabled: boolean): Promise<{ enabled: boolean }> =>
    ipcRenderer.invoke('cli-version:set-enabled', enabled),
  onCliVersionAdvisoriesChanged: (cb: (result: CliVersionAdvisoriesResult) => void): (() => void) => {
    const ch = 'cli-version:advisories-changed'
    const handler = (_: IpcRendererEvent, result: CliVersionAdvisoriesResult): void => cb(result)
    ipcRenderer.on(ch, handler)
    return () => ipcRenderer.removeListener(ch, handler)
  },
} satisfies Pick<ElectronApi, 'cliVersionAdvisories' | 'cliVersionChecksSetEnabled' | 'onCliVersionAdvisoriesChanged'>
