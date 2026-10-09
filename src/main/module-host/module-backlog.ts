// The Backlog for capability modules (SDK `getBacklogService`, and the
// renderer's Backlog write methods through the host-service bridge): list,
// locate, create and change items of a workspace's Backlog.
//
// Nothing here writes a file. Every write is a call into the app's own Backlog
// service (backlog-service.ts) — the path the Backlog panel, the phone and the
// Studio MCP gateway use — made inside that project's mutation lane, so a
// module's write cannot interleave with another writer's and ids, file names
// and frontmatter follow the app's rules. The permissions are checked per call:
// `backlog.read` for reads, `backlog.write` for writes.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  backlogAbsolutePath,
  createBacklogItem as createBacklogScanItem,
  isBacklogCriticality,
  isBacklogDifficulty,
  isBacklogRisk,
  isBacklogType,
  scanBacklog,
  type BacklogFilesystemAdapter,
  type BacklogItem,
  type BacklogItemObjectMetadata,
  type BacklogItemStatus,
  type BacklogScanResult,
} from '../../shared/backlog/scan'
import { formatBacklogDisplayId } from '../../shared/backlog/item-id'
import type {
  ModuleBacklogErrorCode,
  ModuleBacklogRegistry,
  ModuleBacklogResult,
} from '../../shared/modules/backlog-service'
import type { BacklogTriageInput } from '../../shared/electron-api'
import { errorMessage } from '../../shared/errors'
import {
  addOrUpdateBacklogLink,
  createBacklogItem,
  peekBacklogDisplayKey,
  readBacklogItem,
  readBacklogObjectStore,
  resolveBacklogLocation,
  updateBacklogModuleMetadata,
  updateBacklogStatus,
  updateBacklogTriage,
  withBacklogWorkspaceLock,
} from '../backlog-service'

/** A workspace as this service needs it: its id, name and project folder. */
export type ModuleBacklogWorkspace = { id: string; name: string; folderPath: string | null }

export type ModuleBacklogDeps = {
  /** The workspace by id, read fresh on each call; null when unknown. */
  getWorkspace: (workspaceId: string) => ModuleBacklogWorkspace | null
  /** The permissions the module declared in its manifest. */
  getModulePermissions: (moduleId: string) => readonly string[] | undefined
}

type Failure = { ok: false; code: ModuleBacklogErrorCode; message: string }

const STATUSES: ReadonlySet<string> = new Set<BacklogItemStatus>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
])
const LINK_TYPES: ReadonlySet<string> = new Set(['execution', 'issue', 'review', 'artifact', 'external', 'agent'])
const EPIC_SLUG = /^[a-z0-9][a-z0-9-]*$/
const MAX_TITLE = 300
const MAX_BODY = 256 * 1024

const failure = (code: ModuleBacklogErrorCode, message: string): Failure => ({ ok: false, code, message })

const nodeBacklogFs: BacklogFilesystemAdapter = {
  async pathExists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
  },
  readfile: (path) => readFile(path, 'utf-8'),
  async statPath(path) {
    const info = await stat(path)
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      modifiedAtMs: info.mtimeMs,
    }
  },
}

