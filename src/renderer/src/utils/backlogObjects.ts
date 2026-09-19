import {
  type BacklogCriticality,
  type BacklogDifficulty,
  type BacklogHighlight,
  type BacklogItemLink,
  type BacklogItemObjectMetadata,
  type BacklogItemStatus,
  type BacklogRisk,
  type BacklogType,
  type BacklogScanResult,
  createBacklogItem,
  isBacklogCriticality,
  isBacklogDifficulty,
  isBacklogHighlightColor,
  isBacklogRisk,
  isBacklogType,
  normalizeRelativePath,
  stableBacklogObjectId,
} from './backlog'

type BacklogObjectRecord = {
  id: string
  source: {
    type: 'file'
    relativePath: string
  }
  status?: BacklogItemStatus
  type?: BacklogType
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  risk?: BacklogRisk
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

const EMPTY_BACKLOG_OBJECT_STORE: BacklogObjectStore = {
  schemaVersion: 1,
  items: [],
}

export function hydrateBacklogScanResult(scan: BacklogScanResult, store: BacklogObjectStore): BacklogScanResult {
  if (scan.items.length === 0) return scan
  const byPath = recordsByPath(store)
  const items = scan.items.map((item) => {
    const record = byPath.get(item.relativePath.toLowerCase())
    if (!record) return item
    // The sidecar owns only app churn: links, module metadata, the star/highlight,
    // and its own timestamp. Lifecycle/triage (status, type, difficulty,
    // criticality) and epic now live in frontmatter and win on every scan, so a
    // stale sidecar value can never shadow what the file says.
    const object: BacklogItemObjectMetadata = {
      objectId: record.id,
      metadata: record.metadata ?? {},
      links: record.links ?? [],
      highlight: record.highlight,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
    return createBacklogItem({
      path: item.path,
      relativePath: item.relativePath,
      sourceContent: item.sourceContent,
      stats: { modifiedAtMs: item.modifiedAt, sizeBytes: item.size },
      object,
    })
  })
  return { ...scan, items } as BacklogScanResult
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
    risk?: unknown
    highlight?: unknown
    metadata?: unknown
    links?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  if (typeof raw.source?.relativePath !== 'string') return null
  const relativePath = normalizeRelativePath(raw.source.relativePath)
  if (!relativePath.startsWith('backlog/')) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : stableBacklogObjectId(relativePath)
  return {
    id,
    source: { type: 'file', relativePath },
    status: isBacklogObjectStatus(raw.status) ? raw.status : undefined,
    type: isBacklogType(raw.type) ? raw.type : undefined,
    difficulty: isBacklogDifficulty(raw.difficulty) ? raw.difficulty : undefined,
    criticality: isBacklogCriticality(raw.criticality) ? raw.criticality : undefined,
    risk: isBacklogRisk(raw.risk) ? raw.risk : undefined,
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
  return (
    value === 'idea' ||
    value === 'ready' ||
    value === 'in_progress' ||
    value === 'needs_input' ||
    value === 'completed' ||
    value === 'archived'
  )
}

function isBacklogItemLink(value: unknown): value is BacklogItemLink {
  if (!value || typeof value !== 'object') return false
  const raw = value as BacklogItemLink
  return (
    typeof raw.id === 'string' &&
    typeof raw.moduleId === 'string' &&
    typeof raw.type === 'string' &&
    typeof raw.label === 'string' &&
    Boolean(raw.target) &&
    typeof raw.target.kind === 'string' &&
    typeof raw.target.id === 'string'
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
