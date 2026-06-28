import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  serializeBacklogFrontmatterFields,
  type BacklogFrontmatterUpdates,
} from '../shared/backlog/frontmatter'
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
const VALID_TYPE = new Set(['epic', 'feature', 'bug', 'mockup', 'spike'])
const VALID_DIFFICULTY = new Set(['xs', 's', 'm', 'l', 'xl'])
const VALID_CRITICALITY = new Set(['low', 'normal', 'high', 'critical'])
const VALID_RISK = new Set(['low', 'normal', 'high'])
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

export type BacklogCreateInput = {
  workspaceRoot: string
  title: string
  description?: string
  type?: string
  difficulty?: string
  criticality?: string
}

export type BacklogCreateResult =
  | { ok: true; id: string; relativePath: string; store: BacklogObjectStorePayload }
  | { ok: false; message: string }

// Creates a brand-new Backlog item from the phone: writes the real `.md` file
// AND upserts the items.json record. Filename mirrors the desktop renderer's
// `${today}-${slug(title)}.md` convention and dedups against the current store.
export async function createBacklogItem(input: BacklogCreateInput): Promise<BacklogCreateResult> {
  const title = input.title.trim()
  if (!title) return { ok: false, message: 'Enter a title for the new Backlog item.' }
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const store = await loadStore(workspace)
    const existingLower = new Set(store.items.map((record) => record.source.relativePath.toLowerCase()))
    const relativePath = await uniqueBacklogFilePath(workspace, title, existingLower)
    const target = resolve(join(workspace.root, relativePath))
    if (!isPathInside(workspace.root, target)) throw new Error('Backlog item path escaped the workspace root.')

    const description = input.description?.trim()
    const body = description ? `# ${title}\n\n${description}\n` : `# ${title}\n`
    await mkdir(dirname(target), { recursive: true })
    // `wx` fails instead of clobbering if a file appears between the uniqueness
    // check and the write.
    await writeFile(target, body, { encoding: 'utf-8', flag: 'wx' })

    const now = new Date().toISOString()
    const record: BacklogObjectRecord = {
      id: stableBacklogObjectId(relativePath),
      source: { type: 'file', relativePath },
      status: 'idea',
      type: isBacklogType(input.type) ? input.type : undefined,
      difficulty: isBacklogDifficulty(input.difficulty) ? input.difficulty : undefined,
      criticality: isBacklogCriticality(input.criticality) ? input.criticality : undefined,
      metadata: {},
      links: [],
      createdAt: now,
      updatedAt: now,
    }
    const nextStore = normalizeStore({ schemaVersion: 1, items: [...store.items, record] })
    await saveStore(workspace, nextStore)
    return { ok: true, id: record.id, relativePath, store: nextStore }
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

// Lifecycle, type, and triage (difficulty/criticality/risk) are frontmatter-
// sourced: these write the item's markdown frontmatter via the shared helper
// (body byte-preserved) and never touch items.json. The matching reader is
// parseBacklogFrontmatter in src/shared/backlog/frontmatter.ts.
export async function updateBacklogStatus(input: BacklogStatusInput): Promise<BacklogMutationResult> {
  if (!isBacklogStatus(input.status)) return { ok: false, message: 'Enter a valid Backlog item status.' }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { status: input.status })
}

export async function updateBacklogType(input: BacklogTypeInput): Promise<BacklogMutationResult> {
  if (input.type !== null && !isBacklogType(input.type)) return { ok: false, message: 'Enter a valid Backlog item type.' }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { type: input.type })
}

export async function updateBacklogTriage(input: BacklogTriageInput): Promise<BacklogMutationResult> {
  if (input.difficulty !== undefined && input.difficulty !== null && !isBacklogDifficulty(input.difficulty)) {
    return { ok: false, message: 'Enter a valid Backlog item difficulty.' }
  }
  if (input.criticality !== undefined && input.criticality !== null && !isBacklogCriticality(input.criticality)) {
    return { ok: false, message: 'Enter a valid Backlog item criticality.' }
  }
  if (input.risk !== undefined && input.risk !== null && !isBacklogRisk(input.risk)) {
    return { ok: false, message: 'Enter a valid Backlog item risk.' }
  }
  // Only axes the caller actually supplied are touched; null clears that key's
  // frontmatter line, an omitted axis is left exactly as written.
  const updates: BacklogFrontmatterUpdates = {}
  if ('difficulty' in input) updates.difficulty = input.difficulty ?? null
  if ('criticality' in input) updates.criticality = input.criticality ?? null
  if ('risk' in input) updates.risk = input.risk ?? null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, updates)
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

// Read/modify/write the item's markdown frontmatter through the shared
// serializer (T1), leaving items.json untouched. This is the seam epic writes
// (T8) reuse — pass `{ epic: slug }` to point a child, `{ epic: null }` to
// orphan it. Path and workspace validation mirror the items.json mutators, and
// every failure returns an explicit `ok:false` rather than a silent fallback.
async function writeBacklogFrontmatter(
  workspaceRoot: string,
  relativePath: string,
  updates: BacklogFrontmatterUpdates,
): Promise<BacklogMutationResult> {
  let normalizedPath: string
  try {
    normalizedPath = validateBacklogRelativePath(relativePath)
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const target = resolve(join(workspace.root, normalizedPath))
    if (!isPathInside(workspace.root, target)) throw new Error('Backlog item path escaped the workspace root.')

    let content: string
    try {
      content = await readFile(target, 'utf-8')
    } catch (error) {
      const detail = isMissingFileError(error) ? 'file not found' : errorMessage(error)
      throw new Error(`Could not read Backlog item: ${detail}`)
    }

    const next = serializeBacklogFrontmatterFields(content, updates)
    if (next !== content) {
      try {
        await writeFile(target, next, 'utf-8')
      } catch (error) {
        throw new Error(`Could not write Backlog item: ${errorMessage(error)}`)
      }
    }
    // Frontmatter is the source of truth for these fields, but the result still
    // carries the (unchanged) sidecar so the IPC contract and renderer callers
    // stay identical.
    const store = await loadStore(workspace)
    return { ok: true, store }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
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

async function uniqueBacklogFilePath(
  workspace: ValidWorkspace,
  title: string,
  existingLower: Set<string>,
): Promise<string> {
  const base = `${backlogTodayPrefix(new Date())}-${slugifyBacklogTitle(title)}`
  let candidate = `${BACKLOG_PREFIX}${base}.md`
  let index = 2
  while (existingLower.has(candidate.toLowerCase()) || (await backlogFileExists(workspace, candidate))) {
    candidate = `${BACKLOG_PREFIX}${base}-${index}.md`
    index += 1
  }
  return validateBacklogRelativePath(candidate)
}

async function backlogFileExists(workspace: ValidWorkspace, relativePath: string): Promise<boolean> {
  try {
    await stat(join(workspace.root, relativePath))
    return true
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
}

function slugifyBacklogTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'
}

function backlogTodayPrefix(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
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

function isBacklogRisk(value: unknown): value is BacklogObjectRecord['risk'] {
  return typeof value === 'string' && VALID_RISK.has(value)
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