export function createModuleBacklogRegistry(deps: ModuleBacklogDeps): ModuleBacklogRegistry {
  function denied(moduleId: string, permission: 'backlog.read' | 'backlog.write'): Failure | null {
    if (deps.getModulePermissions(moduleId)?.includes(permission)) return null
    return failure(
      'permission_missing',
      `Module "${moduleId}" does not declare the "${permission}" permission, so it cannot ${
        permission === 'backlog.read' ? 'read' : 'change'
      } the Backlog.`,
    )
  }

  // The project folder a workspace's Backlog belongs to: its durable root, the
  // folder the Backlog panel reads, never a worktree a chat runs in.
  function folderOf(workspaceId: unknown): { folder: string; name: string } | Failure {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
      return failure('invalid_input', 'A workspace id is required.')
    }
    const workspace = deps.getWorkspace(workspaceId)
    if (!workspace) return failure('unknown_workspace', `There is no open workspace "${workspaceId}".`)
    if (!workspace.folderPath) {
      return failure(
        'workspace_folder_missing',
        `Workspace "${workspaceId}" has no project folder, so it has no Backlog.`,
      )
    }
    return { folder: workspace.folderPath, name: workspace.name }
  }

  // An item is named by its view id: the logical `backlog/…` path. It must be
  // one that exists, or a link or metadata write would conjure a record for a
  // file that is not there.
  async function itemPath(folder: string, itemId: unknown): Promise<string | Failure> {
    if (typeof itemId !== 'string' || !itemId.trim()) return failure('invalid_input', 'An item id is required.')
    const read = await readBacklogItem(folder, itemId.trim())
    if (!read.ok) {
      return /does not exist/.test(read.message)
        ? failure('not_found', `There is no Backlog item "${itemId}" in this workspace.`)
        : failure('invalid_input', read.message)
    }
    return read.item.relativePath
  }

  // A write's outcome in the service's vocabulary: the Backlog service's own
  // refusals carry its sentence.
  function written(result: { ok: true } | { ok: false; message: string }): ModuleBacklogResult {
    if (result.ok) return { ok: true }
    return /file not found|does not exist/i.test(result.message)
      ? failure('not_found', result.message)
      : failure('backlog_unavailable', result.message)
  }

  // A mutation of one existing item, in the project's lane.
  async function mutate(
    moduleId: string,
    workspaceId: string,
    itemId: string,
    write: (folder: string, relativePath: string) => Promise<ModuleBacklogResult>,
  ): Promise<ModuleBacklogResult> {
    const refused = denied(moduleId, 'backlog.write')
    if (refused) return refused
    const resolved = folderOf(workspaceId)
    if ('ok' in resolved) return resolved
    try {
      return await withBacklogWorkspaceLock(resolved.folder, async () => {
        const relativePath = await itemPath(resolved.folder, itemId)
        if (typeof relativePath !== 'string') return relativePath
        return write(resolved.folder, relativePath)
      })
    } catch (error) {
      return failure('backlog_unavailable', errorMessage(error))
    }
  }

  return {
    async list(moduleId, workspaceId) {
      const refused = denied(moduleId, 'backlog.read')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      try {
        const located = await resolveBacklogLocation(resolved.folder)
        if (!located.ok) return failure('backlog_unavailable', located.message)
        if (!located.location.exists) return { ok: true, items: [] }
        const scan = await scanBacklog(
          { workspaceRoot: located.location.workspaceRoot, root: located.location.root },
          nodeBacklogFs,
        )
        if (scan.state === 'error') {
          const cause = scan.errors[0]
          return failure(
            'backlog_unavailable',
            `The Backlog could not be read${cause ? `: ${cause.relativePath}: ${cause.message}` : '.'}`,
          )
        }
        return { ok: true, items: await hydrate(resolved.folder, scan) }
      } catch (error) {
        return failure('backlog_unavailable', errorMessage(error))
      }
    },

    async getLocation(moduleId, workspaceId) {
      const refused = denied(moduleId, 'backlog.read')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      const located = await resolveBacklogLocation(resolved.folder)
      if (!located.ok) return failure('backlog_unavailable', located.message)
      const { root, isDefault, exists } = located.location
      return { ok: true, location: { root, isDefault, exists } }
    },

    async create(moduleId, workspaceId, input) {
      const refused = denied(moduleId, 'backlog.write')
      if (refused) return refused
      const resolved = folderOf(workspaceId)
      if ('ok' in resolved) return resolved
      const invalid = invalidCreateInput(input)
      if (invalid) return failure('invalid_input', invalid)
      // The app's own create path: it takes the project's lane itself, mints
      // the next id, picks a unique file name under the epic's folder and
      // writes with `wx`, so nothing here has to repeat its rules.
      const created = await createBacklogItem({
        workspaceRoot: resolved.folder,
        title: input.title.trim(),
        ...(input.body?.trim() ? { description: input.body } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.type ? { type: input.type } : {}),
        ...(input.epic ? { epic: input.epic } : {}),
        ...(input.difficulty ? { difficulty: input.difficulty } : {}),
        ...(input.criticality ? { criticality: input.criticality } : {}),
        ...(input.risk ? { risk: input.risk } : {}),
      })
      if (!created.ok) return failure('backlog_unavailable', created.message)
      const located = await resolveBacklogLocation(resolved.folder)
      const path =
        (located.ok
          ? backlogAbsolutePath(
              { workspaceRoot: located.location.workspaceRoot, root: located.location.root },
              created.relativePath,
            )
          : null) ?? join(resolved.folder, created.relativePath)
      const key = await peekBacklogDisplayKey(resolved.folder).catch(() => null)
      return {
        ok: true,
        id: created.relativePath,
        relativePath: created.relativePath,
        path,
        numericId: created.numericId,
        ...(key ? { displayId: formatBacklogDisplayId({ key, numericId: created.numericId }) } : {}),
      }
    },

    updateStatus(moduleId, workspaceId, itemId, status) {
      if (typeof status !== 'string' || !STATUSES.has(status)) {
        return Promise.resolve(failure('invalid_input', `"${String(status)}" is not a Backlog item status.`))
      }
      return mutate(moduleId, workspaceId, itemId, async (folder, relativePath) =>
        written(await updateBacklogStatus({ workspaceRoot: folder, relativePath, status })),
      )
    },

    updateTriage(moduleId, workspaceId, itemId, triage) {
      const invalid = invalidTriage(triage)
      if (invalid) return Promise.resolve(failure('invalid_input', invalid))
      return mutate(moduleId, workspaceId, itemId, async (folder, relativePath) => {
        if (!('difficulty' in triage) && !('criticality' in triage) && !('risk' in triage)) return { ok: true }
        // Validated above, so each value is one of the app's or null.
        const update: BacklogTriageInput = { workspaceRoot: folder, relativePath }
        if ('difficulty' in triage) update.difficulty = (triage.difficulty ?? null) as BacklogTriageInput['difficulty']
        if ('criticality' in triage)
          update.criticality = (triage.criticality ?? null) as BacklogTriageInput['criticality']
        if ('risk' in triage) update.risk = (triage.risk ?? null) as BacklogTriageInput['risk']
        return written(await updateBacklogTriage(update))
      })
    },

    addLink(moduleId, workspaceId, itemId, link) {
      const invalid = invalidLink(moduleId, link)
      if (invalid) return Promise.resolve(failure('invalid_input', invalid))
      return mutate(moduleId, workspaceId, itemId, async (folder, relativePath) =>
        written(
          await addOrUpdateBacklogLink({
            workspaceRoot: folder,
            relativePath,
            // The owner is the caller, whatever the link said.
            link: { ...link, moduleId },
          }),
        ),
      )
    },

    updateModuleMetadata(moduleId, workspaceId, itemId, value) {
      try {
        if (value !== undefined) JSON.stringify(value)
      } catch {
        return Promise.resolve(failure('invalid_input', 'Module metadata must be JSON-serializable.'))
      }
      return mutate(moduleId, workspaceId, itemId, async (folder, relativePath) =>
        written(await updateBacklogModuleMetadata({ workspaceRoot: folder, relativePath, moduleId, value })),
      )
    },
  }
}

