import type { BacklogHighlightColorPayload, FileSystemStat } from '../electron-api'
import {
  parseBacklogCsvList,
  parseBacklogDependenciesPlanned,
  parseBacklogFrontmatter,
} from './frontmatter'
import { deriveDefaultBacklogKey, isValidBacklogKey, parseBacklogNumericId } from './item-id'
// Canonical object-store id, re-exported so existing importers of this module
// keep working. See src/shared/backlog/object-id.ts for the FNV-1a contract.
import { stableBacklogObjectId } from './object-id'
import { isAbsoluteFilePath } from '../paths'
import {
  backlogHighlightFromFrontmatter,
  durableBacklogLinksFromFrontmatter,
  mergeBacklogLinks,
} from './durable-links'
import { parseBacklogMockups } from './mockups'
import type { HighlightColor, SprintEngineSourcePlanKind } from '../../renderer/src/types/workspace'
import {
  inferSourcePlanKind,
  joinPath,
  markdownTitle,
  planBasename,
  shouldScanDirectory,
  toTitleName,
  workspaceRelativePath,
} from '../source-paths'
import { knownSidecarDirName, sidecarRelativePath } from '../workspace-sidecar'

export type BacklogItemKind = SprintEngineSourcePlanKind | 'html_mockup'
export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'

// Lightweight triage metadata, owned by the backlog object store (items.json),
// never required from markdown frontmatter. All fields are optional: a rough
// capture can stay untyped/unestimated until an architect sizes and prioritizes
// it, which is a calm neutral state, not a defect.
// `epic` is a grouping container (see docs/backlog-item-schema.md); every other
// type is a leaf. An unknown `type:` value is tolerated per OKF: it is preserved
// on the item as `rawType` and treated as a leaf, never coerced into this union.
export type BacklogType = 'epic' | 'feature' | 'bug' | 'mockup' | 'spike'
export type BacklogDifficulty = 'xs' | 's' | 'm' | 'l' | 'xl'
export type BacklogCriticality = 'low' | 'normal' | 'high' | 'critical'
// Likelihood the work goes sideways — a separate axis from effort (difficulty)
// and impact (criticality). Stored in frontmatter, parallel to criticality.
export type BacklogRisk = 'low' | 'normal' | 'high'

// Star/highlight metadata is owned exclusively by the object store: markdown
// frontmatter never seeds it. Mirrors the shared BacklogHighlightPayload and
// the workspace HighlightColor union, which stays assignable to it.
export type BacklogHighlightColor = 'red' | 'orange' | 'amber' | 'green' | 'blue' | 'purple' | 'pink'

// The 7-color highlight vocabulary is declared in three places that must stay
// identical: HighlightColor (src/renderer/src/types/workspace.ts),
// BacklogHighlightColorPayload (src/shared/electron-api.ts), and
// BacklogHighlightColor above. They cannot share one declaration because
// shared code must not import renderer types, and the two renderer unions
// mirror that shared payload independently. The asserts below are erased at
// compile time and fail typecheck if any union gains or loses a color
// relative to the others.
type MutuallyAssignable<A, B> = [A, B] extends [B, A] ? true : false
type StaticAssert<T extends true> = T
export type HighlightColorUnionsAligned = [
  StaticAssert<MutuallyAssignable<BacklogHighlightColor, HighlightColor>>,
  StaticAssert<MutuallyAssignable<BacklogHighlightColor, BacklogHighlightColorPayload>>,
  StaticAssert<MutuallyAssignable<HighlightColor, BacklogHighlightColorPayload>>,
]

export type BacklogHighlight = {
  starred: boolean
  color: BacklogHighlightColor | null
}

// `pending` is lifecycle-neutral in the same way `agent` links are: the work is
// recorded but has not started, so it never drives an item to `in_progress`.
export type BacklogItemLinkStatus = 'pending' | 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

export type BacklogItemLink = {
  id: string
  moduleId: string
  // `agent` is lifecycle-neutral: unlike `execution`, an active agent link
  // never drives item status (see nextBacklogItemStatusFromLinks). It records
  // which agent terminal is working the item, for two-way navigation.
  type: 'execution' | 'issue' | 'review' | 'artifact' | 'external' | 'agent'
  label: string
  target: {
    kind: string
    id: string
    path?: string
    url?: string
    // The one task inside the target that owns this item, when the target is a
    // run and the item is one of its epic children (MC-2017).
    taskId?: string
  }
  status?: BacklogItemLinkStatus
  // The item status to restore if this link's work is abandoned. Written when an
  // epic-child link is created and consumed when the run or its task is canceled.
  priorStatus?: BacklogItemStatus
  updatedAt?: string
}

