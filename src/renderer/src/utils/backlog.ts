import type { BacklogHighlightColorPayload, FileSystemStat } from '../../../shared/electron-api'
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
export type BacklogType = 'feature' | 'bug' | 'mockup'
export type BacklogDifficulty = 'xs' | 's' | 'm' | 'l' | 'xl'
export type BacklogCriticality = 'low' | 'normal' | 'high' | 'critical'

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

export type BacklogItemLinkStatus = 'active' | 'completed' | 'failed' | 'unknown'

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

export type BacklogItemObjectMetadata = {
  objectId: string
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  type?: BacklogType
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  highlight?: BacklogHighlight
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
  type?: BacklogType
  difficulty?: BacklogDifficulty
  criticality?: BacklogCriticality
  highlight?: BacklogHighlight
  metadata: Record<string, unknown>
  links: BacklogItemLink[]
  objectUpdatedAt?: string
  excerpt: string
  modifiedAt: number
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

type ParsedBacklogFrontmatter = {
  body: string
  data: Record<string, string>
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
const VALID_TYPE = new Set<BacklogType>(['feature', 'bug', 'mockup'])
const VALID_DIFFICULTY = new Set<BacklogDifficulty>(['xs', 's', 'm', 'l', 'xl'])
const VALID_CRITICALITY = new Set<BacklogCriticality>(['low', 'normal', 'high', 'critical'])
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
  const { body, data } = parseBacklogFrontmatter(input.sourceContent)
  const frontmatterKind = parseBacklogKind(frontmatterValue(data, 'kind', 'planKind', 'plan_kind', 'sourcePlanKind', 'source_plan_kind'))
  const inferredKind = inferBacklogKind(relativePath, body)
  const archived = isArchivedBacklogPath(relativePath)
  const frontmatterStatus = parseBacklogStatus(frontmatterValue(data, 'status'))
  const frontmatterType = parseBacklogType(frontmatterValue(data, 'type', 'itemType', 'item_type', 'backlogType', 'backlog_type'))
  const frontmatterDifficulty = parseBacklogDifficulty(frontmatterValue(data, 'difficulty', 'size'))
  const frontmatterCriticality = parseBacklogCriticality(frontmatterValue(data, 'criticality', 'priority'))
  const title = inferBacklogTitle(relativePath, body)

  return {
    id: relativePath,
    objectId: input.object?.objectId ?? stableBacklogObjectId(relativePath),
    path: input.path,
    relativePath,
    title,
    kind: frontmatterKind ?? inferredKind,
    status: archived ? 'archived' : frontmatterStatus ?? defaultBacklogStatus(),
    type: input.object?.type ?? frontmatterType ?? defaultBacklogType(frontmatterKind ?? inferredKind),
    difficulty: input.object?.difficulty ?? frontmatterDifficulty,
    criticality: input.object?.criticality ?? frontmatterCriticality,
    highlight: input.object?.highlight,
    metadata: input.object?.metadata ?? {},
    links: input.object?.links ?? [],
    objectUpdatedAt: input.object?.updatedAt,
    excerpt: backlogExcerpt(body, title),
    modifiedAt: input.stats.modifiedAtMs,
    size: input.stats.sizeBytes,
    sourceContent: input.sourceContent,
  }
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

function parseBacklogFrontmatter(content: string): ParsedBacklogFrontmatter {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return { body: content, data: {} }

  const data: Record<string, string> = {}
  let currentSection: string | null = null
  for (const rawLine of match[1].split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const section = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(rawLine)
    if (section) {
      currentSection = section[1].toLowerCase()
      continue
    }

    const kv = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(rawLine)
    if (!kv) continue
    const indent = kv[1].length
    const key = kv[2].toLowerCase()
    const value = stripYamlQuotes(kv[3])
    if (indent > 0 && currentSection) {
      data[`${currentSection}.${key}`] = value
    } else {
      currentSection = null
      data[key] = value
    }
  }
  return { body: content.slice(match[0].length), data }
}

function frontmatterValue(data: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const normalized = key.toLowerCase()
    const flat = data[normalized]
    if (flat) return flat
    const nested = data[`backlog.${normalized}`]
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

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function comparePaths(a: string, b: string): number {
  return normalizeRelativePath(a).localeCompare(normalizeRelativePath(b))
}
