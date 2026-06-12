import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type {
  BacklogAddOrUpdateLinkInput,
  BacklogHighlightColorPayload,
  BacklogHighlightInput,
  BacklogItemLinkPayload,
  BacklogItemRecordInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogObjectRecordPayload,
  BacklogObjectStorePayload,
  BacklogReadResult,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogMoveSourceInput,
} from '../shared/electron-api'

const STORE_PATH = ['.multi-code', 'backlog', 'items.json'] as const
const BACKLOG_PREFIX = 'backlog/'

type ValidWorkspace = {
  root: string
  storePath: string
}

type BacklogObjectStore = BacklogObjectStorePayload
type BacklogObjectRecord = BacklogObjectRecordPayload

const EMPTY_STORE: BacklogObjectStore = { schemaVersion: 1, items: [] }

const VALID_STATUS = new Set(['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'])
const VALID_TYPE = new Set(['feature', 'bug', 'mockup'])
const VALID_DIFFICULTY = new Set(['xs', 's', 'm', 'l', 'xl'])
const VALID_CRITICALITY = new Set(['low', 'normal', 'high', 'critical'])
const VALID_HIGHLIGHT_COLOR = new Set(['red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink'])

export async function readBacklogObjectStore(workspaceRoot: string): Promise<BacklogReadResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const store = await loadStore(workspace)
    return { ok: true, store }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export async function ensureBacklogObjectRecords(
  workspaceRoot: string,
  items: BacklogItemRecordInput[],
): Promise<BacklogReadResult> {
  return mutateStore(workspaceRoot, () => null, (store, now) => {
    const nextItems = [...store.items]
    let changed = false
    for (const item of items) {
      const relativePath = validateBacklogRelativePath(item.relativePath)
      const pathKey = relativePath.toLowerCase()
      if (nextItems.some((record) => record.source.relativePath.toLowerCase() === pathKey)) continue
      nextItems.push({
        id: stableBacklogObjectId(relativePath),
        source: { type: 'file', relativePath },
        status: isBacklogStatus(item.status) ? item.status : 'idea',
        type: isBacklogType(item.type) ? item.type : undefined,
        difficulty: isBacklogDifficulty(item.difficulty) ? item.difficulty : undefined,
        criticality: isBacklogCriticality(item.criticality) ? item.criticality : undefined,
        metadata: {},
        links: [],
        createdAt: now,
        updatedAt: now,
      })
      changed = true
    }
    return changed ? { schemaVersion: 1, items: nextItems } : store
  })
}

export async function updateBacklogStatus(input: BacklogStatusInput): Promise<BacklogMutationResult> {
  if (!isBacklogStatus(input.status)) return { ok: false, message: 'Enter a valid Backlog item status.' }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    status: input.status,
    updatedAt: now,
  }))
}

export async function updateBacklogType(input: BacklogTypeInput): Promise<BacklogMutationResult> {
  if (input.type !== null && !isBacklogType(input.type)) return { ok: false, message: 'Enter a valid Backlog item type.' }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    type: input.type ?? undefined,
    updatedAt: now,
  }))
}

export async function updateBacklogTriage(input: BacklogTriageInput): Promise<BacklogMutationResult> {
  if (input.difficulty !== undefined && input.difficulty !== null && !isBacklogDifficulty(input.difficulty)) {
    return { ok: false, message: 'Enter a valid Backlog item difficulty.' }
  }
  if (input.criticality !== undefined && input.criticality !== null && !isBacklogCriticality(input.criticality)) {
    return { ok: false, message: 'Enter a valid Backlog item criticality.' }
  }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => {
    const next = { ...record, updatedAt: now }
    if ('difficulty' in input) next.difficulty = input.difficulty ?? undefined
    if ('criticality' in input) next.criticality = input.criticality ?? undefined
    return next
  })
}

export async function updateBacklogHighlight(input: BacklogHighlightInput): Promise<BacklogMutationResult> {
  if (typeof input.starred !== 'boolean') return { ok: false, message: 'Enter a valid Backlog highlight star value.' }
  if (input.color !== null && !isBacklogHighlightColor(input.color)) {
    return { ok: false, message: 'Enter a valid Backlog highlight color.' }
  }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    // Unstarred with no color is the default state: drop the field instead of
    // persisting an empty highlight object.
    highlight: input.starred || input.color !== null ? { starred: input.starred, color: input.color } : undefined,
    updatedAt: now,
  }))
}