export type BacklogResolvedLink = BacklogItemLink & {
  status: BacklogItemLinkStatus
  unavailableReason?: string
  canOpen?: boolean
}

// App-owned churn merged over a scanned item by hydrateBacklogScanResult. It
// carries only what the sidecar still owns: identity, module metadata, links,
// the star/highlight, and its own churn timestamp. Lifecycle/triage (status,
// type, difficulty, criticality) and epic now live in frontmatter and win on
// every scan, so they are deliberately absent here.
export type BacklogItemObjectMetadata = {
  objectId: string
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  highlight?: BacklogHighlight
  createdAt?: string
  updatedAt?: string
}

export type BacklogItem = {
  id: string
  objectId: string
  path: string
  relativePath: string
  title: string
  kind: BacklogItemKind
  status: BacklogItemStatus
  // Stable workspace-global identity from the frontmatter `id:` integer, allocated
  // once and never changed (across re-type/rename/re-triage). The human-facing
  // `<KEY>-<number>` display id is composed at render time from this plus the
  // workspace key (see src/shared/backlog/item-id.ts). Main-owned creation writes
  // it immediately; hand-authored/captured files receive it from the scan-time
  // backfill pass (ensureBacklogItemIds).
  numericId?: number
  // The human-facing identifier (`MC-240`), composed from numericId + the
  // workspace key by the scan-time allocation pass. Undefined when the item has
  // no numeric id yet, or on surfaces that scan without the key (e.g. the
  // new-workspace source picker). Display-only — never a stored field.
  displayId?: string
  type?: BacklogType
  // The literal frontmatter `type:` value, preserved even when it is not a known
  // BacklogType (OKF unknown-type tolerance). Equal to `type` for known values;
  // set without a matching `type` for unknown ones; undefined when no `type:`.
  rawType?: string
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  risk?: BacklogRisk
  // Up-pointing slug of the epic this item belongs to (frontmatter `epic:`), and
  // whether this item is itself an epic container (`type === 'epic'`).
  epic?: string
  isEpic: boolean
  // Prerequisite item slugs from the frontmatter `dependsOn:` comma-separated
  // scalar — trimmed, deduped, with this item's own slug dropped. `undefined`
  // when the field is absent or names nothing but self. Stored up on the
  // dependent; reverse "blocks" edges and the waiting signal are derived (T2),
  // never persisted to items.json (mirrors the epic axis).
  dependsOn?: string[]
  // The epic's `dependenciesPlanned:` mark (MC-2137): its author declaring the
  // ordering pass over its children finished — edges authored, or deliberately
  // none. Only meaningful on an epic row; absent means false, and nothing ever
  // derives or unsets it (see the shared parser for why it is an assertion, not
  // a computed property).
  dependenciesPlanned?: boolean
  // Attached mockup files from the frontmatter `mockups:` comma-separated scalar
  // — project-relative paths, cleaned (normalized slashes, absolute/`..` dropped)
  // by parseBacklogMockups. `undefined` when the field is absent or names nothing
  // valid. Authored intent that travels with the file (mirrors `dependsOn`);
  // body-prose references are derived separately (backlogMockups.ts), never
  // stored here.
  mockups?: string[]
  // Mockup references (attached `mockups:` or body-detected) that resolve to no
  // file on disk after the tolerant both-roots check (MC-1697). Attached by the
  // async scan-enrichment pass in useSharedBacklogScan — never by the pure,
  // filesystem-free createBacklogItem — and surfaced as a row warning (shown,
  // never dropped, mirroring the dangling-prerequisite discipline). `undefined`
  // when every reference resolves, the item names no mockup, or it was built
  // without the enrichment pass (e.g. the new-workspace source picker).
  danglingMockups?: string[]
  highlight?: BacklogHighlight
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  objectUpdatedAt?: string
  excerpt: string
  // Effective recency in epoch ms: frontmatter `updated` when it is a precise
  // ISO date-time, else the file mtime. Date-only legacy values cannot support
  // an hour-level relative label, so they deliberately fall back to mtime.
  modifiedAt: number
  // Effective creation time in epoch ms: the object store's `createdAt` (ISO,
  // stamped once when the app first registers the item) when present and
  // parseable, else the `YYYY-MM-DD` date prefix on the filename, else the file
  // mtime. Drives the recently-created sort. Distinct from `modifiedAt` so an
  // edited item keeps its original position in a created-date ordering.
  createdAtMs: number
  size: number
  sourceContent: string
}

