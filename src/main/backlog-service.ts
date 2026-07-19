import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  extractBacklogTitle,
  formatBacklogCsvList,
  isValidBacklogSlug,
  parseBacklogCsvList,
  parseBacklogFrontmatter,
  serializeBacklogFrontmatterFields,
  stripBacklogFrontmatter,
  type BacklogFrontmatterUpdates,
} from '../shared/backlog/frontmatter'
import {
  deriveDefaultBacklogKey,
  formatBacklogNumericId,
  isValidBacklogKey,
  parseBacklogNumericId,
  planBacklogIdAllocation,
} from '../shared/backlog/item-id'
import { isRoadmapContent } from '../shared/backlog/roadmap'
import type {
  BacklogAddOrUpdateLinkInput,
  BacklogCreateEpicInput,
  BacklogCreateEpicResult,
  BacklogEnsureIdsInput,
  BacklogEnsureIdsResult,
  BacklogEpicColorInput,
  BacklogDependenciesInput,
  BacklogEpicInput,
  BacklogHighlightColorPayload,
  BacklogHighlightInput,
  BacklogItemLinkPayload,
  BacklogItemRecordInput,
  BacklogMockupsInput,
  BacklogModuleMetadataInput,
  BacklogMutationResult,
  BacklogObjectRecordPayload,
  BacklogObjectStorePayload,
  BacklogReadResult,
  BacklogRemoveLinkInput,
  BacklogRemoveRecordInput,
  BacklogStatusInput,
  BacklogTriageInput,
  BacklogTypeInput,
  BacklogMoveSourceInput,
  BacklogWorkspaceKeyResult,
} from '../shared/electron-api'

const STORE_PATH = ['.multi-code', 'backlog', 'items.json'] as const
// Per-workspace, committed config holding the display key (`MC`) so `KEY-n` ids
// render identically on every machine. Separate from items.json, whose store
// shape is normalized down to `{schemaVersion, items}` and would drop a key.
const CONFIG_PATH = ['.multi-code', 'backlog', 'config.json'] as const
const BACKLOG_PREFIX = 'backlog/'
const EPICS_PREFIX = 'backlog/epics/'
const ROADMAPS_PREFIX = 'backlog/roadmaps/'

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
    // The read path is where the lazy v1 -> v2 migration runs: a not-yet-migrated
    // workspace is migrated on first read and tolerated indefinitely until then.
    const store = await loadMigratedStore(workspace)
    return { ok: true, store }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Resolve the workspace display key: the committed config value when valid, else
