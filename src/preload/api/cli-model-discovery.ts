import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { ElectronApi } from '../../shared/electron-api'
import {
  CLI_MODELS_CHANGED_CHANNEL,
  CLI_MODELS_DISCOVER_CHANNEL,
  type CliModelDiscoveryInput,
  type CliModelDiscoveryResult,
} from '../../shared/ipc/cli-model-discovery'

// `onCliModelsChanged` returns the unsubscribe so the boot module that
// subscribes can let go of it again; a listener left behind on a reload would
// write catalogs into a store that is no longer the live one.
export const cliModelDiscoveryApi = {
  cliModelsDiscover: (input?: CliModelDiscoveryInput): Promise<CliModelDiscoveryResult> =>
    ipcRenderer.invoke(CLI_MODELS_DISCOVER_CHANNEL, input),
  onCliModelsChanged: (cb: (result: CliModelDiscoveryResult) => void): (() => void) => {
    const handler = (_: IpcRendererEvent, result: CliModelDiscoveryResult): void => cb(result)
    ipcRenderer.on(CLI_MODELS_CHANGED_CHANNEL, handler)
    return () => ipcRenderer.removeListener(CLI_MODELS_CHANGED_CHANNEL, handler)
  },
} satisfies Pick<ElectronApi, 'cliModelsDiscover' | 'onCliModelsChanged'>