export type BacklogScanError = {
  relativePath: string
  message: string
}

export type BacklogScanResult =
  | { state: 'missing-folder'; items: []; errors: [] }
  | { state: 'empty-folder'; items: []; errors: [] }
  | { state: 'ready'; items: BacklogItem[]; errors: [] }
  | { state: 'partial'; items: BacklogItem[]; errors: BacklogScanError[] }
  | { state: 'error'; items: BacklogItem[]; errors: BacklogScanError[] }

export type BacklogFilesystemAdapter = {
  pathExists(path: string): Promise<boolean>
  readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>>
  readfile(path: string): Promise<string>
  statPath(path: string): Promise<FileSystemStat>
}

const BACKLOG_FOLDER = 'backlog'
// Bounded fan-out for the per-file read+stat pass in scanBacklog. High enough to
// hide IPC round-trip latency across dozens of items, low enough not to flood the
// main process / filesystem with simultaneous reads on large backlogs.
const BACKLOG_SCAN_CONCURRENCY = 12
const ARCHIVED_PREFIX = 'backlog/archived/'
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const SOURCE_EXTENSION_RE = /\.(md|html?)$/i
const HTML_EXTENSION_RE = /\.html?$/i
const VALID_KIND = new Set<BacklogItemKind>(['product_plan', 'architect_plan', 'html_mockup', 'unknown'])
const VALID_STATUS = new Set<BacklogItemStatus>(['idea', 'ready', 'in_progress', 'needs_input', 'completed', 'archived'])
const VALID_TYPE = new Set<BacklogType>(['epic', 'feature', 'bug', 'mockup', 'spike'])
const VALID_DIFFICULTY = new Set<BacklogDifficulty>(['xs', 's', 'm', 'l', 'xl'])
const VALID_CRITICALITY = new Set<BacklogCriticality>(['low', 'normal', 'high', 'critical'])
const VALID_RISK = new Set<BacklogRisk>(['low', 'normal', 'high'])
const VALID_HIGHLIGHT_COLOR = new Set<BacklogHighlightColor>(['red', 'orange', 'amber', 'green', 'blue', 'purple', 'pink'])

export function isBacklogType(value: unknown): value is BacklogType {
  return typeof value === 'string' && VALID_TYPE.has(value as BacklogType)
}

export function isBacklogDifficulty(value: unknown): value is BacklogDifficulty {
  return typeof value === 'string' && VALID_DIFFICULTY.has(value as BacklogDifficulty)
}

export function isBacklogCriticality(value: unknown): value is BacklogCriticality {
  return typeof value === 'string' && VALID_CRITICALITY.has(value as BacklogCriticality)
}

export function isBacklogRisk(value: unknown): value is BacklogRisk {
  return typeof value === 'string' && VALID_RISK.has(value as BacklogRisk)
}

export function isBacklogHighlightColor(value: unknown): value is BacklogHighlightColor {
  return typeof value === 'string' && VALID_HIGHLIGHT_COLOR.has(value as BacklogHighlightColor)
}

export function backlogRootPath(workspaceRoot: string): string {
  return joinPath(workspaceRoot, BACKLOG_FOLDER)
}

/**
 * Where a workspace's backlog items physically live, and which workspace they
 * belong to. The two are the same folder by default (`<workspaceRoot>/backlog`)
 * and diverge when a workspace points its backlog at a folder outside the
 * checkout — a directory on this machine, or a clone of a backlog repo.
 *
 * `root` moves; identity does not. Every item is still addressed by the LOGICAL
 * path `backlog/<...>` that the object store, the durable links, the sprint
 * links and the mobile snapshot all key on, so redirecting a backlog rewrites
 * no ids and migrates no links. `backlogLogicalPath` and `backlogAbsolutePath`
 * are the only two places that know the difference.
 */
export type BacklogLocation = {
  workspaceRoot: string
  root: string
}