export async function addOrUpdateBacklogLink(input: BacklogAddOrUpdateLinkInput): Promise<BacklogMutationResult> {
  const link = normalizeBacklogLink(input.link)
  if (!link) return { ok: false, message: 'Enter a valid Backlog item link.' }
  if (link.target.path) {
    if (isAbsolutePathInput(link.target.path)) {
      return { ok: false, message: 'Backlog link target paths must stay project-relative.' }
    }
    const normalizedTargetPath = normalizeRelativePath(link.target.path)
    if (isUnsafeRelativePath(normalizedTargetPath)) {
      return { ok: false, message: 'Backlog link target paths must stay project-relative.' }
    }
    link.target.path = normalizedTargetPath
  }
  if (input.status !== undefined && !isBacklogStatus(input.status)) {
    return { ok: false, message: 'Enter a valid Backlog item status.' }
  }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => {
    const nextLink = { ...link, updatedAt: link.updatedAt ?? now }
    return {
      ...record,
      status: input.status ?? record.status,
      links: [...(record.links ?? []).filter((candidate) => candidate.id !== nextLink.id), nextLink],
      updatedAt: now,
    }
  })
}

export async function updateBacklogModuleMetadata(input: BacklogModuleMetadataInput): Promise<BacklogMutationResult> {
  const moduleId = input.moduleId.trim()
  if (!moduleId) return { ok: false, message: 'Backlog module metadata requires a module id.' }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    metadata: {
      ...(record.metadata ?? {}),
      [moduleId]: input.value,
    },
    updatedAt: now,
  }))
}

export async function moveBacklogObjectSource(input: BacklogMoveSourceInput): Promise<BacklogMutationResult> {
  let nextRelativePath: string
  try {
    nextRelativePath = validateBacklogRelativePath(input.nextRelativePath)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    source: { type: 'file', relativePath: nextRelativePath },
    status: nextRelativePath.toLowerCase().startsWith('backlog/archived/') ? 'archived' : record.status,
    updatedAt: now,
  }))
}

export async function removeBacklogObjectRecord(input: BacklogRemoveRecordInput): Promise<BacklogMutationResult> {
  return mutateStore(input.workspaceRoot, () => validateBacklogRelativePath(input.relativePath), (store) => {
    const pathKey = normalizeRelativePath(input.relativePath).toLowerCase()
    return {
      schemaVersion: 1,
      items: store.items.filter((record) => record.source.relativePath.toLowerCase() !== pathKey),
    }
  })
}

async function mutateItem(
  workspaceRoot: string,
  relativePath: string,
  update: (record: BacklogObjectRecord, now: string) => BacklogObjectRecord,
): Promise<BacklogMutationResult> {
  return mutateStore(workspaceRoot, () => validateBacklogRelativePath(relativePath), (store, now) => {
    const normalizedPath = normalizeRelativePath(relativePath)
    const pathKey = normalizedPath.toLowerCase()
    const index = store.items.findIndex((record) => record.source.relativePath.toLowerCase() === pathKey)
    const base: BacklogObjectRecord = index >= 0
      ? store.items[index]
      : {
          id: stableBacklogObjectId(normalizedPath),
          source: { type: 'file', relativePath: normalizedPath },
          status: 'idea',
          metadata: {},
          links: [],
          createdAt: now,
          updatedAt: now,
        }
    const items = [...store.items]
    const next = update(base, now)
    if (index >= 0) {
      items[index] = next
    } else {
      items.push(next)
    }
    return { schemaVersion: 1, items }
  })
}

