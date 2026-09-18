/**
 * Persistence for the main-owned workspace registry (MC-2158; shapes and record
 * math in `src/shared/workspace-registry.ts`).
 *
 * `<userData>/workspace-registry.json` — one file, not one per workspace: a
 * single mutation routinely spans several workspaces (closing a window re-homes
 * every workspace it held), so per-workspace files would need a cross-file
 * transaction to stay consistent. One file plus tmp-and-rename is one atomic
 * transaction, and it is the shape both existing userData stores already use.
 *
 * Write discipline is copied from the proven launch-settings mirror rather than
 * re-derived: serialized writes, a per-attempt temp file, a 250 ms debounce with
 * an awaited `flush()` on quit, a content-identical no-op, and a failed write
 * that degrades to a warning diagnostic with in-memory state still authoritative
 * for the session.
 */
import { readFileSync } from 'fs'
import { mkdir, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  parseWorkspaceRegistryFile,
  serializeWorkspaceRegistryFile,
  workspaceRegistryContentEqual,
  type WorkspaceRegistryFile,
} from '../shared/workspace-registry'

export const WORKSPACE_REGISTRY_FILE_NAME = 'workspace-registry.json'
const DEFAULT_PERSIST_DEBOUNCE_MS = 250

type WorkspaceRegistryStoreDiagnostic = {
  level: 'warning'
  title: string
  message: string
  details?: string
}

export type WorkspaceRegistryStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (diagnostic: WorkspaceRegistryStoreDiagnostic) => void
  persistDebounceMs?: number
}

export type WorkspaceRegistryReadOutcome =
  | { status: 'loaded'; file: WorkspaceRegistryFile; droppedRecords: { id: string; reason: string }[] }
  | { status: 'missing' }
  | { status: 'unreadable'; details: string }

export type WorkspaceRegistryStore = ReturnType<typeof createWorkspaceRegistryStore>

export function createWorkspaceRegistryStore(deps: WorkspaceRegistryStoreDeps) {
  const debounceMs = Math.max(0, Math.floor(deps.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS))
  let writeQueue: Promise<void> = Promise.resolve()
  let writeSequence = 0
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFile: WorkspaceRegistryFile | null = null
  let lastPersisted: WorkspaceRegistryFile | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), WORKSPACE_REGISTRY_FILE_NAME)
  }

  /**
   * Synchronous read of the persisted registry. `missing` and `unreadable` are
   * kept apart because they lead to different recovery: a missing file is a
   * fresh install or the first boot after this landed, an unreadable one is
   * corruption that must not silently present as an empty workspace list.
   */
  function read(): WorkspaceRegistryReadOutcome {
    let raw: string
    try {
      raw = readFileSync(filePath(), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'ENOENT') return { status: 'missing' }
      const details = error instanceof Error ? error.message : 'unknown_read_error'
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry read failed',
        message: `Unable to read ${WORKSPACE_REGISTRY_FILE_NAME}; falling back to the recovery order.`,
        details,
      })
      return { status: 'unreadable', details }
    }

    let parsed: ReturnType<typeof parseWorkspaceRegistryFile>
    try {
      parsed = parseWorkspaceRegistryFile(JSON.parse(raw))
    } catch (error) {
      const details = error instanceof Error ? error.message : 'unknown_parse_error'
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry parse failed',
        message: `${WORKSPACE_REGISTRY_FILE_NAME} is not valid JSON; falling back to the recovery order.`,
        details,
      })
      return { status: 'unreadable', details }
    }
    if (!parsed) {
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry schema not recognised',
        message: `${WORKSPACE_REGISTRY_FILE_NAME} is not a current-schema registry; falling back to the recovery order.`,
      })
      return { status: 'unreadable', details: 'unrecognised_schema' }
    }
    for (const dropped of parsed.droppedRecords) {
      deps.logDiagnostic?.({
        level: 'warning',
        title: 'Workspace registry record dropped',
        message: `Workspace "${dropped.id}" was dropped from the registry; the remaining workspaces loaded normally.`,
        details: `failing_field=${dropped.reason}`,
      })
    }
    lastPersisted = parsed.file
    return { status: 'loaded', file: parsed.file, droppedRecords: parsed.droppedRecords }
  }

  /**
   * Queue a debounced write. A content-identical file is a no-op: no write, no
   * churn — the authority persists after every accepted mutation, and an
   * unchanged blob is not a new revision.
   */
  function write(file: WorkspaceRegistryFile): void {
    if (lastPersisted && workspaceRegistryContentEqual(lastPersisted, file)) return
    pendingFile = file
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      void persistNow()
    }, debounceMs)
  }

  /** Persist the pending write immediately and await it — used on `before-quit`. */
  async function flush(): Promise<void> {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    await persistNow()
    await writeQueue
  }

  function persistNow(): Promise<void> {
    const file = pendingFile
    if (!file) return writeQueue
    pendingFile = null
    // Writes serialize behind one another and each gets its own temp file: two
    // mutations in the same tick would otherwise race on a shared temp path and
    // could land the older revision last.
    const attempt = ++writeSequence
    writeQueue = writeQueue
      .catch(() => undefined)
      .then(async () => {
        const target = filePath()
        const tmp = `${target}.tmp-${process.pid}-${attempt}`
        try {
          await mkdir(dirname(target), { recursive: true })
          await writeFile(tmp, serializeWorkspaceRegistryFile(file), { mode: 0o600 })
          await rename(tmp, target)
          lastPersisted = file
        } catch (error) {
          await unlink(tmp).catch(() => undefined)
          // Never a silent success: the diagnostic names the file, in-memory
          // state stays authoritative for the session, and the next mutation
          // retries the write.
          deps.logDiagnostic?.({
            level: 'warning',
            title: 'Workspace registry not persisted',
            message: `The workspace registry could not be written to ${WORKSPACE_REGISTRY_FILE_NAME}; in-memory workspaces still apply until the app restarts.`,
            details: error instanceof Error ? error.message : String(error),
          })
        }
      })
    return writeQueue
  }

  return { read, write, flush, filePath }
}

/**
 * An in-memory store with the same contract, for tests that exercise the bus or
 * the authority without touching a real userData directory. `write` is
 * synchronous here on purpose: a test asserting a mutation landed should not
 * have to await a debounce it does not care about.
 */
export function createInMemoryWorkspaceRegistryStore(
  initial?: WorkspaceRegistryFile,
): WorkspaceRegistryStore & { current(): WorkspaceRegistryFile | null } {
  let current: WorkspaceRegistryFile | null = initial ?? null
  return {
    read: (): WorkspaceRegistryReadOutcome =>
      current ? { status: 'loaded', file: current, droppedRecords: [] } : { status: 'missing' },
    write: (file) => {
      current = file
    },
    flush: async () => undefined,
    filePath: () => `<memory>/${WORKSPACE_REGISTRY_FILE_NAME}`,
    current: () => current,
  }
}
