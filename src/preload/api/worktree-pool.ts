import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ElectronApi,
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolLeaseInput,
  WorktreePoolLeaseOwner,
  WorktreePoolLeaseResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/electron-api'

export const worktreePoolApi = {
  leasePoolWorktree: (input: WorktreePoolLeaseInput): Promise<WorktreePoolLeaseResult> =>
    ipcRenderer.invoke('worktree-pool:lease', input),
  bindPoolWorktree: (leaseId: string, owner: WorktreePoolLeaseOwner): Promise<boolean> =>
    ipcRenderer.invoke('worktree-pool:bind', leaseId, owner),
  releasePoolWorktree: (leaseId: string): Promise<boolean> => ipcRenderer.invoke('worktree-pool:release', leaseId),
  worktreePoolAction: (input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> =>
    ipcRenderer.invoke('worktree-pool:action', input),
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
} satisfies Pick<
  ElectronApi,
  | 'leasePoolWorktree'
  | 'bindPoolWorktree'
  | 'releasePoolWorktree'
  | 'worktreePoolAction'
  | 'getWorktreePoolSnapshot'
  | 'onWorktreePoolChanged'
  | 'getWorktreePoolSettings'
  | 'setWorktreePoolSettings'
>
