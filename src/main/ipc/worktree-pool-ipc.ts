import { BrowserWindow, type IpcMain } from 'electron'
import type {
  WorktreePoolActionInput,
  WorktreePoolActionResult,
  WorktreePoolLeaseInput,
  WorktreePoolLeaseResult,
  WorktreePoolSettings,
  WorktreePoolSnapshot,
} from '../../shared/ipc/worktree-pool'
import type { WorktreePoolService } from '../worktree-pool/worktree-pool-service'

/**
 * The windows' side of the worktree pool. A window asks for a lease, names the
 * owner of one it took early, hands one back, or asks for a held-slot action;
 * it is sent `worktree-pool:changed` with a pool's snapshot whenever one moves.
 * Every git step runs in main (worktree-pool-service.ts).
 */

const HELD_ACTIONS = new Set(['commit', 'stash', 'discard', 'keep'])
const SLOT_ACTIONS = new Set(['refresh', 'evict', 'release'])

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function optionalId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function broadcastWorktreePoolChanged(snapshot: WorktreePoolSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send('worktree-pool:changed', snapshot)
  }
}

export function registerWorktreePoolIpc(ipcMain: IpcMain, pool: WorktreePoolService): void {
  ipcMain.handle('worktree-pool:lease', async (_, input: WorktreePoolLeaseInput): Promise<WorktreePoolLeaseResult> => {
    if (!input || !isString(input.repoRoot) || !isString(input.name)) {
      return { ok: false, reason: 'error', message: 'A lease needs a repository and a name.' }
    }
    return pool.lease({
      repoRoot: input.repoRoot,
      name: input.name,
      owner: { agentId: optionalId(input.owner?.agentId), workspaceId: optionalId(input.owner?.workspaceId) },
      runtime: input.runtime === 'wsl' ? 'wsl' : 'native',
    })
  })

  ipcMain.handle(
    'worktree-pool:bind',
    async (_, leaseId: unknown, owner: { agentId?: unknown; workspaceId?: unknown } | null): Promise<boolean> => {
      if (!isString(leaseId)) return false
      return pool.bind(leaseId, { agentId: optionalId(owner?.agentId), workspaceId: optionalId(owner?.workspaceId) })
    },
  )

  ipcMain.handle('worktree-pool:release', async (_, leaseId: unknown): Promise<boolean> => {
    if (!isString(leaseId)) return false
    return pool.release(leaseId)
  })

  ipcMain.handle(
    'worktree-pool:action',
    async (_, input: WorktreePoolActionInput): Promise<WorktreePoolActionResult> => {
      if (!input || !isString(input.repoRoot)) return { ok: false, message: 'No repository named.' }
      switch (input.kind) {
        case 'warm-up':
          return pool.action({ kind: 'warm-up', repoRoot: input.repoRoot })
        case 'set-disabled':
          return pool.action({ kind: 'set-disabled', repoRoot: input.repoRoot, disabled: input.disabled === true })
        case 'held':
          if (!isString(input.slotId) || !HELD_ACTIONS.has(input.action)) return { ok: false, message: 'Bad action.' }
          return pool.action({
            kind: 'held',
            repoRoot: input.repoRoot,
            slotId: input.slotId,
            action: input.action,
            message: typeof input.message === 'string' ? input.message.slice(0, 2_000) : undefined,
          })
        default:
          if (!SLOT_ACTIONS.has(input.kind) || !isString((input as { slotId?: unknown }).slotId)) {
            return { ok: false, message: 'Bad action.' }
          }
          return pool.action(input)
      }
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
      if (typeof patch.warmTarget === 'number') clean.warmTarget = patch.warmTarget
      if (typeof patch.diskCapGb === 'number') clean.diskCapGb = patch.diskCapGb
      if (typeof patch.idleEvictionDays === 'number') clean.idleEvictionDays = patch.idleEvictionDays
      return pool.updateSettings(clean)
    },
  )
}
