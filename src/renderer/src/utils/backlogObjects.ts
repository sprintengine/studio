import {
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogHighlight,
  type BacklogItem,
  type BacklogItemLink,
  type BacklogItemObjectMetadata,
  type BacklogItemStatus,
  type BacklogType,
  type BacklogScanResult,
  createBacklogItem,
  isBacklogCriticality,
  isBacklogDifficulty,
  isBacklogHighlightColor,
  isBacklogType,
  normalizeRelativePath,
  stableBacklogObjectId,
} from './backlog'
import { joinPath } from '../components/workspace/newWorkspace/helpers'

export type BacklogObjectRecord = {
  id: string
  source: {
    type: 'file'
    relativePath: string
  }
  status?: BacklogItemStatus
  type?: BacklogType
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  highlight?: BacklogHighlight
  metadata?: Record<string, unknown>
  links?: BacklogItemLink[]
  createdAt?: string
  updatedAt?: string
}

export type BacklogObjectStore = {
  schemaVersion: 1
  items: BacklogObjectRecord[]
}

export type BacklogObjectFilesystem = {
  pathExists(path: string): Promise<boolean>
  readfile(path: string): Promise<string>
  writefile(path: string, content: string): Promise<void>
  ensureDir(parentDir: string, name: string): Promise<string>
}

export const EMPTY_BACKLOG_OBJECT_STORE: BacklogObjectStore = {
  schemaVersion: 1,
  items: [],
}

const STORE_PARENT = '.multi-code'
const STORE_FOLDER = 'backlog'
const STORE_FILE = 'items.json'

export function backlogObjectStorePath(workspaceRoot: string): string {
  return joinPath(joinPath(joinPath(workspaceRoot, STORE_PARENT), STORE_FOLDER), STORE_FILE)
}

export async function loadBacklogObjectStore(
  workspaceRoot: string,
  fs: Pick<BacklogObjectFilesystem, 'pathExists' | 'readfile'>,
): Promise<BacklogObjectStore> {
  const path = backlogObjectStorePath(workspaceRoot)
  if (!(await fs.pathExists(path))) return EMPTY_BACKLOG_OBJECT_STORE
  const parsed = JSON.parse(await fs.readfile(path)) as unknown
  return normalizeBacklogObjectStore(parsed)
}

export async function saveBacklogObjectStore(
  workspaceRoot: string,
  fs: Pick<BacklogObjectFilesystem, 'ensureDir' | 'writefile'>,
  store: BacklogObjectStore,
): Promise<void> {
  const multiCodeDir = await fs.ensureDir(workspaceRoot, STORE_PARENT)
  const backlogDir = await fs.ensureDir(multiCodeDir, STORE_FOLDER)
  await fs.writefile(joinPath(backlogDir, STORE_FILE), `${JSON.stringify(normalizeBacklogObjectStore(store), null, 2)}\n`)
}

export function hydrateBacklogScanResult(
  scan: BacklogScanResult,
  store: BacklogObjectStore,
): BacklogScanResult {
  if (scan.items.length === 0) return scan
  const byPath = recordsByPath(store)
  const items = scan.items.map((item) => {
    const record = byPath.get(item.relativePath.toLowerCase())
    if (!record) return item
    const object: BacklogItemObjectMetadata = {
      objectId: record.id,
      metadata: record.metadata ?? {},
      links: record.links ?? [],
      type: record.type,
      difficulty: record.difficulty,
      criticality: record.criticality,
      highlight: record.highlight,
      updatedAt: record.updatedAt,
    }
    return {
      ...createBacklogItem({
        path: item.path,
        relativePath: item.relativePath,
        sourceContent: item.sourceContent,
        stats: { modifiedAtMs: item.modifiedAt, sizeBytes: item.size },
        object,
      }),
      status: item.status === 'archived' ? 'archived' : record.status ?? item.status,
    }
  })
  return { ...scan, items } as BacklogScanResult
}

