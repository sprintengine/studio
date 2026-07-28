// skillsSurfaceModel — pure, DOM-free derivation for the Skills surface, the
// `settings/extensionsInstalled.ts` idiom: the React components own the IPC and
// the rendering, and everything that can be unit-tested without a renderer
// lives here.
//
// The one rule this module exists to hold: a source page's shape is derived
// from what the scan actually found, never from a template. `sourceLayout()`
// (src/shared/skills.ts, owned by the scan rule) decides the layout; nothing
// here re-derives it. What this module adds is the view each layout needs —
// which rows, which group, what the empty state says — plus the honest state
// lines for the rails, where "still loading" and "could not read" must never
// render as a zero count.

import {
  skillDirName,
  skillSourceMonogram,
  sourceLayout,
  type ScanResult,
  type ScannedSkill,
  type SkillSource,
  type SkillSourceLayout,
} from '../../../../../../../shared/skills'

/**
 * What a source is called on screen. A repository source is named by its
 * repository, not by the repository's last path segment: `mattpocock/skills`,
 * `anthropics/skills` and `browser-act/skills` are three different sources, and
 * three rail rows all reading "skills" would be unnavigable.
 */
export function sourceDisplayName(source: SkillSource): string {
  return source.repo || source.name
}

/** Badge letters for the display name, so those three read MS, AS and BA. */
export function sourceDisplayMonogram(source: SkillSource): string {
  return source.repo ? skillSourceMonogram(source.repo) : source.monogram
}

/** Per-source scan read. Sources list first; each scan lands independently. */
export type SkillScanLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; scan: ScanResult }

/** The source list read itself (one IPC call for every source). */
export type SkillSourcesLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' }

export type SkillSourceRailRow = {
  id: string
  name: string
  monogram: string
  /** '12 skills' once the scan lands; 'Loading…' / 'Count unavailable' before. */
  stateLine: string
  tooltip: string
}

export function pluralSkills(count: number): string {
  return `${count} ${count === 1 ? 'skill' : 'skills'}`
}

/** A source's one-line state. A failed or pending scan never reads as 0 skills. */
export function skillCountLine(load: SkillScanLoad | undefined): string {
  if (!load || load.status === 'loading') return 'Loading…'
  if (load.status === 'error') return 'Count unavailable'
  return pluralSkills(load.scan.skills.length)
}

export function deriveSourceRailRows(
  sources: readonly SkillSource[],
  scans: Readonly<Record<string, SkillScanLoad>>,
): SkillSourceRailRow[] {
  return sources.map((source) => {
    const stateLine = skillCountLine(scans[source.id])
    const name = sourceDisplayName(source)
    return {
      id: source.id,
      name,
      monogram: sourceDisplayMonogram(source),
      stateLine,
      // The rail truncates hard at 216px, so the hover carries the untruncated
      // name, the count, and what the source actually is.
      tooltip: `${name} — ${stateLine}${source.blurb ? `. ${source.blurb}` : ''}`,
    }
  })
}

/**
 * The Extensions rail's own "Skills" state line. The total is only spoken once
 * EVERY source has answered: a partial sum presented as the total would be a
 * lie that settles into a different number a second later.
 */
export function deriveSkillsKindStateLine(
  sourcesLoad: SkillSourcesLoad,
  sources: readonly SkillSource[],
  scans: Readonly<Record<string, SkillScanLoad>>,
): string {
  if (sourcesLoad.status === 'loading') return 'Loading…'
  if (sourcesLoad.status === 'error') return 'Sources unavailable'
  const sourceLine = `${sources.length} source${sources.length === 1 ? '' : 's'}`
  const loads = sources.map((source) => scans[source.id])
  if (loads.some((load) => !load || load.status !== 'ready')) return sourceLine
  const total = loads.reduce(
    (sum, load) => sum + (load && load.status === 'ready' ? load.scan.skills.length : 0),
    0,
  )
  return `${sourceLine} · ${pluralSkills(total)}`
}

// ── The source page ──────────────────────────────────────────────────────────