/** The location a workspace has until it configures one: `<root>/backlog`. */
export function defaultBacklogLocation(workspaceRoot: string): BacklogLocation {
  return { workspaceRoot, root: backlogRootPath(workspaceRoot) }
}

/**
 * Resolve a location from a configured root. An empty or absent `configuredRoot`
 * means "the default", so a config that has never been written and one that has
 * been reset to the default behave identically.
 */
export function backlogLocationFor(workspaceRoot: string, configuredRoot?: string | null): BacklogLocation {
  const trimmed = typeof configuredRoot === 'string' ? configuredRoot.trim() : ''
  if (!trimmed) return defaultBacklogLocation(workspaceRoot)
  // A relative root is not honoured. `setBacklogRoot` refuses to write one, so
  // this only guards a hand-edited config, where "relative to what" has no good
  // answer — the same file is read by the main process, the renderer and the
  // mobile bridge, none of which share a working directory. Falling back to the
  // default is the recoverable reading; joining a half-understood path onto the
  // workspace and writing items into it is not.
  if (!isAbsoluteFilePath(trimmed)) return defaultBacklogLocation(workspaceRoot)
  return { workspaceRoot, root: trimmed.replace(/[\\/]+$/, '') }
}

/** A location is the default one when nothing was configured away from it. */
export function isDefaultBacklogLocation(location: BacklogLocation): boolean {
  const expected = backlogRootPath(location.workspaceRoot).replace(/\\/g, '/').toLowerCase()
  return location.root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === expected
}

/**
 * An absolute file path under the backlog root, as the LOGICAL `backlog/<...>`
 * path that identifies the item. Returns null for anything outside the root.
 *
 * With a default location this is exactly what
 * `workspaceRelativePath(workspaceRoot, filePath)` returned before the root
 * became configurable, byte for byte — which is what lets an existing workspace
 * keep every id and link it already has.
 */
export function backlogLogicalPath(location: BacklogLocation, absolutePath: string): string | null {
  const within = workspaceRelativePath(location.root, absolutePath)
  if (within === null) return null
  return within ? `${BACKLOG_FOLDER}/${within}` : BACKLOG_FOLDER
}

/**
 * The inverse: where a logical `backlog/<...>` path sits on disk.
 *
 * This is also the containment check. It used to be done by joining onto the
 * workspace root and asking `isPathInsideOrEqual(workspace.root, target)`, which
 * admitted any path inside the checkout; asking it against the backlog root is
 * strictly tighter, and it is the only check that still means something once the
 * root can sit outside the workspace entirely. Returns null rather than throwing
 * so callers keep whatever refusal they already had.
 */
export function backlogAbsolutePath(location: BacklogLocation, relativePath: string): string | null {
  const normalized = normalizeRelativePath(relativePath)
  if (!isBacklogRelativePath(normalized)) return null
  // Reject traversal before joining: `backlog/../../etc/passwd` normalizes to a
  // path that still starts with `backlog/` and would otherwise climb out.
  if (normalized.split('/').some((segment) => segment === '..')) return null
  const within = normalized === BACKLOG_FOLDER ? '' : normalized.slice(BACKLOG_FOLDER.length + 1)
  return within ? joinPath(location.root, within) : location.root
}

