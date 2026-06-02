import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { WorkspaceSyncRoutingSnapshot } from '../shared/workspace-sync'
import type { WorkspaceWindowState } from '../renderer/src/types/workspace'

const ROUTING_SNAPSHOT_FILE_NAME = 'workspace-sync-routing-snapshot.json'

export type WorkspaceSyncRoutingSnapshotStore = {
  read(): WorkspaceSyncRoutingSnapshot | null
  write(snapshot: WorkspaceSyncRoutingSnapshot): void
}

export function createWorkspaceSyncRoutingSnapshotStore(options: {
  resolveUserDataDir: () => string
  logDiagnostic?: (diagnostic: { level: 'warning'; title: string; message: string; details?: string }) => void
}): WorkspaceSyncRoutingSnapshotStore {
  const snapshotPath = () => join(options.resolveUserDataDir(), ROUTING_SNAPSHOT_FILE_NAME)

  return {
    read(): WorkspaceSyncRoutingSnapshot | null {
      let raw: string
      try {
        raw = readFileSync(snapshotPath(), 'utf8')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          options.logDiagnostic?.({
            level: 'warning',
            title: 'Workspace sync routing snapshot read failed',
            message: 'Unable to read the workspace sync routing snapshot.',
            details: error instanceof Error ? error.message : 'unknown_read_error',
          })
        }
        return null
      }

      try {
        const parsed = JSON.parse(raw) as Partial<WorkspaceSyncRoutingSnapshot>
        const sequence = parsed.sequence
        if (
          !Number.isInteger(sequence)
          || sequence === undefined
          || sequence < 0
          || typeof parsed.primaryWorkspaceWindowId !== 'string'
          || !Array.isArray(parsed.workspaceWindows)
        ) {
          throw new Error('malformed_routing_snapshot')
        }
        return {
          sequence,
          primaryWorkspaceWindowId: parsed.primaryWorkspaceWindowId,
          workspaceWindows: parsed.workspaceWindows.filter(isWorkspaceWindowState),
        }
      } catch (error) {
        options.logDiagnostic?.({
          level: 'warning',
          title: 'Workspace sync routing snapshot parse failed',
          message: 'Unable to parse the workspace sync routing snapshot.',
          details: error instanceof Error ? error.message : 'unknown_parse_error',
        })
        return null
      }
    },
    write(snapshot: WorkspaceSyncRoutingSnapshot): void {
      const path = snapshotPath()
      const tmp = `${path}.tmp`
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

function isWorkspaceWindowState(value: unknown): value is WorkspaceWindowState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<WorkspaceWindowState>
  return (
    typeof candidate.id === 'string'
    && (candidate.kind === 'primary' || candidate.kind === 'detached')
    && Array.isArray(candidate.workspaceIds)
    && candidate.workspaceIds.every((workspaceId) => typeof workspaceId === 'string')
    && (candidate.activeWorkspaceId === null || typeof candidate.activeWorkspaceId === 'string')
    && (candidate.bounds === null || typeof candidate.bounds === 'object')
    && typeof candidate.isMaximized === 'boolean'
    && (candidate.displayId === null || typeof candidate.displayId === 'number')
    && typeof candidate.createdAt === 'number'
    && typeof candidate.lastFocusedAt === 'number'
  )
}
