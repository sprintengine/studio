// "Started from" seed-document model for the Sprint Inbox. Pure, node-testable
// logic (no React, no window) that turns the projected run source + sourceBundle
// (see workspace.ts SprintEngineSource / SprintEngineSourceBundleStateItem) into
// the ordered rows the Inbox renders under a pinned "Started from" section.
//
// Every row is a real on-disk file. The primary document (the launch seed) is
// always first. An epic launch nests its member backlog items under the epic
// container, then lists supporting files. No new data model — this only
// re-shapes fields T2 already projects.

import { basename } from '../../../utils/paths'
import { parseBacklogFrontmatter } from '../../../../../shared/backlog/frontmatter'
import { TRACKER_PROVIDER_LABEL } from '../../../../../shared/tracker/provider-label'
import type { SprintEngineSource, SprintEngineSourceBundleStateItem } from '../../../types/workspace'

// Reference = the original file is read in place (it stays canonical); the run
// records where it lives and when it was captured. Copy = the file was written
// into the run store at launch (typed/piped/copied input), so the original is
// not the live source.
export type SprintEngineSeedMode = 'reference' | 'copy'

// 'html' routes to the sandboxed HtmlArtifactFrame; 'file' routes to
// FilePreviewPane, which itself renders markdown vs. a plain-text fallback.
export type SprintEngineSeedPreviewKind = 'html' | 'file'

export type SprintEngineSeedRole = 'primary' | 'epic-child' | 'supporting'

export type SprintEngineSeedRow = {
  /** Stable key for selection + list rendering. */
  key: string
  /** Project-relative on-disk path that is read and previewed. */
  path: string
  /** Project-relative `backlog/…` path for "Open in Backlog"; absent when the
   *  row is not a backlog item / epic child. */
  backlogPath?: string
  /** File name (basename of `path`). */
  fileName: string
  kindLabel: string
  mode: SprintEngineSeedMode
  /** ISO capture time; surfaced only for reference-mode rows. */
  capturedAt?: string
  previewKind: SprintEngineSeedPreviewKind
  role: SprintEngineSeedRole
  isPrimary: boolean
}

export type SprintEngineStartedFrom = {
  /** True when the launch seed is a backlog epic (children nest under it). */
  epic: boolean
  /** Plain-words header subtitle, e.g. "backlog item + 4 files". */
  subtitle: string
  /** Ordered rows: primary first, then epic children, then supporting files. */
  rows: SprintEngineSeedRow[]
}

const BACKLOG_PREFIX = /^backlog[\\/]/i
const BACKLOG_EPICS_PREFIX = /^backlog[\\/]epics[\\/]/i
const HTML_EXT = /\.html?$/i

const KIND_LABELS: Record<string, string> = {
  epic: 'Epic',
  selection: 'Selection',
  product_plan: 'Product plan',
  architect_plan: 'Architect plan',
  plan_overview: 'Plan overview',
  html_mockup: 'Mockup',
  design_notes: 'Design notes',
  generic_context: 'Context',
}

export function sprintEngineSeedMode(origin: string | undefined): SprintEngineSeedMode {
  return origin === 'reference' ? 'reference' : 'copy'
}

export function sprintEngineSeedPreviewKind(path: string): SprintEngineSeedPreviewKind {
  return HTML_EXT.test(path) ? 'html' : 'file'
}

export function isSprintEngineBacklogPath(path: string | undefined | null): path is string {
  return typeof path === 'string' && BACKLOG_PREFIX.test(path)
}

function isEpicFilePath(path: string | undefined | null): boolean {
  return typeof path === 'string' && BACKLOG_EPICS_PREFIX.test(path)
}

export function sprintEngineSeedKindLabel(params: {
  kind?: string
  backlogPath?: string
  isEpicRoot: boolean
}): string {
  const { kind, backlogPath, isEpicRoot } = params
  if (isEpicRoot || isEpicFilePath(backlogPath)) return 'Epic'
  if (backlogPath) return 'Backlog item'
  if (kind && KIND_LABELS[kind]) return KIND_LABELS[kind]
  return 'Document'
}

// Human "captured at launch · HH:MM" label, only for reference-mode rows (a
// copied seed has no meaningful in-place capture moment). Returns null when the
// label should not be shown so the caller can omit the metadata cleanly.
export function sprintEngineCapturedLabel(
  capturedAt: string | undefined,
  mode: SprintEngineSeedMode,
): string | null {
  if (mode !== 'reference' || !capturedAt) return null
  const clock = formatClockTime(capturedAt)
  return clock ? `captured at launch · ${clock}` : 'captured at launch'
}

// "Reference · captured at launch · 18:26" / "Copy" — how the run took the file,
// plus (for a reference) the moment it read it.
export function sprintEngineSeedCaptureLabel(row: SprintEngineSeedRow): string {
  const mode = row.mode === 'reference' ? 'Reference' : 'Copy'
  const captured = sprintEngineCapturedLabel(row.capturedAt, row.mode)
  return captured ? `${mode} · ${captured}` : mode
}

