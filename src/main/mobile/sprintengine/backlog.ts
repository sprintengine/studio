import { basename, isAbsolute, join, resolve } from 'path'
import { readdir, readFile } from 'fs/promises'

import { ensureBacklogObjectRecords, readBacklogFrontmatterFields, readBacklogObjectStore } from '../../backlog-service'
import type { BacklogFrontmatterFields } from '../../backlog-service'
import type { BacklogObjectRecordPayload } from '../../../shared/electron-api'
import type {
  MobileControlBacklogItemSnapshot,
  MobileControlBacklogWorkspaceSnapshot,
} from '../../../shared/mobile-control/protocol'
import { MobileSprintEngineCommandError } from './command-error'

const BACKLOG_FOLDER = 'backlog'
const ARCHIVED_PREFIX = 'backlog/archived/'
const maxBacklogItemsPerWorkspace = 50
const maxExcerptCharacters = 280
const maxStartPromptCharacters = 20_000

// Reads one workspace root's backlog for the mobile snapshot: the object store
// (items.json) merged with a scan of backlog/*.md so unregistered captures are
// visible from the phone before the desktop Backlog panel ever opened them.
// Returns null when the workspace has no backlog folder and no store records —
// a calm absence, not an error.
export async function readMobileBacklogWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
): Promise<MobileControlBacklogWorkspaceSnapshot | null> {
  const root = resolve(workspaceRoot)
  const { items, present } = await readActiveBacklogItems(root)
  if (!present) return null
  if (items.length === 0) return emptyBacklogWorkspaceSnapshot(root, generatedAt)

  return {
    workspaceId: `backlog:${root}`,
    workspacePath: root,
    workspaceName: basename(root) || root,
    updatedAt: latestTimestamp(items) ?? generatedAt,
    items: items.slice(0, maxBacklogItemsPerWorkspace),
  }
}

// childrenOfEpic for non-panel consumers (Sprint Engine / mobile): the derived
// epic -> children query over the same read path, so callers enumerate an epic's
// members without re-parsing the backlog folder themselves. Membership is read
// from each child's frontmatter `epic:` slug (never a stored children list), and
// the result is the active (non-archived) children, ordered like the snapshot.
export async function readBacklogEpicChildren(
  workspaceRoot: string,
  slug: string,
): Promise<MobileControlBacklogItemSnapshot[]> {
  const { items } = await readActiveBacklogItems(resolve(workspaceRoot))
  return items.filter((item) => item.epic === slug)
}

// Shared read pass for the snapshot and childrenOfEpic: merges scanned backlog
// markdown with the items.json records, then builds active, frontmatter-sourced
// item snapshots. `present` is false only when the workspace has neither a
// backlog folder nor any sidecar record (a calm absence, not an error).
async function readActiveBacklogItems(
  root: string,
): Promise<{ items: MobileControlBacklogItemSnapshot[]; present: boolean }> {
  const scannedPaths = await scanBacklogMarkdownPaths(root)
  const storeResult = await readBacklogObjectStore(root)
  let records: BacklogObjectRecordPayload[] = storeResult.ok ? storeResult.store.items : []

  const known = new Set(records.map((record) => record.source.relativePath.toLowerCase()))
  const unregistered = scannedPaths.filter((relativePath) => !known.has(relativePath.toLowerCase()))
  if (unregistered.length > 0) {
    const ensured = await ensureBacklogObjectRecords(
      root,
      unregistered.map((relativePath) => ({ relativePath })),
    )
    if (ensured.ok) {
      records = ensured.store.items
    }
  }

  const present = !(scannedPaths.length === 0 && records.length === 0)
  // Build every record into a frontmatter-sourced snapshot first, then drop
  // archived ones by their *frontmatter* status (the sidecar status is stale
  // after the v2 migration) and by the archived/ path convention.
  const snapshots = await Promise.all(records.map((record) => toBacklogItemSnapshot(root, record)))
  const items = snapshots
    .filter((item) => item.status !== 'archived' && !item.relativePath.toLowerCase().startsWith(ARCHIVED_PREFIX))
    .sort(compareBacklogItems)
  return { items, present }
}

// Resolves a backlog item into the product prompt used for a Sprint Engine
// handover start: the markdown body with frontmatter stripped, capped at the
// command service's product-prompt budget.
export async function resolveBacklogStartPrompt(
  workspaceRoot: string,
  relativePath: string,
): Promise<{ title: string; prompt: string }> {
  const normalized = assertBacklogRelativePath(relativePath)
  const root = resolve(workspaceRoot)
  let raw: string
  try {
    raw = await readFile(join(root, normalized), 'utf-8')
  } catch {
    throw new MobileSprintEngineCommandError(
      'invalid_payload',
      `Backlog item ${normalized} could not be read on the desktop.`,
      false,
    )
  }

  const body = stripFrontmatter(raw).trim()
  if (!body) {
    throw new MobileSprintEngineCommandError(
      'invalid_payload',
      `Backlog item ${normalized} is empty; add content before starting a sprint from it.`,
      false,
    )
  }

  return {
    title: extractTitle(body, normalized),
    prompt: body.slice(0, maxStartPromptCharacters),
  }
}