// Accepts a bare workspace root for the default location, or a resolved
// `BacklogLocation` for a workspace that points its backlog elsewhere. The
// string form is what every caller passed before the root became configurable
// and keeps meaning exactly what it meant.
export async function scanBacklog(
  where: string | BacklogLocation,
  fs: BacklogFilesystemAdapter,
): Promise<BacklogScanResult> {
  const location = typeof where === 'string' ? defaultBacklogLocation(where) : where
  const rootPath = location.root
  const exists = await fs.pathExists(rootPath)
  if (!exists) return { state: 'missing-folder', items: [], errors: [] }

  const files: string[] = []
  const errors: BacklogScanError[] = []

  try {
    await collectBacklogSourceFiles(rootPath, fs, files)
  } catch (error) {
    return {
      state: 'error',
      items: [],
      errors: [{ relativePath: 'backlog/', message: errorMessage(error) }],
    }
  }

  // Read + stat each file through a bounded-concurrency pool instead of one
  // sequential round-trip at a time. Each slot is read in parallel via the
  // shared `nextIndex` cursor, but results are written back into a
  // position-indexed array so the final list keeps the deterministic
  // path-sorted order and the same per-file error isolation as before — an
  // unreadable file becomes a BacklogScanError, never a thrown scan.
  const sortedFiles = files.sort(comparePaths)
  const slotResults: Array<{ item: BacklogItem } | { error: BacklogScanError } | null> =
    new Array(sortedFiles.length).fill(null)

  let nextIndex = 0
  const readSlot = async (): Promise<void> => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= sortedFiles.length) return

      const filePath = sortedFiles[index]
      const relativePath = backlogLogicalPath(location, filePath)
      if (!relativePath || !isBacklogRelativePath(relativePath)) continue

      try {
        const [sourceContent, stats] = await Promise.all([fs.readfile(filePath), fs.statPath(filePath)])
        if (!stats.isFile) continue
        slotResults[index] = {
          item: createBacklogItem({
            path: filePath,
            relativePath,
            sourceContent,
            stats,
            workspaceRoot: location.workspaceRoot,
          }),
        }
      } catch (error) {
        slotResults[index] = {
          error: { relativePath: normalizeRelativePath(relativePath), message: errorMessage(error) },
        }
      }
    }
  }

  const workerCount = Math.min(BACKLOG_SCAN_CONCURRENCY, sortedFiles.length)
  await Promise.all(Array.from({ length: workerCount }, () => readSlot()))

  const items: BacklogItem[] = []
  for (const slot of slotResults) {
    if (!slot) continue
    if ('item' in slot) items.push(slot.item)
    else errors.push(slot.error)
  }

  if (items.length === 0 && errors.length === 0) return { state: 'empty-folder', items: [], errors: [] }
  if (errors.length === 0) return { state: 'ready', items, errors: [] }
  if (items.length > 0) return { state: 'partial', items, errors }
  return { state: 'error', items, errors }
}

async function collectBacklogSourceFiles(
  directoryPath: string,
  fs: Pick<BacklogFilesystemAdapter, 'readdir'>,
  files: string[],
): Promise<void> {
  const entries = await fs.readdir(directoryPath)
  for (const entry of entries) {
    const entryPath = joinPath(directoryPath, entry.name)
    if (entry.isDir) {
      if (shouldScanDirectory(entry.name)) await collectBacklogSourceFiles(entryPath, fs, files)
      continue
    }
    if (isBacklogSourceFile(entry.name)) files.push(entryPath)
  }
}

