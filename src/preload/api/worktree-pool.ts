import type { IpcRendererEvent } from 'electron'
import { ipc as ipcRenderer } from '../ipc-router'
import type {
  ElectronApi,
  WorktreeDependencyInstallView,
  WorktreeInventory,
  WorktreeInventoryInput,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/electron-api'

export const worktreePoolApi = {
  worktreePoolAction: (input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> =>
    ipcRenderer.invoke('worktree-pool:action', input),
  removeOtherWorktree: (input: { repoRoot: string; path: string }): Promise<WorktreePoolActionResult> =>
    ipcRenderer.invoke('worktree-pool:remove-other', input),
  getWorktreePoolSnapshot: (repoRoot: string): Promise<WorktreePoolSnapshot | null> =>
    ipcRenderer.invoke('worktree-pool:snapshot', repoRoot),
  // One channel for every pool, filtered in the renderer on the repository,
  // the way `git:changelists-changed` is.
  onWorktreePoolChanged: (cb: (snapshot: WorktreePoolSnapshot) => void): (() => void) => {
    const channel = 'worktree-pool:changed'
    const handler = (_: IpcRendererEvent, snapshot: WorktreePoolSnapshot) => cb(snapshot)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  getWorktreePoolSettings: (): Promise<WorktreePoolSettings> => ipcRenderer.invoke('worktree-pool:settings-get'),
  setWorktreePoolSettings: (patch: Partial<WorktreePoolSettings>): Promise<WorktreePoolSettings> =>
    ipcRenderer.invoke('worktree-pool:settings-set', patch),
  getWorktreeInventory: (input: WorktreeInventoryInput): Promise<WorktreeInventory> =>
    ipcRenderer.invoke('worktree-pool:inventory', input),
  listWorktreeInstalls: (): Promise<WorktreeDependencyInstallView[]> => ipcRenderer.invoke('worktree-install:list'),
  onWorktreeInstallChanged: (cb: (view: WorktreeDependencyInstallView) => void): (() => void) => {
    const channel = 'worktree-install:changed'
    const handler = (_: IpcRendererEvent, view: WorktreeDependencyInstallView) => cb(view)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  cancelWorktreeInstall: (id: string): Promise<boolean> => ipcRenderer.invoke('worktree-install:cancel', id),
} satisfies Pick<
  ElectronApi,
  | 'worktreePoolAction'
  | 'removeOtherWorktree'
  | 'getWorktreePoolSnapshot'
  | 'onWorktreePoolChanged'
  | 'getWorktreePoolSettings'
  | 'setWorktreePoolSettings'
  | 'getWorktreeInventory'
  | 'listWorktreeInstalls'
  | 'onWorktreeInstallChanged'
  | 'cancelWorktreeInstall'
>