export function assertBacklogRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  const unsafe =
    isAbsolute(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  if (unsafe || !normalized.startsWith(`${BACKLOG_FOLDER}/`) || !normalized.endsWith('.md')) {
    throw new MobileSprintEngineCommandError(
      'path_not_allowed',
      'Backlog item paths must be relative markdown paths under backlog/.',
      false,
    )
  }
  return normalized
}

async function scanBacklogMarkdownPaths(root: string): Promise<string[]> {
  const backlogRoot = join(root, BACKLOG_FOLDER)
  let entries
  try {
    entries = await readdir(backlogRoot, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => `${BACKLOG_FOLDER}/${entry.name}`)
}

async function toBacklogItemSnapshot(
  root: string,
  record: BacklogObjectRecordPayload,
): Promise<MobileControlBacklogItemSnapshot> {
  let raw: string | null = null
  try {
    raw = await readFile(join(root, record.source.relativePath), 'utf-8')
  } catch {
    raw = null
  }
  const body = raw !== null ? stripFrontmatter(raw) : null
  // Frontmatter is the v2 source of truth for lifecycle/triage/epic; fall back to
  // the sidecar record only for items not yet migrated to frontmatter.
  const fields: BacklogFrontmatterFields = raw !== null ? readBacklogFrontmatterFields(raw) : {}
  const status = fields.status ?? record.status ?? 'idea'
  const type = fields.type ?? record.type
  const difficulty = fields.difficulty ?? record.difficulty
  const criticality = fields.criticality ?? record.criticality

  return {
    itemId: record.id,
    relativePath: record.source.relativePath,
    title: body ? extractTitle(body, record.source.relativePath) : titleFromPath(record.source.relativePath),
    ...(body ? { excerpt: extractExcerpt(body) } : {}),
    status,
    ...(type ? { type } : {}),
    ...(difficulty ? { difficulty } : {}),
    ...(criticality ? { criticality } : {}),
    ...(fields.epic ? { epic: fields.epic } : {}),
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  }
}

function emptyBacklogWorkspaceSnapshot(root: string, generatedAt: string): MobileControlBacklogWorkspaceSnapshot {
  return {
    workspaceId: `backlog:${root}`,
    workspacePath: root,
    workspaceName: basename(root) || root,
    updatedAt: generatedAt,
    items: [],
  }
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) {
    return raw
  }
  const end = raw.indexOf('\n---', 3)
  return end === -1 ? raw : raw.slice(raw.indexOf('\n', end + 1) + 1)
}

function extractTitle(body: string, relativePath: string): string {
  for (const line of body.split(/\r?\n/)) {
    const heading = line.match(/^#\s+(.+)$/)
    if (heading) {
      return heading[1].trim()
    }
  }
  return titleFromPath(relativePath)
}

function titleFromPath(relativePath: string): string {
  const stem = basename(relativePath).replace(/\.md$/i, '')
  return stem.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/[-_]+/g, ' ').trim() || stem
}

function extractExcerpt(body: string): string {
  const lines = body.split(/\r?\n/)
  const collected: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      if (collected.length > 0) break
      continue
    }
    collected.push(trimmed)
    if (collected.join(' ').length >= maxExcerptCharacters) break
  }
  const excerpt = collected.join(' ')
  return excerpt.length > maxExcerptCharacters ? `${excerpt.slice(0, maxExcerptCharacters - 1)}…` : excerpt
}

const statusOrder: Record<MobileControlBacklogItemSnapshot['status'], number> = {
  needs_input: 0,
  in_progress: 1,
  ready: 2,
  idea: 3,
  completed: 4,
  archived: 5,
}

function compareBacklogItems(
  left: MobileControlBacklogItemSnapshot,
  right: MobileControlBacklogItemSnapshot,
): number {
  const statusDelta = statusOrder[left.status] - statusOrder[right.status]
  if (statusDelta !== 0) return statusDelta
  const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0
  const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0
  if (leftTime !== rightTime) return rightTime - leftTime
  return left.relativePath.localeCompare(right.relativePath)
}

function latestTimestamp(items: MobileControlBacklogItemSnapshot[]): string | null {
  let latest: string | null = null
  for (const item of items) {
    if (item.updatedAt && (!latest || item.updatedAt > latest)) {
      latest = item.updatedAt
    }
  }
  return latest
}