export function createBacklogItem(input: {
  path: string
  relativePath: string
  sourceContent: string
  stats: Pick<FileSystemStat, 'modifiedAtMs' | 'sizeBytes'>
  object?: BacklogItemObjectMetadata
  /** The project this item belongs to, for resolving its durable run links. */
  workspaceRoot?: string
}): BacklogItem {
  const relativePath = normalizeRelativePath(input.relativePath)
  const { body, fields } = parseBacklogFrontmatter(input.sourceContent)
  const frontmatterKind = parseBacklogKind(frontmatterValue(fields, 'kind', 'planKind', 'plan_kind', 'sourcePlanKind', 'source_plan_kind'))
  const inferredKind = inferBacklogKind(relativePath, body)
  const archived = isArchivedBacklogPath(relativePath)
  const frontmatterStatus = parseBacklogStatus(frontmatterValue(fields, 'status'))
  const numericId = parseBacklogNumericId(frontmatterValue(fields, 'id'))
  const rawType = frontmatterValue(fields, 'type', 'itemType', 'item_type', 'backlogType', 'backlog_type')
  const frontmatterType = parseBacklogType(rawType)
  const frontmatterDifficulty = parseBacklogDifficulty(frontmatterValue(fields, 'difficulty', 'size'))
  const frontmatterCriticality = parseBacklogCriticality(frontmatterValue(fields, 'criticality', 'priority'))
  const frontmatterRisk = parseBacklogRisk(frontmatterValue(fields, 'risk'))
  const epic = frontmatterValue(fields, 'epic')
  const dependsOn = parseBacklogDependsOn(frontmatterValue(fields, 'dependsOn'), backlogItemSlugFromPath(relativePath))
  const dependenciesPlanned = parseBacklogDependenciesPlanned(frontmatterValue(fields, 'dependenciesPlanned'))
  const mockupsList = parseBacklogMockups(frontmatterValue(fields, 'mockups'))
  const title = inferBacklogTitle(relativePath, body)
  // Lifecycle/triage and epic are frontmatter-sourced (frontmatter is the source
  // of truth); the sidecar object only contributes identity, links, metadata,
  // and highlight.
  const type = frontmatterType ?? defaultBacklogType(frontmatterKind ?? inferredKind)

  return {
    id: relativePath,
    objectId: input.object?.objectId ?? stableBacklogObjectId(relativePath),
    path: input.path,
    relativePath,
    title,
    kind: frontmatterKind ?? inferredKind,
    status: archived ? 'archived' : frontmatterStatus ?? defaultBacklogStatus(),
    numericId,
    type,
    rawType,
    difficulty: frontmatterDifficulty,
    criticality: frontmatterCriticality,
    risk: frontmatterRisk,
    epic,
    isEpic: type === 'epic',
    dependsOn,
    // Present only when set, so an unflagged epic's item reads exactly as it did
    // before the field existed.
    ...(dependenciesPlanned ? { dependenciesPlanned } : {}),
    mockups: mockupsList.length > 0 ? mockupsList : undefined,
    // Frontmatter first: the star is the person's own choice and lives with the
    // item. The cache is only a fallback for a row not migrated yet.
    highlight: backlogHighlightFromFrontmatter(fields) ?? input.object?.highlight,
    metadata: input.object?.metadata ?? {},
    // Durable links come from this file's own frontmatter, so they travel with it
    // and never depend on a sidecar keyed by path. `input.object` is now the
    // volatile cache: it overlays resolved status onto those, and contributes the
    // agent-terminal link, which has no durable half.
    links: mergeBacklogLinks(
      durableBacklogLinksFromFrontmatter(fields, input.workspaceRoot),
      input.object?.links ?? [],
    ),
    objectUpdatedAt: input.object?.updatedAt,
    excerpt: backlogExcerpt(body, title),
    modifiedAt: resolveBacklogRecencyMs(frontmatterValue(fields, 'updated'), input.stats.modifiedAtMs),
    createdAtMs: resolveBacklogCreatedMs(input.object?.createdAt, relativePath, input.stats.modifiedAtMs),
    size: input.stats.sizeBytes,
    sourceContent: input.sourceContent,
  }
}

// Recently-updated recency: the frontmatter `updated` timestamp when it carries
// a time component and parses as a date, else the file mtime. `YYYY-MM-DD` is a
// valid calendar date but Date.parse anchors it to UTC midnight; treating that
// as a precise instant produces misleading labels such as "22h ago" for a file
// created that evening. New writers stamp full ISO date-times, while this
// fallback keeps legacy and hand-authored date-only files honest.
function resolveBacklogRecencyMs(updated: string | undefined, mtimeMs: number): number {
  if (updated && /^\d{4}-\d{2}-\d{2}T/.test(updated)) {
    const parsed = Date.parse(updated)
    if (!Number.isNaN(parsed)) return parsed
  }
  return mtimeMs
}

// Effective creation time: the object store's stamped `createdAt` when present
// and parseable (the authoritative source — set once and never overwritten),
// else the `YYYY-MM-DD` date prefix most leaf items carry on their filename
// (undated epic files and unprefixed notes skip this), else the file mtime.
// Keeps the recently-created sort meaningful even for items scanned before they
// have an object record.
function resolveBacklogCreatedMs(
  objectCreatedAt: string | undefined,
  relativePath: string,
  mtimeMs: number,
): number {
  if (objectCreatedAt) {
    const parsed = Date.parse(objectCreatedAt)
    if (!Number.isNaN(parsed)) return parsed
  }
  const prefixed = backlogFilenameDateMs(relativePath)
  if (prefixed != null) return prefixed
  return mtimeMs
}

