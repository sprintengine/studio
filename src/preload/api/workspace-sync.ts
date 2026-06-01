import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  WorkspaceSyncCommand,
  WorkspaceSyncCommandResult,
  WorkspaceSyncEvent,
  WorkspaceSyncSnapshot,
} from '../../shared/workspace-sync'
import type { ElectronApi } from '../../shared/electron-api'

type WorkspaceSyncIpcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void): void
}

export function createWorkspaceSyncApi(renderer: WorkspaceSyncIpcRenderer): Pick<
  ElectronApi,
  | 'workspaceSyncDispatch'
  | 'workspaceSyncGetSnapshot'
  | 'workspaceSyncGetEventsAfter'
  | 'onWorkspaceSyncEvent'
> {
  return {
    workspaceSyncDispatch: (command: WorkspaceSyncCommand): Promise<WorkspaceSyncCommandResult> =>
      renderer.invoke('workspace-sync:dispatch', command) as Promise<WorkspaceSyncCommandResult>,
    workspaceSyncGetSnapshot: (): Promise<WorkspaceSyncSnapshot> =>
      renderer.invoke('workspace-sync:get-snapshot') as Promise<WorkspaceSyncSnapshot>,
    workspaceSyncGetEventsAfter: (sequence: number): Promise<WorkspaceSyncEvent[]> =>
      renderer.invoke('workspace-sync:get-events-after', sequence) as Promise<WorkspaceSyncEvent[]>,
    onWorkspaceSyncEvent: (cb: (event: WorkspaceSyncEvent) => void): (() => void) => {
      const channel = 'workspace-sync:event'
      const handler = (_event: IpcRendererEvent, syncEvent: unknown) => cb(syncEvent as WorkspaceSyncEvent)
      renderer.on(channel, handler)
      return () => renderer.removeListener(channel, handler)
    },
  }
}

export const workspaceSyncApi = createWorkspaceSyncApi(ipcRenderer) satisfies Pick<
  ElectronApi,
  | 'workspaceSyncDispatch'
  | 'workspaceSyncGetSnapshot'
  | 'workspaceSyncGetEventsAfter'
  | 'onWorkspaceSyncEvent'
>