export type SkillListItem = {
  /** Source-relative directory path — the skill's identity within its source. */
  skillId: string
  name: string
  description: string
  /** '' when the source carries no grouping signal. */
  group: string
  fileCount: number
  hasExecutables: boolean
  /** A skill directory of this name is already in the workspace. */
  installed: boolean
}

export type SkillGroupTab = { name: string; label: string; count: number }

/**
 * What a source page renders. `layout` names the shape `sourceLayout()` chose,
 * so a view is never confused for a different one; `connectors` and `empty` are
 * the two cases decided before the layout rule runs.
 */
export type SkillSourceView =
  // The connector skills ship paired with the MCP server they belong to, and
  // are browsed there. Listing all 194 here would strip that pairing away.
  | { kind: 'connectors'; count: number }
  | { kind: 'empty' }
  | { kind: 'solo'; skill: SkillListItem }
  | { kind: 'flat'; items: SkillListItem[] }
  | { kind: 'grouped'; groups: SkillGroupTab[]; activeGroup: string; items: SkillListItem[] }
  | {
      kind: 'search'
      groups: SkillGroupTab[]
      activeGroup: string | null
      query: string
      items: SkillListItem[]
      /** Set when there is nothing to list yet, and says what to do about it. */
      prompt: string | null
    }

export type SkillSourceViewInput = {
  source: SkillSource
  scan: ScanResult
  /** Directory names of the skills installed in the active workspace. */
  installedDirNames: ReadonlySet<string>
  /** The group the user is browsing, or null for the source's first group. */
  activeGroup: string | null
  /** The search-first layout's query. */
  query: string
}

export function deriveSourceView(input: SkillSourceViewInput): SkillSourceView {
  const { source, scan } = input
  if (source.kind === 'connectors') return { kind: 'connectors', count: scan.skills.length }

  const layout: SkillSourceLayout = sourceLayout(scan)
  const items = scan.skills.map((skill) => toListItem(skill, input.installedDirNames))

  if (layout === 'none') return { kind: 'empty' }
  if (layout === 'solo') return { kind: 'solo', skill: items[0] }
  if (layout === 'flat') return { kind: 'flat', items }

  const groups = deriveGroupTabs(scan)

  if (layout === 'grouped') {
    // An unknown or stale group falls back to the default rather than rendering
    // an empty pane the user cannot explain.
    const activeGroup =
      input.activeGroup && groups.some((group) => group.name === input.activeGroup)
        ? input.activeGroup
        : defaultGroup(groups)
    return {
      kind: 'grouped',
      groups,
      activeGroup,
      items: items.filter((item) => item.group === activeGroup),
    }
  }

  // Search-first: empty until asked. Nobody reads 103 rows, and rendering them
  // was the specific complaint against the first draft.
  const query = input.query.trim()
  if (query.length > 0) {
    const matched = matchSkills(items, query)
    return {
      kind: 'search',
      groups,
      activeGroup: null,
      query: input.query,
      items: matched,
      prompt: matched.length === 0 ? `Nothing matches “${query}”.` : null,
    }
  }
  const activeGroup =
    input.activeGroup && groups.some((group) => group.name === input.activeGroup) ? input.activeGroup : null
  if (activeGroup) {
    return {
      kind: 'search',
      groups,
      activeGroup,
      query: '',
      items: items.filter((item) => item.group === activeGroup),
      prompt: null,
    }
  }
  return {
    kind: 'search',
    groups,
    activeGroup: null,
    query: '',
    items: [],
    prompt: groups.length > 0 ? 'Pick a category, or search.' : `Search these ${scan.skills.length} skills.`,
  }
}

function toListItem(skill: ScannedSkill, installedDirNames: ReadonlySet<string>): SkillListItem {
  return {
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    group: skill.group,
    fileCount: skill.files.length,
    hasExecutables: skill.hasExecutables,
    // Installs land in one directory per skill name, so a directory of that
    // name in the workspace is what "installed" means to the agent that reads
    // it — the same identity the installer writes and would overwrite.
    installed: installedDirNames.has(skillDirName(skill.id)),
  }
}

