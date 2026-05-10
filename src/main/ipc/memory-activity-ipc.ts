import type { IpcMain } from 'electron'
import {
  clearMemoryActivityHistory,
  getMemoryActivityStatus,
  getMemoryActivitySynapses,
  installMemoryActivityHook,
  isMemoryActivityInstalled,
  startMemoryActivityWatcher,
  stopMemoryActivityWatcher,
  uninstallMemoryActivityHook,
  type ActivityInstallResult,
  type ActivityStatus,
  type ActivitySynapseSnapshot,
  type ActivityUninstallResult,
} from '../memory-activity'

type WorkspaceInput = { workspaceRoot: string | null }
type EnableInput = { workspaceRoot: string | null; memoryRelativeRoot: string | null }

export function registerMemoryActivityIpc(ipcMain: IpcMain): void {
  ipcMain.handle(
    'memory-activity:install',
    async (_, input: EnableInput): Promise<ActivityInstallResult> => {
      if (!input?.workspaceRoot || !input.memoryRelativeRoot) {
        return { ok: false, message: 'Workspace and knowledge root are required.' }
      }
      const result = await installMemoryActivityHook(
        input.workspaceRoot,
        input.memoryRelativeRoot
      )
      if (result.ok) {
        await startMemoryActivityWatcher(input.workspaceRoot, input.memoryRelativeRoot)
      }
      return result
    }
  )

  ipcMain.handle(
    'memory-activity:uninstall',
    async (_, input: WorkspaceInput): Promise<ActivityUninstallResult> => {
      if (!input?.workspaceRoot) return { ok: false, message: 'Workspace root is required.' }
      stopMemoryActivityWatcher(input.workspaceRoot)
      return uninstallMemoryActivityHook(input.workspaceRoot)
    }
  )

  ipcMain.handle(
    'memory-activity:start-watching',
    async (_, input: EnableInput): Promise<{ ok: true }> => {
      if (input?.workspaceRoot && input.memoryRelativeRoot) {
        await startMemoryActivityWatcher(input.workspaceRoot, input.memoryRelativeRoot)
      }
      return { ok: true }
    }
  )

  ipcMain.handle(
    'memory-activity:stop-watching',
    async (_, input: WorkspaceInput): Promise<{ ok: true }> => {
      if (input?.workspaceRoot) stopMemoryActivityWatcher(input.workspaceRoot)
      return { ok: true }
    }
  )

  ipcMain.handle(
    'memory-activity:get-status',
    async (_, input: WorkspaceInput): Promise<ActivityStatus> => {
      return getMemoryActivityStatus(input?.workspaceRoot ?? null)
    }
  )

  ipcMain.handle(
    'memory-activity:get-synapses',
    async (_, input: WorkspaceInput): Promise<ActivitySynapseSnapshot[]> => {
      if (!input?.workspaceRoot) return []
      return getMemoryActivitySynapses(input.workspaceRoot)
    }
  )

  ipcMain.handle(
    'memory-activity:is-installed',
    async (_, input: WorkspaceInput): Promise<boolean> => {
      if (!input?.workspaceRoot) return false
      return isMemoryActivityInstalled(input.workspaceRoot)
    }
  )

  ipcMain.handle(
    'memory-activity:clear-history',
    async (_, input: WorkspaceInput): Promise<{ ok: true }> => {
      if (input?.workspaceRoot) await clearMemoryActivityHistory(input.workspaceRoot)
      return { ok: true }
    }
  )
}