// The scan's items with what the app keeps beside each file (links, module
// metadata) and the display id composed from the workspace's key: the same
// item the Backlog panel holds, read without writing anything.
async function hydrate(folder: string, scan: BacklogScanResult): Promise<BacklogItem[]> {
  const store = await readBacklogObjectStore(folder)
  const byPath = new Map(
    (store.ok ? store.store.items : []).map((record) => [record.source.relativePath.toLowerCase(), record]),
  )
  const key = await peekBacklogDisplayKey(folder).catch(() => null)
  return scan.items.map((scanned) => {
    const record = byPath.get(scanned.relativePath.toLowerCase())
    const object: BacklogItemObjectMetadata | undefined = record
      ? {
          objectId: record.id,
          metadata: record.metadata ?? {},
          links: record.links ?? [],
          highlight: record.highlight,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      : undefined
    const item = object
      ? createBacklogScanItem({
          path: scanned.path,
          relativePath: scanned.relativePath,
          sourceContent: scanned.sourceContent,
          stats: { modifiedAtMs: scanned.modifiedAt, sizeBytes: scanned.size },
          object,
        })
      : scanned
    return key && typeof item.numericId === 'number'
      ? { ...item, displayId: formatBacklogDisplayId({ key, numericId: item.numericId }) }
      : item
  })
}

function invalidCreateInput(input: unknown): string | null {
  const value = input as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The new item is required.'
  if (typeof value.title !== 'string' || !value.title.trim()) return 'A title is required.'
  if (value.title.length > MAX_TITLE) return `A title is at most ${MAX_TITLE} characters.`
  if (value.body !== undefined && typeof value.body !== 'string') return '"body" must be a string.'
  if (typeof value.body === 'string' && value.body.length > MAX_BODY) return 'The body is too long.'
  if (value.status !== undefined && (typeof value.status !== 'string' || !STATUSES.has(value.status))) {
    return `"${String(value.status)}" is not a Backlog item status.`
  }
  if (value.status === 'archived') return 'A new item cannot start archived.'
  if (value.type !== undefined && !isBacklogType(value.type)) return `"${String(value.type)}" is not a Backlog type.`
  if (value.epic !== undefined && (typeof value.epic !== 'string' || !EPIC_SLUG.test(value.epic))) {
    return `"${String(value.epic)}" is not an epic slug.`
  }
  if (value.difficulty !== undefined && !isBacklogDifficulty(value.difficulty)) {
    return `"${String(value.difficulty)}" is not a difficulty.`
  }
  if (value.criticality !== undefined && !isBacklogCriticality(value.criticality)) {
    return `"${String(value.criticality)}" is not a criticality.`
  }
  if (value.risk !== undefined && !isBacklogRisk(value.risk)) return `"${String(value.risk)}" is not a risk.`
  return null
}

function invalidTriage(triage: unknown): string | null {
  const value = triage as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The triage to change is required.'
  if (value.difficulty != null && !isBacklogDifficulty(value.difficulty)) {
    return `"${String(value.difficulty)}" is not a difficulty.`
  }
  if (value.criticality != null && !isBacklogCriticality(value.criticality)) {
    return `"${String(value.criticality)}" is not a criticality.`
  }
  if (value.risk != null && !isBacklogRisk(value.risk)) return `"${String(value.risk)}" is not a risk.`
  return null
}

function invalidLink(moduleId: string, link: unknown): string | null {
  const value = link as Record<string, unknown> | null
  if (!value || typeof value !== 'object') return 'The link is required.'
  if (value.moduleId !== undefined && value.moduleId !== moduleId) {
    return `A module records links as itself; "${String(value.moduleId)}" is not "${moduleId}".`
  }
  if (typeof value.id !== 'string' || !value.id.trim()) return 'A link id is required.'
  if (typeof value.type !== 'string' || !LINK_TYPES.has(value.type))
    return `"${String(value.type)}" is not a link type.`
  if (typeof value.label !== 'string') return 'A link label is required.'
  const target = value.target as Record<string, unknown> | null
  if (!target || typeof target !== 'object' || typeof target.kind !== 'string' || typeof target.id !== 'string') {
    return 'A link target needs a kind and an id.'
  }
  return null
}
