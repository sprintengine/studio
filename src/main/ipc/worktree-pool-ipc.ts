import { BrowserWindow, type IpcMain } from 'electron'
import type {
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import type { WorktreePoolService } from '../worktree-pool/worktree-pool-service'

/**
 * The windows' side of the worktree pool: a snapshot of a repository's pool,
 * a person's action on a held or idle slot, and the pool's settings. A window
 * is sent `worktree-pool:changed` with a pool's snapshot whenever one moves.
 * Leases are not asked for here; an agent worktree created with `fromPool`
 * comes from the pool (git.ts). Every git step runs in main.
 */

const HELD_ACTIONS = new Set(['commit', 'stash', 'discard', 'keep'])

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function broadcastWorktreePoolChanged(snapshot: WorktreePoolSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send('worktree-pool:changed', snapshot)
  }
}

export function registerWorktreePoolIpc(ipcMain: IpcMain, pool: WorktreePoolService): void {
  ipcMain.handle(
    'worktree-pool:action',
    async (_, input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> => {
      if (!input || !isString(input.repoRoot) || !isString(input.slotId)) {
        return { ok: false, message: 'No worktree named.' }
      }
      if (input.kind === 'evict') return pool.action({ kind: 'evict', repoRoot: input.repoRoot, slotId: input.slotId })
      if (input.kind !== 'held' || !HELD_ACTIONS.has(input.action)) return { ok: false, message: 'Unknown action.' }
      return pool.action({
        kind: 'held',
        repoRoot: input.repoRoot,
        slotId: input.slotId,
        action: input.action,
        message: typeof input.message === 'string' ? input.message.slice(0, 2_000) : undefined,
      })
    },
  )

  ipcMain.handle('worktree-pool:snapshot', async (_, repoRoot: unknown): Promise<WorktreePoolSnapshot | null> => {
    if (!isString(repoRoot)) return null
    return pool.snapshot(repoRoot)
  })

  ipcMain.handle('worktree-pool:settings-get', async (): Promise<WorktreePoolSettings> => pool.getSettings())

  ipcMain.handle(
    'worktree-pool:settings-set',
    async (_, patch: Partial<WorktreePoolSettings> | null): Promise<WorktreePoolSettings> => {
      if (!patch || typeof patch !== 'object') return pool.getSettings()
      const clean: Partial<WorktreePoolSettings> = {}
      if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled
      if (typeof patch.keepIdle === 'number') clean.keepIdle = patch.keepIdle
      return pool.updateSettings(clean)
    },
  )
}
