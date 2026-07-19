import type { BacklogHighlightColorPayload, FileSystemStat } from '../../../shared/electron-api'
import { parseBacklogCsvList, parseBacklogFrontmatter } from '../../../shared/backlog/frontmatter'
import { parseBacklogNumericId } from '../../../shared/backlog/item-id'
import { parseBacklogMockups } from './backlogMockups'
import type { HighlightColor, SprintEngineSourcePlanKind } from '../types/workspace'
import {
  inferSourcePlanKind,
  joinPath,
  markdownTitle,
  planBasename,
  shouldScanDirectory,
  toTitleName,
  workspaceRelativePath,
} from '../components/workspace/newWorkspace/helpers'

export type BacklogItemKind = SprintEngineSourcePlanKind | 'html_mockup'
export type BacklogItemStatus = 'idea' | 'ready' | 'in_progress' | 'needs_input' | 'completed' | 'archived'
export type BacklogScanState = 'missing-folder' | 'empty-folder' | 'ready' | 'partial' | 'error'

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

export type BacklogItemLinkStatus = 'active' | 'completed' | 'canceled' | 'failed' | 'unknown'

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
  }
  status?: BacklogItemLinkStatus
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
  // workspace key (see src/shared/backlog/item-id.ts). Undefined until the scan-
  // time allocation pass assigns one (ensureBacklogItemIds).
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
  // Attached mockup files from the frontmatter `mockups:` comma-separated scalar
  // — project-relative paths, cleaned (normalized slashes, absolute/`..` dropped)
  // by parseBacklogMockups. `undefined` when the field is absent or names nothing
  // valid. Authored intent that travels with the file (mirrors `dependsOn`);
  // body-prose references are derived separately (backlogMockups.ts), never
  // stored here.
  mockups?: string[]
  highlight?: BacklogHighlight
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  objectUpdatedAt?: string
  excerpt: string
  // Effective recency in epoch ms: frontmatter `updated` (ISO) when present and
  // parseable, else the file mtime. Drives the recently-updated sort and the
  // row's relative-time label.
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

export async function scanBacklog(
  workspaceRoot: string,
  fs: BacklogFilesystemAdapter,
): Promise<BacklogScanResult> {
  const rootPath = backlogRootPath(workspaceRoot)
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
      const relativePath = workspaceRelativePath(workspaceRoot, filePath)
      if (!relativePath || !isBacklogRelativePath(relativePath)) continue

      try {
        const [sourceContent, stats] = await Promise.all([fs.readfile(filePath), fs.statPath(filePath)])
        if (!stats.isFile) continue
        slotResults[index] = {
          item: createBacklogItem({ path: filePath, relativePath, sourceContent, stats }),
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
    mockups: mockupsList.length > 0 ? mockupsList : undefined,
    highlight: input.object?.highlight,
    metadata: input.object?.metadata ?? {},
    links: input.object?.links ?? [],
    objectUpdatedAt: input.object?.updatedAt,
    excerpt: backlogExcerpt(body, title),
    modifiedAt: resolveBacklogRecencyMs(frontmatterValue(fields, 'updated'), input.stats.modifiedAtMs),
    createdAtMs: resolveBacklogCreatedMs(input.object?.createdAt, relativePath, input.stats.modifiedAtMs),
    size: input.stats.sizeBytes,
    sourceContent: input.sourceContent,
  }
}

// Recently-updated recency: the frontmatter `updated` timestamp when present and
// parseable as a date, else the file mtime. Keeps the sort and the row's
// relative-time anchored to the authored "updated" field when authors set it.
function resolveBacklogRecencyMs(updated: string | undefined, mtimeMs: number): number {
  if (updated) {
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

export function inferBacklogTitle(relativePath: string, content: string): string {
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

export function isBacklogSourceFile(pathValue: string): boolean {
  return SOURCE_EXTENSION_RE.test(pathValue)
}

export function isBacklogRelativePath(pathValue: string): boolean {
  const normalized = normalizeRelativePath(pathValue)
  return normalized === 'backlog' || normalized.startsWith('backlog/')
}

export function normalizeRelativePath(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

export function stableBacklogObjectId(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath).toLowerCase()
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `backlog_${(hash >>> 0).toString(36)}`
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