export function ensureBacklogObjectRecords(
  store: BacklogObjectStore,
  items: BacklogItem[],
  now = new Date().toISOString(),
): { store: BacklogObjectStore; changed: boolean } {
  const normalized = normalizeBacklogObjectStore(store)
  const byPath = recordsByPath(normalized)
  let changed = false
  const nextItems = [...normalized.items]
  for (const item of items) {
    if (byPath.has(item.relativePath.toLowerCase())) continue
    nextItems.push({
      id: stableBacklogObjectId(item.relativePath),
      source: { type: 'file', relativePath: item.relativePath },
      status: item.status,
      type: item.type,
      difficulty: item.difficulty,
      criticality: item.criticality,
      metadata: {},
      links: [],
      createdAt: now,
      updatedAt: now,
    })
    changed = true
  }
  return { store: { schemaVersion: 1, items: nextItems }, changed }
}

export function updateBacklogObjectStatus(
  store: BacklogObjectStore,
  item: BacklogItem,
  status: BacklogItemStatus,
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => ({
    ...record,
    status,
    updatedAt: now,
  }), now)
}

// Sets or clears the item type on a backlog object. Passing null clears the
// durable override so source/frontmatter inference can surface again on scan.
export function updateBacklogObjectType(
  store: BacklogObjectStore,
  item: BacklogItem,
  type: BacklogType | null,
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => ({
    ...record,
    type: type ?? undefined,
    updatedAt: now,
  }), now)
}

// Sets or clears the triage metadata (size / priority) on a backlog object.
// Passing `null` for an axis clears it back to unestimated; omitting an axis
// leaves it untouched, so the Size and Priority editors can update one at a time.
export function updateBacklogObjectTriage(
  store: BacklogObjectStore,
  item: BacklogItem,
  triage: { difficulty?: BacklogDifficulty | null; criticality?: BacklogCriticality | null },
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => {
    const next: BacklogObjectRecord = { ...record, updatedAt: now }
    if ('difficulty' in triage) next.difficulty = triage.difficulty ?? undefined
    if ('criticality' in triage) next.criticality = triage.criticality ?? undefined
    return next
  }, now)
}

export function addBacklogObjectLink(
  store: BacklogObjectStore,
  item: BacklogItem,
  link: BacklogItemLink,
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => {
    const nextLink = { ...link, updatedAt: link.updatedAt ?? now }
    const links = [...(record.links ?? []).filter((candidate) => candidate.id !== nextLink.id), nextLink]
    return {
      ...record,
      links,
      updatedAt: now,
    }
  }, now)
}

export function addBacklogObjectLinkForPath(
  store: BacklogObjectStore,
  relativePath: string,
  link: BacklogItemLink,
  status?: BacklogItemStatus,
  now = new Date().toISOString(),
): BacklogObjectStore {
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const item = {
    relativePath: normalizedRelativePath,
    objectId: stableBacklogObjectId(normalizedRelativePath),
    status: status ?? 'ready',
  } as BacklogItem
  const withLink = addBacklogObjectLink(store, item, link, now)
  return status ? updateBacklogObjectStatus(withLink, item, status, now) : withLink
}

export function updateBacklogObjectMetadata(
  store: BacklogObjectStore,
  item: BacklogItem,
  moduleId: string,
  value: unknown,
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => ({
    ...record,
    metadata: {
      ...(record.metadata ?? {}),
      [moduleId]: value,
    },
    updatedAt: now,
  }), now)
}

export function moveBacklogObjectSource(
  store: BacklogObjectStore,
  item: BacklogItem,
  nextRelativePath: string,
  now = new Date().toISOString(),
): BacklogObjectStore {
  return upsertBacklogObjectRecord(store, item, (record) => ({
    ...record,
    source: { type: 'file', relativePath: normalizeRelativePath(nextRelativePath) },
    status: normalizeRelativePath(nextRelativePath).toLowerCase().startsWith('backlog/archived/')
      ? 'archived'
      : record.status,
    updatedAt: now,
  }), now)
}

export function removeBacklogObjectRecord(
  store: BacklogObjectStore,
  item: BacklogItem,
): BacklogObjectStore {
  const normalized = normalizeBacklogObjectStore(store)
  const pathKey = item.relativePath.toLowerCase()
  return {
    schemaVersion: 1,
    items: normalized.items.filter(
      (record) => normalizeRelativePath(record.source.relativePath).toLowerCase() !== pathKey
    ),
  }
}