// One capture line for the whole seeded-documents list, when every row agrees on
// it. A seeded backlog item now renders as an ordinary Backlog row — status
// glyph, id, size, priority, touched-time — which has no slot for capture
// metadata; and on the common launch, where every document was taken the same
// way at the same instant, repeating "Reference · captured at launch · 18:26" on
// each row was noise the rows had to make space for. Hoisting it says the same
// thing once. Returns null when the rows genuinely disagree (a typed seed beside
// referenced bundle files), and the panel then falls back to a per-row capture
// cell so a real difference is never silently dropped.
export function sprintEngineSharedCaptureLabel(rows: readonly SprintEngineSeedRow[]): string | null {
  if (rows.length === 0) return null
  const first = sprintEngineSeedCaptureLabel(rows[0])
  return rows.every((row) => sprintEngineSeedCaptureLabel(row) === first) ? first : null
}

function formatClockTime(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

type SeedInput = {
  path: string
  originalPath?: string
  origin: string
  kind?: string
  capturedAt?: string
}

function buildSeedRow(item: SeedInput, role: SprintEngineSeedRole, isPrimary: boolean): SprintEngineSeedRow {
  // Prefer the recorded original (copy mode) over the stored path, but only
  // treat it as a backlog reference when it actually lives under backlog/.
  const candidate = item.originalPath ?? item.path
  const backlogPath = isSprintEngineBacklogPath(candidate) ? candidate : undefined
  const isEpicRoot = isPrimary && item.kind === 'epic'
  return {
    key: `${role}:${item.path}`,
    path: item.path,
    backlogPath,
    fileName: basename(item.path),
    kindLabel: sprintEngineSeedKindLabel({ kind: item.kind, backlogPath, isEpicRoot }),
    mode: sprintEngineSeedMode(item.origin),
    capturedAt: item.capturedAt,
    previewKind: sprintEngineSeedPreviewKind(item.path),
    role,
    isPrimary,
  }
}

export function buildSprintEngineStartedFrom(
  source: SprintEngineSource | undefined,
  sourceBundle: SprintEngineSourceBundleStateItem[] | undefined,
): SprintEngineStartedFrom | null {
  // No recorded seed (legacy runs) → no section at all, rather than an empty one.
  if (!source || !source.path) return null

  // The work-list gate (MC-2060): a `selection` launch carries its work items
  // in the bundle exactly as an epic launch carries its children, so both nest
  // their backlog items as child rows (and pass every consumer keyed on this
  // flag — the Epic tab renders a list of items, which is what a selection is).
  const epic = source.planKind === 'epic' || source.planKind === 'selection'
  const primary = buildSeedRow(
    {
      path: source.path,
      originalPath: source.originalPath,
      origin: source.origin,
      kind: source.planKind,
      capturedAt: source.capturedAt,
    },
    'primary',
    true,
  )

  const children: SprintEngineSeedRow[] = []
  const supporting: SprintEngineSeedRow[] = []
  for (const item of sourceBundle ?? []) {
    const candidate = item.originalPath ?? item.path
    // Epic members are the bundle's backlog items (the epic file itself is the
    // primary, never a child). Everything else is a supporting file.
    const isChild = epic && isSprintEngineBacklogPath(candidate) && !isEpicFilePath(candidate)
    const row = buildSeedRow(
      {
        path: item.path,
        originalPath: item.originalPath,
        origin: item.origin,
        kind: item.kind,
        capturedAt: item.capturedAt,
      },
      isChild ? 'epic-child' : 'supporting',
      false,
    )
    ;(isChild ? children : supporting).push(row)
  }

  return {
    epic,
    subtitle: buildSubtitle(primary, epic, children.length, supporting.length, source.planKind === 'selection'),
    rows: [primary, ...children, ...supporting],
  }
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function buildSubtitle(
  primary: SprintEngineSeedRow,
  epic: boolean,
  childCount: number,
  supportingCount: number,
  selection = false,
): string {
  if (epic) {
    const head = childCount > 0
      ? `${selection ? 'selection' : 'epic'} · ${pluralize(childCount, 'item')}`
      : selection ? 'selection' : 'epic'
    return supportingCount > 0 ? `${head} + ${pluralize(supportingCount, 'file')}` : head
  }
  const noun = primary.backlogPath ? 'backlog item' : primary.kindLabel.toLowerCase()
  const bundleCount = childCount + supportingCount
  return bundleCount > 0 ? `${noun} + ${pluralize(bundleCount, 'file')}` : noun
}

// Tracker provenance for a "Started from" seed row (MC-1639): the native issue
// key and tracker URL a proxy backlog item carries in its flat underscore
// frontmatter (plan §3.4). Pure over the file's own content so the Inbox can
// show "PROJ-141 · View in Jira" beside a proxy-seeded run without any new data
// model. Returns null for a native (non-proxy) item — its row is unchanged.
export type SprintEngineSeedProvenance = {
  provider: 'github' | 'jira' | 'linear'
  nativeKey: string
  url: string
}

export function sprintEngineSeedProvenanceProviderLabel(
  provider: SprintEngineSeedProvenance['provider'],
): string {
  return TRACKER_PROVIDER_LABEL[provider]
}

export function trackerSeedProvenance(sourceContent: string): SprintEngineSeedProvenance | null {
  const { fields } = parseBacklogFrontmatter(sourceContent)
  const provider = fields.external_provider?.trim()
  const nativeKey = fields.external_key?.trim()
  const url = fields.external_url?.trim()
  if (!provider || !nativeKey) return null
  if (provider !== 'github' && provider !== 'jira' && provider !== 'linear') return null
  return { provider, nativeKey, url: url ?? '' }
}