async function mutateStore(
  workspaceRoot: string,
  validate: () => unknown,
  update: (store: BacklogObjectStore, now: string) => BacklogObjectStore,
): Promise<BacklogMutationResult> {
  try {
    validate()
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const store = await loadStore(workspace)
    const nextStore = normalizeStore(update(store, new Date().toISOString()))
    await saveStore(workspace, nextStore)
    return { ok: true, store: nextStore }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function validateWorkspaceRoot(workspaceRoot: string): Promise<ValidWorkspace> {
  if (!isAbsolute(workspaceRoot)) throw new Error('Backlog workspace root must be an absolute path.')
  const root = await realpath(workspaceRoot).catch((error) => {
    throw new Error(`Backlog workspace root is not accessible: ${errorMessage(error)}`)
  })
  const rootStat = await stat(root).catch((error) => {
    throw new Error(`Backlog workspace root is not accessible: ${errorMessage(error)}`)
  })
  if (!rootStat.isDirectory()) throw new Error('Backlog workspace root must be an existing folder.')
  return { root, storePath: join(root, ...STORE_PATH) }
}

async function loadStore(workspace: ValidWorkspace): Promise<BacklogObjectStore> {
  let raw: string
  try {
    raw = await readFile(workspace.storePath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_STORE
    throw new Error(`Could not read Backlog metadata: ${errorMessage(error)}`)
  }
  try {
    return normalizeStore(JSON.parse(raw) as unknown)
  } catch (error) {
    throw new Error(`Could not parse Backlog metadata: ${errorMessage(error)}`)
  }
}

async function saveStore(workspace: ValidWorkspace, store: BacklogObjectStore): Promise<void> {
  const target = resolve(workspace.storePath)
  if (!isPathInside(workspace.root, target)) throw new Error('Backlog metadata path escaped the workspace root.')
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(normalizeStore(store), null, 2)}\n`, 'utf-8')
  } catch (error) {
    throw new Error(`Could not write Backlog metadata: ${errorMessage(error)}`)
  }
}

function validateBacklogRelativePath(value: string): string {
  if (isAbsolutePathInput(value)) {
    throw new Error('Backlog item paths must be relative paths under backlog/.')
  }
  const normalized = normalizeRelativePath(value)
  if (!normalized.startsWith(BACKLOG_PREFIX) || isUnsafeRelativePath(normalized)) {
    throw new Error('Backlog item paths must be relative paths under backlog/.')
  }
  return normalized
}

function normalizeStore(value: unknown): BacklogObjectStore {
  if (!value || typeof value !== 'object') return EMPTY_STORE
  const raw = value as { items?: unknown }
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeRecord).filter((record): record is BacklogObjectRecord => Boolean(record))
    : []
  return { schemaVersion: 1, items }
}

function normalizeRecord(value: unknown): BacklogObjectRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as BacklogObjectRecord
  if (!raw.source || typeof raw.source.relativePath !== 'string') return null
  let relativePath: string
  try {
    relativePath = validateBacklogRelativePath(raw.source.relativePath)
  } catch {
    return null
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : stableBacklogObjectId(relativePath)
  return {
    id,
    source: { type: 'file', relativePath },
    status: isBacklogStatus(raw.status) ? raw.status : undefined,
    type: isBacklogType(raw.type) ? raw.type : undefined,
    difficulty: isBacklogDifficulty(raw.difficulty) ? raw.difficulty : undefined,
    criticality: isBacklogCriticality(raw.criticality) ? raw.criticality : undefined,
    highlight: normalizeBacklogHighlight(raw.highlight),
    metadata: isPlainRecord(raw.metadata) ? raw.metadata : {},
    links: Array.isArray(raw.links) ? raw.links.map(normalizeBacklogLink).filter((link): link is BacklogItemLinkPayload => Boolean(link)) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

function normalizeBacklogHighlight(value: unknown): BacklogObjectRecord['highlight'] {
  if (!isPlainRecord(value)) return undefined
  const starred = value.starred === true
  const color = isBacklogHighlightColor(value.color) ? value.color : null
  if (!starred && color === null) return undefined
  return { starred, color }
}

function normalizeBacklogLink(value: unknown): BacklogItemLinkPayload | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as BacklogItemLinkPayload
  if (
    typeof raw.id !== 'string'
    || typeof raw.moduleId !== 'string'
    || typeof raw.type !== 'string'
    || typeof raw.label !== 'string'
    || !raw.target
    || typeof raw.target.kind !== 'string'
    || typeof raw.target.id !== 'string'
  ) {
    return null
  }
  return {
    id: raw.id,
    moduleId: raw.moduleId,
    type: raw.type,
    label: raw.label,
    target: {
      kind: raw.target.kind,
      id: raw.target.id,
      path: typeof raw.target.path === 'string' ? raw.target.path : undefined,
      url: typeof raw.target.url === 'string' ? raw.target.url : undefined,
    },
    status: typeof raw.status === 'string' ? raw.status : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

function stableBacklogObjectId(relativePath: string): string {
  let hash = 0
  for (let i = 0; i < relativePath.length; i += 1) {
    hash = ((hash << 5) - hash) + relativePath.charCodeAt(i)
    hash |= 0
  }
  return `backlog_${(hash >>> 0).toString(36)}`
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function isUnsafeRelativePath(path: string): boolean {
  return path === '..' || path.startsWith('../') || path.includes('/../') || isAbsolute(path)
}

function isAbsolutePathInput(path: string): boolean {
  return isAbsolute(path)
    || path.startsWith('/')
    || path.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(path)
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function isBacklogStatus(value: unknown): value is BacklogObjectRecord['status'] {
  return typeof value === 'string' && VALID_STATUS.has(value)
}

function isBacklogType(value: unknown): value is BacklogObjectRecord['type'] {
  return typeof value === 'string' && VALID_TYPE.has(value)
}

function isBacklogDifficulty(value: unknown): value is BacklogObjectRecord['difficulty'] {
  return typeof value === 'string' && VALID_DIFFICULTY.has(value)
}

function isBacklogCriticality(value: unknown): value is BacklogObjectRecord['criticality'] {
  return typeof value === 'string' && VALID_CRITICALITY.has(value)
}

function isBacklogHighlightColor(value: unknown): value is BacklogHighlightColorPayload {
  return typeof value === 'string' && VALID_HIGHLIGHT_COLOR.has(value)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