// Parse a leading `YYYY-MM-DD` date from the file's basename (e.g.
// `backlog/2026-06-30-foo.md` -> that day at UTC midnight), or null when the
// name has no such prefix. UTC so the ordering is stable regardless of the
// viewer's timezone.
function backlogFilenameDateMs(relativePath: string): number | null {
  const name = normalizeRelativePath(relativePath).split('/').filter(Boolean).at(-1) ?? ''
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(name)
  if (!match) return null
  const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

export function inferBacklogKind(relativePath: string, content: string): BacklogItemKind {
  if (HTML_EXTENSION_RE.test(relativePath)) return 'html_mockup'
  return inferSourcePlanKind(relativePath, content)
}

function inferBacklogTitle(relativePath: string, content: string): string {
  const mdTitle = markdownTitle(content)
  if (mdTitle) return mdTitle

  const htmlTitle = htmlDocumentTitle(content) ?? htmlHeadingTitle(content)
  if (htmlTitle) return htmlTitle

  return toTitleName(planBasename(relativePath).replace(/\.html?$/i, ''))
}

export function backlogExcerpt(content: string, leadingTitle = '', maxLength = 180): string {
  const flattened = content
    .replace(FRONTMATTER_RE, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Drop a leading copy of the title so the row's supporting line starts at real
  // body content instead of echoing the title already shown directly above it.
  const text = stripLeadingTitle(flattened, leadingTitle)

  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
}

function stripLeadingTitle(text: string, title: string): string {
  const needle = title.trim()
  if (!needle || !text.toLowerCase().startsWith(needle.toLowerCase())) return text
  return text.slice(needle.length).replace(/^[\s:.,;–—-]+/, '').trim()
}

// Markdown for the detail preview: drop the frontmatter block and a single
// leading H1 (the derived title, already shown in the detail header) so the
// preview reads as a document body instead of restating the title at display
// size and rendering raw YAML. Non-title leading headings (H2+) and all body
// content are preserved. Returns '' when the file is only a title.
export function backlogPreviewMarkdown(sourceContent: string): string {
  const lines = sourceContent.replace(FRONTMATTER_RE, '').split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start += 1
  if (start < lines.length && /^#(?!#)\s+\S/.test(lines[start].trim())) {
    start += 1
    while (start < lines.length && lines[start].trim() === '') start += 1
  }
  return lines.slice(start).join('\n').trimEnd()
}

function isBacklogSourceFile(pathValue: string): boolean {
  return SOURCE_EXTENSION_RE.test(pathValue)
}

function isBacklogRelativePath(pathValue: string): boolean {
  const normalized = normalizeRelativePath(pathValue)
  return normalized === 'backlog' || normalized.startsWith('backlog/')
}

export function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

// Re-export the canonical object-store id so importers of this module keep a
// stable entry point; the implementation now lives in the shared module used by
// both processes and the /backlog skill.
export { stableBacklogObjectId }

// The relative path of a project's Backlog display-key config, under the
// app-owned sidecar. Takes the project root because the sidecar's name differs
// between a project made before the rename and one made after. The `key:`
// inside prefixes every item's human id (`MC-240`); the cross-project read
// model resolves it per project so aggregated rows never collide (`MA-112`
// beside `MC-1758`).
export function backlogConfigRelativePath(folderPath: string): string {
  return sidecarRelativePath(knownSidecarDirName(folderPath), 'backlog', 'config.json')
}

// Resolve a project's Backlog display key from its `config.json` contents,
// falling back to the name-derived default when the file is absent, unreadable,
// or carries no valid key. Read-only and pure (the raw JSON is supplied by the
// caller): unlike the main-process resolver behind `ensureBacklogItemIds`, it
// never persists a derived default — the aggregate read model only reads. Mirrors
// the mobile snapshot resolver (src/main/mobile/sprintengine/backlog.ts) so a
// project's key reads identically wherever it is surfaced.
export function resolveBacklogDisplayKey(configJson: string | null | undefined, projectName: string): string {
  if (configJson) {
    try {
      const parsed = JSON.parse(configJson) as { key?: unknown }
      if (isValidBacklogKey(parsed.key)) return parsed.key
    } catch {
      // Malformed config: fall back to the derived default rather than failing.
    }
  }
  return deriveDefaultBacklogKey(projectName)
}

// Stable per-item slug = the file's name stem, independent of its directory
// (e.g. `backlog/epics/auth-revamp.md` -> `auth-revamp`,
// `backlog/checkout.html` -> `checkout`). This is the identifier the `epic:`
// pointer and each `dependsOn:` prerequisite reference, so epic slug derivation
// (backlogEpicSlugFromPath) reuses it — keeping one definition of "the slug".
export function backlogItemSlugFromPath(relativePath: string): string {
  const name = normalizeRelativePath(relativePath).split('/').filter(Boolean).at(-1) ?? relativePath
  return name.replace(SOURCE_EXTENSION_RE, '')
}

export function nextArchiveRelativePath(
  sourceRelativePath: string,
  existingRelativePaths: Iterable<string>,
): string {
  const normalizedExisting = new Set(Array.from(existingRelativePaths, (pathValue) => normalizeRelativePath(pathValue).toLowerCase()))
  const sourceName = normalizeRelativePath(sourceRelativePath).split('/').filter(Boolean).at(-1) ?? 'untitled.md'
  const dotIndex = sourceName.lastIndexOf('.')
  const stem = dotIndex > 0 ? sourceName.slice(0, dotIndex) : sourceName
  const extension = dotIndex > 0 ? sourceName.slice(dotIndex) : ''

  let candidate = `${ARCHIVED_PREFIX}${sourceName}`
  let index = 2
  while (normalizedExisting.has(candidate.toLowerCase())) {
    candidate = `${ARCHIVED_PREFIX}${stem}-${index}${extension}`
    index += 1
  }
  return candidate
}

function frontmatterValue(fields: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const normalized = key.toLowerCase()
    const flat = fields[normalized]
    if (flat) return flat
    const nested = fields[`backlog.${normalized}`]
    if (nested) return nested
  }
  return undefined
}

function parseBacklogKind(value: string | undefined): BacklogItemKind | null {
  if (!value) return null
  return VALID_KIND.has(value as BacklogItemKind) ? (value as BacklogItemKind) : null
}

function parseBacklogStatus(value: string | undefined): BacklogItemStatus | null {
  if (!value) return null
  // Migrate the retired `needs_structure` status to `idea` (both are rough,
  // pre-work captures) so older frontmatter / object records keep loading.
  if (value === 'needs_structure') return 'idea'
  return VALID_STATUS.has(value as BacklogItemStatus) ? (value as BacklogItemStatus) : null
}

function parseBacklogType(value: string | undefined): BacklogType | undefined {
  if (!value) return undefined
  return isBacklogType(value) ? value : undefined
}

function parseBacklogDifficulty(value: string | undefined): BacklogDifficulty | undefined {
  if (!value) return undefined
  return isBacklogDifficulty(value) ? value : undefined
}

function parseBacklogCriticality(value: string | undefined): BacklogCriticality | undefined {
  if (!value) return undefined
  return isBacklogCriticality(value) ? value : undefined
}

function parseBacklogRisk(value: string | undefined): BacklogRisk | undefined {
  if (!value) return undefined
  return isBacklogRisk(value) ? value : undefined
}

// Parse the `dependsOn:` prerequisite list: a flat comma-separated scalar of item
// slugs, cleaned (trim/dedupe) by the shared helper, with this item's own slug
// dropped so a self-reference can never make an item block itself. Tolerant on
// read like an unknown `type:` — dangling or malformed slugs are preserved here
// and surfaced as "unknown prerequisite" during derivation (T2), not filtered
// out silently. Returns undefined when the field is absent or names only self,
// so dependsOn is always either a non-empty list or undefined.
function parseBacklogDependsOn(value: string | undefined, selfSlug: string): string[] | undefined {
  if (!value) return undefined
  const slugs = parseBacklogCsvList(value).filter((slug) => slug !== selfSlug)
  return slugs.length > 0 ? slugs : undefined
}

// Rough captures default to a calm "idea", regardless of whether a plan kind
// could be inferred. Unknown structure is not a defect — the architect / Sprint
// Engine start flow turns rough input into a structured plan later, so the
// backlog never flags an unestimated note as "needs structure" on its own.
function defaultBacklogStatus(): BacklogItemStatus {
  return 'idea'
}

function defaultBacklogType(kind: BacklogItemKind): BacklogType | undefined {
  return kind === 'html_mockup' ? 'mockup' : undefined
}

function isArchivedBacklogPath(relativePath: string): boolean {
  return normalizeRelativePath(relativePath).toLowerCase().startsWith(ARCHIVED_PREFIX)
}

function htmlDocumentTitle(content: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content)
  return cleanHtmlTitle(match?.[1])
}

function htmlHeadingTitle(content: string): string | null {
  const match = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(content)
  return cleanHtmlTitle(match?.[1])
}

function cleanHtmlTitle(value: string | undefined): string | null {
  const cleaned = (value ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  return cleaned || null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function comparePaths(a: string, b: string): number {
  return normalizeRelativePath(a).localeCompare(normalizeRelativePath(b))
}