// a default derived from the workspace folder name and persisted so it stays
// stable. A malformed config is non-fatal — we derive a fresh default.
async function resolveBacklogWorkspaceKey(workspace: ValidWorkspace): Promise<string> {
  const configPath = join(workspace.root, ...CONFIG_PATH)
  try {
    const raw = await readFile(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as { key?: unknown }
    if (isValidBacklogKey(parsed.key)) return parsed.key
  } catch (error) {
    if (!isMissingFileError(error)) {
      // Unreadable/unparseable config: fall through and re-derive a default.
    }
  }
  const key = deriveDefaultBacklogKey(basename(workspace.root))
  await persistBacklogWorkspaceKey(workspace, key)
  return key
}

async function persistBacklogWorkspaceKey(workspace: ValidWorkspace, key: string): Promise<void> {
  const target = resolve(join(workspace.root, ...CONFIG_PATH))
  if (!isPathInside(workspace.root, target)) return
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify({ schemaVersion: 1, key }, null, 2)}\n`, 'utf-8')
  } catch {
    // Best effort: a failed write just means we re-derive the same default next time.
  }
}

// Read the workspace display key for the panel to render `KEY-n`. Initializes
// (and persists) the derived default on first call when no config exists.
export async function readBacklogWorkspaceKey(workspaceRoot: string): Promise<BacklogWorkspaceKeyResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const key = await resolveBacklogWorkspaceKey(workspace)
    return { ok: true, key }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

// Scan-time id allocation + backfill. The single allocation authority: given
// every scanned item with its current frontmatter id (or null), mint the next
// sequential id (scan-max + 1, oldest-first by the sidecar createdAt) for those
// lacking one and write it into the item's frontmatter. Idempotent — once every
// item has an id this writes nothing, mirroring the v1→v2 lazy migration. New
// items (from any surface) self-heal an id here on the next scan, so creation
// paths never need to allocate.
export async function ensureBacklogItemIds(input: BacklogEnsureIdsInput): Promise<BacklogEnsureIdsResult> {
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const key = await resolveBacklogWorkspaceKey(workspace)
    const store = await loadStore(workspace)
    const createdByPath = new Map<string, string | undefined>()
    for (const record of store.items) {
      createdByPath.set(record.source.relativePath.toLowerCase(), record.createdAt)
    }

    const allocationItems: Array<{ relativePath: string; numericId?: number | null; createdAt?: string }> = []
    for (const raw of input.items ?? []) {
      let relativePath: string
      try {
        relativePath = validateBacklogRelativePath(raw.relativePath)
      } catch {
        // A path that escapes backlog/ is ignored, never written to.
        continue
      }
      allocationItems.push({
        relativePath,
        numericId: typeof raw.numericId === 'number' ? raw.numericId : null,
        createdAt: createdByPath.get(relativePath.toLowerCase()),
      })
    }

    const assignments = planBacklogIdAllocation(allocationItems)
    for (const [relativePath, numericId] of Object.entries(assignments)) {
      const target = resolve(join(workspace.root, relativePath))
      if (!isPathInside(workspace.root, target)) continue
      let content: string
      try {
        content = await readFile(target, 'utf-8')
      } catch {
        // A file that vanished between scan and write is skipped; the next scan
        // re-evaluates it.
        continue
      }
      const next = serializeBacklogFrontmatterFields(content, { id: formatBacklogNumericId(numericId) })
      if (next !== content) await writeFile(target, next, 'utf-8')
    }

    return { ok: true, key, assignments }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

const MIGRATABLE_FRONTMATTER_FIELDS = ['status', 'type', 'difficulty', 'criticality', 'risk'] as const

export type BacklogRecordFrontmatterMigration = {
  relativePath: string
  updates: Record<string, string>
}

export type BacklogStoreMigrationPlan = {
  // Per-record frontmatter writes to apply (only records that still carry fields).
  migrations: BacklogRecordFrontmatterMigration[]
  // Every record with the migratable fields stripped (orphan GC happens in the
  // service, which has fs to check for the file).
  slimRecords: Record<string, unknown>[]
  // True when any record carried a migratable field — i.e. a rewrite is needed.
  changed: boolean
}

// Pure planner for the lazy v1 -> v2 migration. Given a parsed items.json, work
// out which records still carry lightweight fields (status/type/difficulty/
// criticality/risk) to push into the item's frontmatter — sidecar value WINS on
// conflict (matching the old precedence), and unknown string values are migrated
// intact rather than dropped (OKF drift tolerance) — and the records with those
// fields stripped. No fs: the service applies the writes and prunes orphans.
export function planBacklogStoreMigration(parsed: unknown): BacklogStoreMigrationPlan {
  const items = isPlainRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : []
  const migrations: BacklogRecordFrontmatterMigration[] = []
  const slimRecords: Record<string, unknown>[] = []
  let changed = false
  for (const raw of items) {
    if (!isPlainRecord(raw)) continue
    const slim: Record<string, unknown> = { ...raw }
    const updates: Record<string, string> = {}
    for (const field of MIGRATABLE_FRONTMATTER_FIELDS) {
      if (!(field in slim)) continue
      const value = slim[field]
      delete slim[field]
      changed = true
      // Only string values can live in flat frontmatter; non-strings are malformed
      // sidecar data and are simply dropped. Unknown strings (e.g. a custom type)
      // are preserved so the read model can surface them. items.json scalars are
      // untrusted v1 sidecar data, so sanitize before the writer sees them (sec F1,
      // defense in depth with formatScalar) and drop ones that sanitize to empty.
      if (typeof value === 'string') {
        const sanitized = sanitizeMigratedScalar(value)
        if (sanitized) updates[field] = sanitized
      }
    }
    slimRecords.push(slim)
    const relativePath = recordRelativePath(raw)
    if (relativePath && Object.keys(updates).length > 0) migrations.push({ relativePath, updates })
  }
  return { migrations, slimRecords, changed }
}

// Collapse embedded CR/LF in a migration-sourced scalar so a crafted multi-line
// items.json value cannot serialize into extra frontmatter lines, then trim.
function sanitizeMigratedScalar(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function recordRelativePath(raw: unknown): string | null {
  if (!isPlainRecord(raw)) return null
  const source = raw.source
  if (!isPlainRecord(source) || typeof source.relativePath !== 'string') return null
  return normalizeRelativePath(source.relativePath)
}

// Read items.json, run the lazy migration when it still carries v1 fields, and
// return the (slimmed) store. When nothing needs migrating this is a plain load,
// so steady-state reads incur no extra fs writes (idempotent).
async function loadMigratedStore(workspace: ValidWorkspace): Promise<BacklogObjectStore> {
  let rawText: string
  try {
    rawText = await readFile(workspace.storePath, 'utf-8')
  } catch (error) {
    if (isMissingFileError(error)) return EMPTY_STORE
    throw new Error(`Could not read Backlog metadata: ${errorMessage(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch (error) {
    throw new Error(`Could not parse Backlog metadata: ${errorMessage(error)}`)
  }

  const plan = planBacklogStoreMigration(parsed)
  if (!plan.changed) return normalizeStore(parsed)

  // Push each record's lightweight fields into its item frontmatter (sidecar
  // wins, body byte-preserved). A record whose file is gone is skipped here and
  // pruned by the orphan GC below.
  for (const migration of plan.migrations) {
    const target = resolve(join(workspace.root, migration.relativePath))
    if (!isPathInside(workspace.root, target)) continue
    let content: string
    try {
      content = await readFile(target, 'utf-8')
    } catch {
      continue
    }
    const next = serializeBacklogFrontmatterFields(content, migration.updates)
    if (next !== content) await writeFile(target, next, 'utf-8')
  }

  // Orphan GC: drop records whose source file no longer exists on disk.
  const survivors: unknown[] = []
  for (const record of plan.slimRecords) {
    const relativePath = recordRelativePath(record)
    if (relativePath && (await backlogFileExists(workspace, relativePath))) survivors.push(record)
  }
  const migrated = normalizeStore({ schemaVersion: 1, items: survivors })
  await saveStore(workspace, migrated)
  return migrated
}

// Frontmatter-sourced lifecycle/triage/epic for an item's markdown content. This
// is the v2 read shape non-panel readers (the mobile bridge, Sprint Engine) use
// so they see the same source of truth the renderer does, instead of the now-stale
// sidecar fields. Unknown/invalid values are dropped; callers fall back to a
// sidecar record only for not-yet-migrated items (mixed-version tolerance).
export type BacklogFrontmatterFields = {
  status?: BacklogObjectRecord['status']
  type?: BacklogObjectRecord['type']
  difficulty?: BacklogObjectRecord['difficulty']
  criticality?: BacklogObjectRecord['criticality']
  risk?: BacklogObjectRecord['risk']
  epic?: string
  // Prerequisite slugs from the `dependsOn:` CSV line, valid-slug filtered.
  // Exposed for the roadmap orchestrator's eligibility (MC-1619), which needs
  // the dependency axis the panel read model derives in the renderer; empty when
  // the line is absent.
  dependsOn?: string[]
}

export function readBacklogFrontmatterFields(content: string): BacklogFrontmatterFields {
  const { fields } = parseBacklogFrontmatter(content)
  const dependsOn = parseBacklogCsvList(fields.dependsOn).filter(isValidBacklogSlug)
  return {
    status: isBacklogStatus(fields.status) ? fields.status : undefined,
    type: isBacklogType(fields.type) ? fields.type : undefined,
    difficulty: isBacklogDifficulty(fields.difficulty) ? fields.difficulty : undefined,
    criticality: isBacklogCriticality(fields.criticality) ? fields.criticality : undefined,
    risk: isBacklogRisk(fields.risk) ? fields.risk : undefined,
    epic: isValidEpicSlug(fields.epic) ? fields.epic : undefined,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  }
}

// Read-only listing for non-panel consumers (the automation server's
// `backlog.list`): files on disk are the item universe, frontmatter the only
// metadata source. Unlike the mobile snapshot read this NEVER writes — no
// object-store registration, no workspace-key persistence — because an
// external read tool must not mutate app state as a side effect.
export type BacklogListedItem = {
  relativePath: string
  title: string
  /** Frontmatter numeric id when assigned (display id = `<key>-<id>`). */
  id?: number
  isEpic: boolean
  // True for a `backlog/roadmaps/<name>.md` ordered-execution plan (MC-1618).
  // Surfaced as a flag rather than through the closed `type` union, which stays
  // OKF-tolerant of the roadmap type (src/shared/backlog/roadmap.ts).
  isRoadmap?: boolean
  status: BacklogObjectRecord['status']
  type?: BacklogObjectRecord['type']
  difficulty?: BacklogObjectRecord['difficulty']
  criticality?: BacklogObjectRecord['criticality']
  risk?: BacklogObjectRecord['risk']
  epic?: string
  // Prerequisite slugs (`dependsOn:`), for the roadmap orchestrator's
  // eligibility (MC-1619). Present only when the item declares dependencies.
  dependsOn?: string[]
}

export type BacklogListItemsResult =
  | { ok: true; key: string | null; items: BacklogListedItem[] }
  | { ok: false; message: string }

export async function listBacklogItems(workspaceRoot: string): Promise<BacklogListItemsResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const paths = [
      ...(await listMarkdownFiles(join(workspace.root, 'backlog'), BACKLOG_PREFIX)),
      ...(await listMarkdownFiles(join(workspace.root, 'backlog', 'epics'), EPICS_PREFIX)),
      ...(await listMarkdownFiles(join(workspace.root, 'backlog', 'roadmaps'), ROADMAPS_PREFIX)),
    ]
    const items: BacklogListedItem[] = []
    for (const relativePath of paths) {
      let raw: string
      try {
        raw = await readFile(join(workspace.root, relativePath), 'utf-8')
      } catch {
        continue
      }
      const fields = readBacklogFrontmatterFields(raw)
      const status = fields.status ?? 'idea'
      if (status === 'archived') continue
      const { fields: rawFields } = parseBacklogFrontmatter(raw)
      const numericId = parseBacklogNumericId(rawFields.id)
      const body = stripBacklogFrontmatter(raw)
      items.push({
        relativePath,
        title: extractBacklogTitle(body, relativePath),
        ...(numericId !== undefined ? { id: numericId } : {}),
        isEpic: relativePath.startsWith(EPICS_PREFIX) || fields.type === 'epic',
        ...(isRoadmapContent(relativePath, rawFields.type) ? { isRoadmap: true } : {}),
        status,
        ...(fields.type ? { type: fields.type } : {}),
        ...(fields.difficulty ? { difficulty: fields.difficulty } : {}),
        ...(fields.criticality ? { criticality: fields.criticality } : {}),
        ...(fields.risk ? { risk: fields.risk } : {}),
        ...(fields.epic ? { epic: fields.epic } : {}),
        ...(fields.dependsOn ? { dependsOn: fields.dependsOn } : {}),
      })
    }
    items.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    return { ok: true, key: await peekBacklogWorkspaceKey(workspace), items }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

export type BacklogReadItemResult =
  | { ok: true; item: BacklogListedItem; body: string }
  | { ok: false; message: string }

export async function readBacklogItem(workspaceRoot: string, relativePath: string): Promise<BacklogReadItemResult> {
  try {
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const normalized = validateBacklogRelativePath(relativePath)
    const target = resolve(join(workspace.root, normalized))
    if (!isPathInside(workspace.root, target)) throw new Error('Backlog item path escaped the workspace root.')
    let raw: string
    try {
      raw = await readFile(target, 'utf-8')
    } catch {
      return { ok: false, message: `Backlog item ${normalized} does not exist in this workspace.` }
    }
    const fields = readBacklogFrontmatterFields(raw)
    const { fields: rawFields } = parseBacklogFrontmatter(raw)
    const numericId = parseBacklogNumericId(rawFields.id)
    const body = stripBacklogFrontmatter(raw)
    return {
      ok: true,
      item: {
        relativePath: normalized,
        title: extractBacklogTitle(body, normalized),
        ...(numericId !== undefined ? { id: numericId } : {}),
        isEpic: normalized.startsWith(EPICS_PREFIX) || fields.type === 'epic',
        ...(isRoadmapContent(normalized, rawFields.type) ? { isRoadmap: true } : {}),
        status: fields.status ?? 'idea',
        ...(fields.type ? { type: fields.type } : {}),
        ...(fields.difficulty ? { difficulty: fields.difficulty } : {}),
        ...(fields.criticality ? { criticality: fields.criticality } : {}),
        ...(fields.risk ? { risk: fields.risk } : {}),
        ...(fields.epic ? { epic: fields.epic } : {}),
      },
      body,
    }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
}

async function listMarkdownFiles(dir: string, prefix: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => `${prefix}${entry.name}`)
}

// The workspace key without the persist-on-first-read behavior of
// readBacklogWorkspaceKey — a pure peek for read-only surfaces.
async function peekBacklogWorkspaceKey(workspace: ValidWorkspace): Promise<string | null> {
  try {
    const raw = await readFile(join(workspace.root, ...CONFIG_PATH), 'utf-8')
    const parsed = JSON.parse(raw) as { key?: unknown }
    return isValidBacklogKey(parsed.key) ? parsed.key : null
  } catch {
    return null
  }
}

export type BacklogCreateInput = {
  workspaceRoot: string
  title: string
  description?: string
  type?: string
  difficulty?: string
  criticality?: string
  risk?: string
  epic?: string
}

export type BacklogCreateResult =
  | { ok: true; id: string; relativePath: string; store: BacklogObjectStorePayload }
  | { ok: false; message: string }

// Creates a brand-new Backlog item (mobile bridge + automation server):
// writes the real `.md` file AND upserts the items.json record. Filename
// mirrors the desktop renderer's `${today}-${slug(title)}.md` convention and
// dedups against the current store. v2-native: lifecycle/triage go into the
// new file's frontmatter (the source of truth) and the sidecar record stays
// minimal — seeding lifecycle there would hand the lazy migrator stale
// defaults to write back later. Invalid axis values are dropped, matching the
// tolerant mobile intake; strict vocabularies belong to the callers.
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

    const frontmatter: Array<[key: string, value: string | undefined]> = [
      ['type', isBacklogType(input.type) ? input.type : undefined],
      ['status', 'idea'],
      ['difficulty', isBacklogDifficulty(input.difficulty) ? input.difficulty : undefined],
      ['criticality', isBacklogCriticality(input.criticality) ? input.criticality : undefined],
      ['risk', isBacklogRisk(input.risk) ? input.risk : undefined],
      ['epic', isValidEpicSlug(input.epic) ? input.epic : undefined],
    ]
    const frontmatterBlock = `---\n${frontmatter
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n')}\n---\n`
    const description = input.description?.trim()
    const body = description ? `# ${title}\n\n${description}\n` : `# ${title}\n`
    await mkdir(dirname(target), { recursive: true })
    // `wx` fails instead of clobbering if a file appears between the uniqueness
    // check and the write.
    await writeFile(target, `${frontmatterBlock}\n${body}`, { encoding: 'utf-8', flag: 'wx' })

    const now = new Date().toISOString()
    const record: BacklogObjectRecord = {
      id: stableBacklogObjectId(relativePath),
      source: { type: 'file', relativePath },
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

// Creates a new epic concept file `backlog/epics/<slug>.md` (`type: epic` + the
// title heading). Epics are surfaced from the filesystem, so this writes only the
// markdown file — never an items.json membership record. The slug is the title
// slug, made collision-safe against existing files the same way item creation is.
export async function createBacklogEpic(input: BacklogCreateEpicInput): Promise<BacklogCreateEpicResult> {
  const title = input.title.trim()
  if (!title) return { ok: false, message: 'Enter a title for the new epic.' }
  try {
    const workspace = await validateWorkspaceRoot(input.workspaceRoot)
    const store = await loadStore(workspace)
    const existingLower = new Set(store.items.map((record) => record.source.relativePath.toLowerCase()))
    const relativePath = await uniqueEpicFilePath(workspace, slugifyBacklogTitle(title), existingLower)
    const target = resolve(join(workspace.root, relativePath))
    if (!isPathInside(workspace.root, target)) throw new Error('Backlog item path escaped the workspace root.')

    const content = `---\ntype: epic\n---\n# ${title}\n`
    await mkdir(dirname(target), { recursive: true })
    // `wx` fails instead of clobbering if a file appears between the uniqueness
    // check and the write.
    await writeFile(target, content, { encoding: 'utf-8', flag: 'wx' })

    const slug = relativePath.slice(EPICS_PREFIX.length).replace(/\.md$/i, '')
    return { ok: true, slug, relativePath }
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
      // v2: the sidecar record carries only app-owned churn (id/source, metadata,
      // links, highlight, timestamps). Lifecycle/triage live in frontmatter, so a
      // freshly registered record seeds none of them — otherwise the lazy migrator
      // would later write those seeded defaults back into the item's frontmatter.
      nextItems.push({
        id: stableBacklogObjectId(relativePath),
        source: { type: 'file', relativePath },
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
  const written = await writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { status: input.status })
  if (!written.ok) return written

  // v2 lifecycle belongs only in frontmatter. A link-sync write from an older
  // build may have left a sidecar status behind; clear it in the same mutation
  // so a later lazy migration cannot overwrite the user's explicit choice.
  return clearBacklogSidecarStatus(input.workspaceRoot, input.relativePath)
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

// Epic membership is the child-side write: set the child's `epic:` frontmatter
// slug, or null to remove it from its epic. The down-direction (epic -> children)
// stays a derived query (see backlogEpics.ts), never stored, so there is nothing
// to keep in sync. Like the other lifecycle writers this targets the markdown
// frontmatter, never items.json.
export async function updateBacklogEpic(input: BacklogEpicInput): Promise<BacklogMutationResult> {
  if (input.epic !== null && !isValidEpicSlug(input.epic)) {
    return { ok: false, message: 'Enter a valid epic slug.' }
  }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { epic: input.epic })
}

// Epic identity colour: write (or clear) the epic file's `color:` frontmatter so
// its members can derive a shared hue at scan time. Like the other frontmatter
// writers this never touches items.json; the value is validated against the
// seven-colour highlight vocabulary so a bad payload can't land an unknown hue.
export async function updateBacklogEpicColor(input: BacklogEpicColorInput): Promise<BacklogMutationResult> {
  if (input.color !== null && !isBacklogHighlightColor(input.color)) {
    return { ok: false, message: 'Enter a valid epic colour.' }
  }
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { color: input.color })
}

// Prerequisites are the dependent-side write: serialize the item's prerequisite
// slugs to the single comma-separated `dependsOn:` frontmatter line via the
// shared CSV formatter. Each slug is validated with the shared slug check (so the
// write path and the read model agree on what a slug may contain) and the whole
// write is rejected on the first invalid one — nothing is written. Surrounding
// whitespace is trimmed and duplicates dropped, keeping first-seen order, so the
// stored line matches what the reader parses back. An empty list or null clears
// the line (passed as null, since the serializer treats an empty string as a set,
// not a clear). The reverse "blocks" edges and the waiting signal stay derived
// (backlogDependencies.ts), never stored, and this targets markdown frontmatter
// only, never items.json.
export async function updateBacklogDependencies(input: BacklogDependenciesInput): Promise<BacklogMutationResult> {
  if (input.dependsOn !== null && !Array.isArray(input.dependsOn)) {
    return { ok: false, message: 'Enter a valid Backlog prerequisite list.' }
  }
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of input.dependsOn ?? []) {
    const slug = typeof raw === 'string' ? raw.trim() : ''
    if (!isValidBacklogSlug(slug)) {
      return { ok: false, message: 'Enter valid Backlog prerequisite slugs.' }
    }
    if (seen.has(slug)) continue
    seen.add(slug)
    cleaned.push(slug)
  }
  const dependsOn = cleaned.length > 0 ? formatBacklogCsvList(cleaned) : null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { dependsOn })
}

// Mockup attachments are the item-side write: serialize the item's mockup paths
// to the single comma-separated `mockups:` frontmatter line via the shared CSV
// formatter, mirroring updateBacklogDependencies. Each path is validated (a
// non-empty, workspace-relative path with no `..` escape and — the CSV
// contract — no comma) and the whole write is rejected on the first invalid one,
// so a bad payload never lands a half-written line. Surrounding whitespace is
// trimmed, backslashes normalized to `/`, and duplicates dropped keeping
// first-seen order, so the stored line matches what parseBacklogMockups reads
// back. An empty list or null clears the line (passed as null, since the
// serializer treats an empty string as a set, not a clear). Body-prose
// references stay derived (backlogMockups.ts), never written here, and this
// targets markdown frontmatter only, never items.json.
export async function updateBacklogMockups(input: BacklogMockupsInput): Promise<BacklogMutationResult> {
  if (input.mockups !== null && !Array.isArray(input.mockups)) {
    return { ok: false, message: 'Enter a valid Backlog mockup list.' }
  }
  const cleaned: string[] = []
  const seen = new Set<string>()
  for (const raw of input.mockups ?? []) {
    const path = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : ''
    // A stored attachment must be a real, workspace-relative path: non-empty, not
    // absolute (POSIX `/` or Windows drive), no `..` escape, and comma-free (the
    // single-line CSV contract can't survive an embedded comma).
    const invalid =
      !path ||
      path.includes(',') ||
      path.startsWith('/') ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.split('/').includes('..')
    if (invalid) {
      return { ok: false, message: 'Enter valid Backlog mockup paths (workspace-relative, no “..”).' }
    }
    if (seen.has(path)) continue
    seen.add(path)
    cleaned.push(path)
  }
  const mockups = cleaned.length > 0 ? formatBacklogCsvList(cleaned) : null
  return writeBacklogFrontmatter(input.workspaceRoot, input.relativePath, { mockups })
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
  const linked = await mutateItem(input.workspaceRoot, input.relativePath, (record, now) => {
    const nextLink = { ...link, updatedAt: link.updatedAt ?? now }
    return {
      ...record,
      links: [...(record.links ?? []).filter((candidate) => candidate.id !== nextLink.id), nextLink],
      updatedAt: now,
    }
  })
  if (!linked.ok || input.status === undefined) return linked

  // Link lifecycle may advance the item, but the lifecycle source of truth is
  // still the Markdown frontmatter. Never reintroduce status into items.json.
  return updateBacklogStatus({
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
    status: input.status,
  })
}

export async function removeBacklogLink(input: BacklogRemoveLinkInput): Promise<BacklogMutationResult> {
  const linkId = input.linkId.trim()
  if (!linkId) return { ok: false, message: 'Choose a Backlog link to remove.' }
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    links: (record.links ?? []).filter((candidate) => candidate.id !== linkId),
    updatedAt: now,
  }))
}

