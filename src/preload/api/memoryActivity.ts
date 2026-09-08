import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  MemoryActivityEvent,
  MemoryActivityInstallResult,
  MemoryActivityStatus,
  MemoryActivitySynapse,
  MemoryActivitySynapsesPayload,
  MemoryActivityUninstallResult,
} from '../../shared/electron-api'

export const memoryActivityApi = {
  memoryActivityInstall: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ): Promise<MemoryActivityInstallResult> =>
    ipcRenderer.invoke('memory-activity:install', input),

  memoryActivityUninstall: (
    input: { workspaceRoot: string | null }
  ): Promise<MemoryActivityUninstallResult> =>
    ipcRenderer.invoke('memory-activity:uninstall', input),

  memoryActivityStartWatching: (
    input: { workspaceRoot: string | null; memoryRelativeRoot: string | null }
  ): Promise<{ ok: true }> =>
    ipcRenderer.invoke('memory-activity:start-watching', input),


  memoryActivityGetStatus: (
    input: { workspaceRoot: string | null }
  ): Promise<MemoryActivityStatus> =>
    ipcRenderer.invoke('memory-activity:get-status', input),

  memoryActivityGetSynapses: (
    input: { workspaceRoot: string | null }
  ): Promise<MemoryActivitySynapse[]> =>
    ipcRenderer.invoke('memory-activity:get-synapses', input),

  memoryActivityIsInstalled: (
    input: { workspaceRoot: string | null }
  ): Promise<boolean> =>
    ipcRenderer.invoke('memory-activity:is-installed', input),


  onMemoryActivityEvent: (cb: (event: MemoryActivityEvent) => void) => {
    const handler = (_: IpcRendererEvent, event: MemoryActivityEvent) => cb(event)
    ipcRenderer.on('memory-activity:event', handler)
    return () => ipcRenderer.removeListener('memory-activity:event', handler)
  },

  onMemoryActivityStatus: (cb: (status: MemoryActivityStatus) => void) => {
    const handler = (_: IpcRendererEvent, status: MemoryActivityStatus) => cb(status)
    ipcRenderer.on('memory-activity:status', handler)
    return () => ipcRenderer.removeListener('memory-activity:status', handler)
  },

  onMemoryActivitySynapses: (cb: (payload: MemoryActivitySynapsesPayload) => void) => {
    const handler = (_: IpcRendererEvent, payload: MemoryActivitySynapsesPayload) => cb(payload)
    ipcRenderer.on('memory-activity:synapses', handler)
    return () => ipcRenderer.removeListener('memory-activity:synapses', handler)
  },
} satisfies Pick<
  ElectronApi,
  | 'memoryActivityInstall'
  | 'memoryActivityUninstall'
  | 'memoryActivityStartWatching'
  | 'memoryActivityGetStatus'
  | 'memoryActivityGetSynapses'
  | 'memoryActivityIsInstalled'
  | 'onMemoryActivityEvent'
  | 'onMemoryActivityStatus'
  | 'onMemoryActivitySynapses'
>