/**
 * The group a source opens on: its largest. Group names arrive sorted, so
 * taking the first would open `mattpocock/skills` on `deprecated` — four
 * abandoned skills as the first thing anyone sees of a source of 41.
 */
function defaultGroup(groups: readonly SkillGroupTab[]): string {
  return groups.reduce<SkillGroupTab | null>(
    (largest, group) => (largest === null || group.count > largest.count ? group : largest),
    null,
  )?.name ?? ''
}

export function deriveGroupTabs(scan: ScanResult): SkillGroupTab[] {
  return scan.groups.map((name) => ({
    name,
    label: skillGroupLabel(name),
    count: scan.skills.filter((skill) => skill.group === name).length,
  }))
}

/** `social-listening` → `Social listening`; names the source already cased, or
 *  synthetic ones like `(repo root)`, are left exactly as the source wrote them. */
export function skillGroupLabel(name: string): string {
  const first = name.charAt(0)
  if (first === '' || first === '(' || first !== first.toLowerCase()) return name
  const spaced = name.replace(/-/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function matchSkills(items: readonly SkillListItem[], query: string): SkillListItem[] {
  const needle = query.toLowerCase()
  return items.filter((item) =>
    `${item.name} ${item.description} ${item.group} ${item.skillId}`.toLowerCase().includes(needle),
  )
}

export function findSkill(scan: ScanResult, skillId: string): ScannedSkill | null {
  return scan.skills.find((skill) => skill.id === skillId) ?? null
}

// ── Installing ───────────────────────────────────────────────────────────────

export type SkillInstallAvailability = {
  enabled: boolean
  /** Shown beside the disabled control. Null when the reason is self-evident. */
  reason: string | null
}

/**
 * Sources are app-level; installing is workspace-level. The Extensions door can
 * be open with no workspace, and there Install is disabled WITH its reason —
 * never a control that silently does nothing.
 */
export function deriveInstallAvailability(
  workspaceRoot: string | null,
  selectedCount: number,
): SkillInstallAvailability {
  if (!workspaceRoot) {
    return {
      enabled: false,
      reason: 'Open a workspace to install skills — a skill installs into a workspace, not into the app.',
    }
  }
  if (selectedCount === 0) return { enabled: false, reason: null }
  return { enabled: true, reason: null }
}

export type SkillInstallFailure = { skillId: string; message: string }

/** One sentence for what a batch install actually did, failures named. */
export function summarizeInstallRun(installed: number, failures: readonly SkillInstallFailure[]): string {
  const total = installed + failures.length
  if (failures.length === 0) return `Installed ${pluralSkills(installed)}.`
  if (installed === 0) {
    return failures.length === 1
      ? `${skillDirName(failures[0].skillId)} did not install: ${failures[0].message}`
      : `None of the ${total} skills installed. ${failures[0].message}`
  }
  return `Installed ${installed} of ${total}. ${skillDirName(failures[0].skillId)} did not install: ${failures[0].message}`
}

// ── Header facts ─────────────────────────────────────────────────────────────

/** The pinned commit, short. '' for a source with no git identity. */
export function shortCommit(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha
}

/** File size for the reader's file list. Bytes below 1 KiB stay bytes. */
export function formatSkillFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const kib = bytes / 1024
  if (kib < 1024) return `${kib < 100 ? kib.toFixed(1) : Math.round(kib)} KB`
  const mib = kib / 1024
  return `${mib < 100 ? mib.toFixed(1) : Math.round(mib)} MB`
}

/**
 * The facts a source header can state under its name, without inventing any.
 * The repository is the header's title, so it is not repeated here.
 */
export function describeSourceMeta(source: SkillSource, load: SkillScanLoad | undefined): string[] {
  const parts: string[] = []
  if (load && load.status === 'ready') {
    parts.push(pluralSkills(load.scan.skills.length))
    parts.push(`${load.scan.fileCount} file${load.scan.fileCount === 1 ? '' : 's'}`)
  }
  const commit = shortCommit(source.commitSha)
  if (commit) parts.push(commit)
  return parts
}