function upsertBacklogObjectRecord(
  store: BacklogObjectStore,
  item: BacklogItem,
  update: (record: BacklogObjectRecord) => BacklogObjectRecord,
  now: string,
): BacklogObjectStore {
  const normalized = normalizeBacklogObjectStore(store)
  const pathKey = item.relativePath.toLowerCase()
  const index = normalized.items.findIndex((record) => normalizeRelativePath(record.source.relativePath).toLowerCase() === pathKey)
  const base: BacklogObjectRecord = index >= 0
    ? normalized.items[index]
    : {
      id: item.objectId || stableBacklogObjectId(item.relativePath),
      source: { type: 'file', relativePath: item.relativePath },
      status: item.status,
      metadata: {},
      links: [],
      createdAt: now,
      updatedAt: now,
    }
  const next = update(base)
  const items = [...normalized.items]
  if (index >= 0) {
    items[index] = next
  } else {
    items.push(next)
  }
  return { schemaVersion: 1, items }
}

function recordsByPath(store: BacklogObjectStore): Map<string, BacklogObjectRecord> {
  const out = new Map<string, BacklogObjectRecord>()
  for (const record of normalizeBacklogObjectStore(store).items) {
    out.set(normalizeRelativePath(record.source.relativePath).toLowerCase(), record)
  }
  return out
}

function normalizeBacklogObjectStore(value: unknown): BacklogObjectStore {
  if (!value || typeof value !== 'object') return EMPTY_BACKLOG_OBJECT_STORE
  const raw = value as { items?: unknown }
  const items: BacklogObjectRecord[] = []
  if (Array.isArray(raw.items)) {
    for (const candidate of raw.items) {
      const record = normalizeBacklogObjectRecord(candidate)
      if (record) items.push(record)
    }
  }
  return { schemaVersion: 1, items }
}

function normalizeBacklogObjectRecord(value: unknown): BacklogObjectRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as {
    id?: unknown
    source?: { type?: unknown; relativePath?: unknown }
    status?: unknown
    type?: unknown
    difficulty?: unknown
    criticality?: unknown
    highlight?: unknown
    metadata?: unknown
    links?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  if (typeof raw.source?.relativePath !== 'string') return null
  const relativePath = normalizeRelativePath(raw.source.relativePath)
  if (!relativePath.startsWith('backlog/')) return null
  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim()
    : stableBacklogObjectId(relativePath)
  return {
    id,
    source: { type: 'file', relativePath },
    status: isBacklogObjectStatus(raw.status) ? raw.status : undefined,
    type: isBacklogType(raw.type) ? raw.type : undefined,
    difficulty: isBacklogDifficulty(raw.difficulty) ? raw.difficulty : undefined,
    criticality: isBacklogCriticality(raw.criticality) ? raw.criticality : undefined,
    highlight: normalizeBacklogHighlight(raw.highlight),
    metadata: isPlainRecord(raw.metadata) ? raw.metadata : {},
    links: Array.isArray(raw.links) ? raw.links.filter(isBacklogItemLink) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
  }
}

function normalizeBacklogHighlight(value: unknown): BacklogHighlight | undefined {
  if (!isPlainRecord(value)) return undefined
  const starred = value.starred === true
  const color = isBacklogHighlightColor(value.color) ? value.color : null
  if (!starred && color === null) return undefined
  return { starred, color }
}

function isBacklogObjectStatus(value: unknown): value is BacklogItemStatus {
  return value === 'idea'
    || value === 'ready'
    || value === 'in_progress'
    || value === 'needs_input'
    || value === 'completed'
    || value === 'archived'
}

function isBacklogItemLink(value: unknown): value is BacklogItemLink {
  if (!value || typeof value !== 'object') return false
  const raw = value as BacklogItemLink
  return typeof raw.id === 'string'
    && typeof raw.moduleId === 'string'
    && typeof raw.type === 'string'
    && typeof raw.label === 'string'
    && Boolean(raw.target)
    && typeof raw.target.kind === 'string'
    && typeof raw.target.id === 'string'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
