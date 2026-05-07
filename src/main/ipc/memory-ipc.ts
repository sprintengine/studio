import type { IpcMain } from 'electron'
import {
  indexMemoryGraph,
  readMemoryPreview,
  resolveMemoryRoot,
  type MemoryGraphIndexResult,
  type MemoryPreviewResult,
  type MemoryRootStatus,
} from '../memory-graph'

type MemoryRootRequest = {
  workspaceRoot: string | null
  relativeRoot: string | null
}

type MemoryPreviewRequest = MemoryRootRequest & {
  relativePath: string
}

export function registerMemoryIpc(ipcMain: IpcMain): void {
  ipcMain.handle('memory:resolve-root', async (_, input: MemoryRootRequest): Promise<MemoryRootStatus> => {
    return resolveMemoryRoot(input.workspaceRoot, input.relativeRoot)
  })

  ipcMain.handle('memory:index', async (_, input: MemoryRootRequest): Promise<MemoryGraphIndexResult> => {
    return indexMemoryGraph(input.workspaceRoot, input.relativeRoot)
  })

  ipcMain.handle('memory:read-preview', async (_, input: MemoryPreviewRequest): Promise<MemoryPreviewResult> => {
    return readMemoryPreview(input.workspaceRoot, input.relativeRoot, input.relativePath)
  })
}