async function clearBacklogSidecarStatus(
  workspaceRoot: string,
  relativePath: string,
): Promise<BacklogMutationResult> {
  try {
    validateBacklogRelativePath(relativePath)
    const workspace = await validateWorkspaceRoot(workspaceRoot)
    const store = await loadStore(workspace)
    const pathKey = normalizeRelativePath(relativePath).toLowerCase()
    let changed = false
    const items = store.items.map((record) => {
      if (record.source.relativePath.toLowerCase() !== pathKey || record.status === undefined) return record
      const { status: _status, ...next } = record
      changed = true
      return next
    })
    if (!changed) return { ok: true, store }
    const nextStore = normalizeStore({ schemaVersion: 1, items })
    await saveStore(workspace, nextStore)
    return { ok: true, store: nextStore }
  } catch (error) {
    return { ok: false, message: errorMessage(error) }
  }
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
  // v2: archived-ness is path-derived by the reader (isArchivedBacklogPath in
  // src/renderer/src/utils/backlog.ts), so the move only rewrites the sidecar
  // source path. Writing status:'archived' here would orphan a lifecycle field
  // the reader never consults, and — since status is migratable under sidecar-
  // wins precedence — a later loadMigratedStore pass would push it back into the
  // archived file's frontmatter, clobbering its true pre-archive status. Mirror
  // the mutateItem pattern that deliberately never seeds lifecycle into items.json.
  return mutateItem(input.workspaceRoot, input.relativePath, (record, now) => ({
    ...record,
    source: { type: 'file', relativePath: nextRelativePath },
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
      // v2: a record materialized by a highlight/link/metadata mutation carries
      // only app-owned churn. Seeding a default `status` here would let the lazy
      // migrator later overwrite the item's real frontmatter status with 'idea'.
      : {
          id: stableBacklogObjectId(normalizedPath),
          source: { type: 'file', relativePath: normalizedPath },
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

async function uniqueEpicFilePath(
  workspace: ValidWorkspace,
  slug: string,
  existingLower: Set<string>,
): Promise<string> {
  let candidate = `${EPICS_PREFIX}${slug}.md`
  let index = 2
  while (existingLower.has(candidate.toLowerCase()) || (await backlogFileExists(workspace, candidate))) {
    candidate = `${EPICS_PREFIX}${slug}-${index}.md`
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

// An epic slug is a single filename-stem token (it must match an epic file's
// stem at read time), so reject whitespace, separators, and other characters
// that could never name `backlog/epics/<slug>.md`.
function isValidEpicSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) && value !== '.' && value !== '..'
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
