// The roadmap object: the data/logic substrate an orchestrator (MC-1619) walks.
// A roadmap is a `backlog/roadmaps/<name>.md` file — frontmatter policies plus a
// human-readable body whose markdown sections are lanes and whose list entries
// reference backlog files (`backlog/foo.md`) or epics (`backlog/epics/bar.md`).
// This module is the orchestrator's CONTRACT: format, discovery, parse/validate,
// and the pure eligibility function. It adds NO orchestration behavior — it is
// inert until MC-1619 consumes it.
//
// INSTANCE-GLOBAL model (MC-1688): a single roadmap per Multicode may reference
// backlog items from ANY project the instance knows. Frontmatter carries a
// `projects:` alias map (`alias -> absolute project root`); an entry ref is either
// unqualified (`backlog/foo.md` — the HOME project that owns the roadmap file) or
// alias-qualified (`mobile:backlog/foo.md`). Unqualified refs keep every existing
// single-project roadmap valid with no ref migration (D2). A project key is the
// alias, or `null` for the home project; `(projectKey, relativePath)` is the item
// identity, and `qualifiedRef` renders it to the string key the graph edges,
// run-links, and lane runtime use.
//
// Node-free by construction (tsconfig.web-safe): it must never import from
// src/main, and — because src/shared cannot import renderer types either — it
// re-uses only the shared status payload union (BacklogItemStatusPayload) and the
// shared frontmatter helper. The renderer read model
// (BacklogItem, backlogDependencies.ts) and the MC-1617 epic roll-up
// (backlogLinks.ts nextBacklogItemStatusFromLinks) live in src/renderer and
// cannot be imported here; the two contracts this module mirrors are called out
// where they are re-implemented so the pair stays aligned:
//   - dependency resolution === backlogDependencies.ts RESOLVED_STATUSES
//     (a prerequisite is resolved once completed or archived);
//   - an epic entry derives from its members (MC-1617): the entry is terminal
//     only when every member is terminal. Membership itself is the Backlog's own
//     stored-up/derived-down rule (each child's `epic:` slug), resolved live by
//     epicMemberLookup — a horizon stores no membership of its own (MC-2031).

import {
  parseBacklogFrontmatter,
  serializeBacklogFrontmatterFields,
  type BacklogFrontmatterUpdates,
} from './frontmatter'
import type { BacklogItemStatusPayload, SprintEngineCliPermissionPreset } from '../electron-api'
import { normalizeCliPermissionPreset } from '../sprintengine/automation-lifecycle'

// The frontmatter `type:` value that marks a file as a roadmap. Deliberately NOT
// added to the closed `BacklogTypePayload`/`BacklogType` unions: the renderer read
// model keeps roadmap an OKF-tolerated leaf (`rawType`), and the main-process
// listing tags it with an `isRoadmap` flag rather than the closed type field
// (src/main/backlog-service.ts). Roadmaps live only under `ROADMAPS_DIR_PREFIX`.
export const ROADMAP_TYPE = 'roadmap'
export const ROADMAPS_DIR_PREFIX = 'backlog/roadmaps/'
const EPICS_DIR_PREFIX = 'backlog/epics/'
const BACKLOG_DIR_PREFIX = 'backlog/'

// The project a ref resolves to: an alias string, or `null` for the home project
// (the project whose repo holds the roadmap file). The home project is always
// resolvable; an alias is resolvable only when the driver can map it to a known
// workspace root.
export type ProjectKey = string | null

// One `projects:` frontmatter entry: an alias and the absolute project root it
// names. Absolute paths are machine-specific by design (D2) and repairable — an
// alias whose path is not among the known roots parks the lane `unknown_project`,
// never a silent drop.
export type RoadmapProjectAlias = { alias: string; path: string }

// A roadmap's execution policy, all frontmatter scalars with V1 defaults.
export type RoadmapAdvancePolicy = 'approve' | 'auto'
export type RoadmapMergePolicy = 'manual' | 'auto'
export type RoadmapPolicy = {
  // Whether advancing to the next lane entry waits on human approval or proceeds
  // automatically. Default 'approve' — the conservative gate.
  advance: RoadmapAdvancePolicy
  // Whether a delivered entry's PR is merged by a human or automatically. Default
  // 'manual' — merging is a human call (see sprint-engine-pull-requests).
  merge: RoadmapMergePolicy
  // How many lanes may be actively executing per repo at once. Default 1.
  // NOTE: parsed, validated and preserved, but the orchestrator does NOT honor
  // this yet — it serializes to one active run per repo (see reconcileRoadmap's
  // repoBusy guard). Real per-repo concurrency is a separate backlog item; until
  // then the editor shows no control for it.
  concurrency: number
  // The saved ROSTER name every sprint this roadmap starts is staffed
  // with. Unset = the user's last-used roster (the sprint.create default). An
  // unknown name fails the start explicitly, never a silent fallback roster.
  roster?: string
  // The agent RUNTIME a plain-agents (no-roster) sprint launches on, spelled
  // `cli` or `cli/model` (e.g. `claude-code` or `claude-code/claude-opus-5`;
  // the model may itself contain `/`, so only the FIRST slash splits — see
  // parseAgentRuntime). Unset = the stock default (claude-code). MC-2145: this
  // is what lets a horizon say which agent runs it. A roster step ignores it —
  // the roster carries its own per-role runtimes.
  agent?: string
  // The CLI permission preset every sprint this roadmap starts spawns its agents
  // with. Unset = bypass (see resolveRoadmapPermissionPreset). A horizon runs
  // unwatched by definition, so a gated preset stalls it on the first tool call.
  permissions?: SprintEngineCliPermissionPreset
}

export const DEFAULT_ROADMAP_POLICY: RoadmapPolicy = {
  advance: 'approve',
  merge: 'manual',
  concurrency: 1,
}

// Canonical spellings plus the pre-MC-2210 ones. A roadmap file written before
// the rename still says `bypass_all`, and refusing it would fail a horizon whose
// policy has not changed; `normalizeCliPermissionPreset` maps it on read.
const PERMISSION_PRESETS: ReadonlySet<string> = new Set<string>([
  'none',
  'manual',
  'auto',
  'bypass',
  'default',
  'auto_workspace',
  'bypass_all',
])

export function isRoadmapPermissionPreset(value: string | undefined): value is SprintEngineCliPermissionPreset {
  return value !== undefined && PERMISSION_PRESETS.has(value)
}

// The preset a horizon-started sprint spawns its agents with (MC-1900). An UNSET
// policy means bypass, not 'default': the whole point of a long-horizon run is
// that nobody is watching, and a gated agent sits blocked on its first tool call
// with no one to answer (owner ruling 2026-07-26, from a live failure).
//
// The one place this default is applied — the orchestrator and the MCP tools both
// call it, so what `horizon_status` reports and what a launch actually spawns
// cannot drift. An explicit non-bypass preset in the file is honored verbatim.
export function resolveRoadmapPermissionPreset(
  policy: Pick<RoadmapPolicy, 'permissions'>,
): SprintEngineCliPermissionPreset {
  // An unset policy still means bypass. A set one is normalized rather than
  // returned raw: `isRoadmapPermissionPreset` accepts the pre-MC-2210 spellings
  // so an unedited roadmap file keeps working, and this is where they resolve.
  if (policy.permissions === undefined) return 'bypass'
  return normalizeCliPermissionPreset(policy.permissions)
}

// One list entry in a lane. `item` and `epic` are decided by the reference path
// shape at parse time; `unknown` is assigned by validateRoadmap when the ref
// names no known backlog file (surfaced, never silently dropped — Fallback
// Discipline). An epic entry is a BARE reference (MC-2031): its members resolve
// live from `epic:` membership on every read, so a child added mid-flight is a
// member the moment it exists and there is no stored set to reconcile.
export type RoadmapEntryKind = 'item' | 'epic' | 'unknown'

export type RoadmapEntry = {
  kind: RoadmapEntryKind
  // The raw authored reference, verbatim (byte-stable render key), e.g.
  // 'backlog/foo.md' or 'mobile:backlog/epics/auth.md'. Normalized (forward
  // slashes, no leading slash) but keeps its `alias:` prefix.
  ref: string
  // The project the ref resolves to: an alias, or `null` for the home project.
  projectKey: ProjectKey
  // The project-relative backlog path with any `alias:` prefix stripped, e.g.
  // 'backlog/foo.md'. This is the path within `projectKey`'s root.
  relativePath: string
  // The saved ROSTER name this step overrides the roadmap-wide policy with,
  // authored as a trailing ` @roster=<name>` annotation on the entry line.
  // Undefined = inherit (see resolveEntryRoster).
  roster?: string
  // The agent RUNTIME this step overrides the roadmap-wide `agent:` with,
  // authored as a ` @agent=<cli[/model]>` annotation. Undefined = inherit
  // (see resolveEntryAgent). Meaningful only for a plain-agents step.
  agent?: string
}

// The trailing per-step staffing annotation. Roster names contain spaces
// ('General agents', 'Mobile UI'), so the name runs to end-of-line rather than
// being whitespace-delimited:
//   entry-line := "- " ref ( ws+ "@roster=" roster-name )? EOL
// The ref itself is still `split(/\s+/)[0]`, so ref handling is untouched and a
// build without this feature reads the same plan and merely ignores staffing.
const ROSTER_ANNOTATION_PREFIX = '@roster='

// The per-step agent annotation (MC-2145). Unlike a roster NAME, a runtime
// token never contains whitespace, so it is whitespace-delimited and may sit
// before or after `@roster=` on the line — the parser extracts it first, so a
// to-end-of-line roster name still reads correctly. The canonical render order
// is `@agent=` then `@roster=` for exactly that reason.
const AGENT_ANNOTATION_PREFIX = '@agent='

export type RoadmapLane = {
  // The lane heading text (the `## ` line), verbatim.
  title: string
  entries: RoadmapEntry[]
}

// A structural problem found while parsing the body, surfaced rather than thrown
// so a malformed roadmap still parses into the best-effort model the UI can show.
export type RoadmapParseIssue = {
  // 1-based line number within the body (frontmatter excluded); 0 for
  // frontmatter-level issues (unknown/duplicate alias) that have no body line.
  line: number
  kind:
    | 'entry_before_lane'
    | 'unparseable_entry'
    // An entry (or child) uses an `alias:` prefix that the frontmatter
    // `projects:` map does not define — the lane cannot resolve a project.
    | 'unknown_alias'
    // The `projects:` map declares the same alias more than once.
    | 'duplicate_alias'
    // A `@roster=` annotation with nothing after the `=`. Surfaced rather than
    // read as "inherit", so a truncated edit is visible instead of silent.
    | 'empty_roster'
    // A `@agent=` annotation with nothing after the `=` — same rule.
    | 'empty_agent'
  message: string
}

export type Roadmap = {
  // Parsed frontmatter policy scalars.
  policy: RoadmapPolicy
  // The `projects:` alias map, in authored order (duplicates preserved so
  // validation can flag them). Empty for a single-project (home-only) roadmap.
  projects: RoadmapProjectAlias[]
  // Frontmatter `status:` when a valid lifecycle status, else undefined.
  status?: BacklogItemStatusPayload
  // Frontmatter `id:` integer when present and parseable.
  numericId?: number
  // The roadmap title: the first body `# Heading`, else undefined.
  title?: string
  lanes: RoadmapLane[]
  // The markdown body with frontmatter stripped, preserved byte-for-byte. The
  // canonical write path only ever edits frontmatter scalars through
  // serializeBacklogFrontmatterFields, so a policy change leaves this untouched
  // (backlog-service precedent). renderRoadmapBody re-emits an equivalent body
  // for the authoring UI (T4), which owns structural body edits.
  body: string
  issues: RoadmapParseIssue[]
}

export function isRoadmapRelativePath(pathValue: string): boolean {
  return normalizeRef(pathValue).startsWith(ROADMAPS_DIR_PREFIX)
}

// True when a parsed backlog file is a roadmap: either it lives in the roadmaps
// directory or it declares `type: roadmap`. Mirrors the epic dual-signal test in
// backlog-service.ts (path prefix OR frontmatter type).
export function isRoadmapContent(relativePath: string, frontmatterType: string | undefined): boolean {
  return isRoadmapRelativePath(relativePath) || frontmatterType === ROADMAP_TYPE
}

// The stable per-item slug = the file's name stem, independent of its directory
// (and of any `alias:` prefix). Mirrors backlogItemSlugFromPath
// (src/renderer/src/utils/backlog.ts) — the key the `dependsOn:` and `epic:`
// pointers reference — re-spelled here to stay node-free and renderer-free.
export function roadmapRefSlug(ref: string): string {
  const relativePath = splitAliasRef(ref).relativePath
  const name = relativePath.split('/').filter(Boolean).at(-1) ?? relativePath
  return name.replace(/\.(md|html?)$/i, '')
}

// The graph/runtime identity of a resolved reference: the project key joined to
// the project-relative path. Home = `':backlog/foo.md'`; alias =
// `'mobile:backlog/foo.md'`. Unique across projects (an alias can never contain
// `:`), so two same-named items in different projects never collide, and a lane's
// edges, run-links, and active handle all key off this one string.
export function qualifiedRef(projectKey: ProjectKey, relativePath: string): string {
  return `${projectKey ?? ''}:${relativePath}`
}

// The inverse of `qualifiedRef`: split an identity key back into its project key
// (empty prefix = the home project, null) and its project-relative path. Used by
// the driver to map a persisted lane handle to a project root + backlog file.
export function splitQualifiedRef(key: string): { projectKey: ProjectKey; relativePath: string } {
  const colon = key.indexOf(':')
  if (colon < 0) return { projectKey: null, relativePath: key }
  const alias = key.slice(0, colon)
  return { projectKey: alias.length > 0 ? alias : null, relativePath: key.slice(colon + 1) }
}

function normalizeRef(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

// Split an authored ref into its optional `alias:` prefix and the project-relative
// path. An alias is the token before the first colon WHEN that colon precedes any
// slash — a backlog path (`backlog/...`) never carries a colon, so a leading
// `alias:` is unambiguous. No colon (or a colon inside the path) → home project.
function splitAliasRef(rawRef: string): { alias: string | null; relativePath: string } {
  const normalized = rawRef.replace(/\\/g, '/').replace(/^\/+/, '').trim()
  const colon = normalized.indexOf(':')
  const slash = normalized.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash) && ALIAS_TOKEN_RE.test(normalized.slice(0, colon))) {
    return { alias: normalized.slice(0, colon), relativePath: normalizeRef(normalized.slice(colon + 1)) }
  }
  return { alias: null, relativePath: normalizeRef(normalized) }
}

const ALIAS_TOKEN_RE = /^[A-Za-z0-9._-]+$/

// Resolve an authored ref against an inherited project (the home project for a
// top-level entry) and the set of aliases the frontmatter declares. An alias not
// in the map still resolves to
// that alias key (so the lane parks `unknown_project` downstream, never drops) but
// is flagged so the author sees an `unknown_alias` issue.
function resolveRef(
  rawRef: string,
  inherited: ProjectKey,
  knownAliases: ReadonlySet<string>,
): { ref: string; projectKey: ProjectKey; relativePath: string; unknownAlias: boolean } {
  const { alias, relativePath } = splitAliasRef(rawRef)
  if (alias === null) {
    return { ref: normalizeRef(rawRef), projectKey: inherited, relativePath, unknownAlias: false }
  }
  return {
    ref: normalizeRef(rawRef),
    projectKey: alias,
    relativePath,
    unknownAlias: !knownAliases.has(alias),
  }
}

// A backlog reference is one that points into the backlog tree at a source file.
// Applied to the project-relative path (alias prefix already stripped).
function looksLikeBacklogRef(relativePath: string): boolean {
  return relativePath.startsWith(BACKLOG_DIR_PREFIX) && /\.(md|html?)$/i.test(relativePath)
}

function entryKindForRelativePath(relativePath: string): Exclude<RoadmapEntryKind, 'unknown'> {
  return relativePath.startsWith(EPICS_DIR_PREFIX) ? 'epic' : 'item'
}

// Split a list item's content (everything after `- `) into its ref token and
// any trailing annotations. `present` distinguishes an absent annotation from
// an empty one, so `@roster=`/`@agent=` with no value raises its issue instead
// of silently reading as inherit. Any OTHER trailing text is ignored exactly as
// it was before annotations existed — the parser has always kept only the first
// token, and tightening that here would turn hand-authored notes into issues.
//
// `@agent=` is extracted FIRST, from anywhere in the remainder: its token never
// contains whitespace, while a roster NAME runs to end-of-line — so this order
// is what lets `@roster=Mobile UI @agent=codex` read both correctly.
function splitEntryAnnotations(content: string): {
  rosterPresent: boolean
  roster: string
  agentPresent: boolean
  agent: string
} {
  const firstToken = content.split(/\s+/)[0]
  let remainder = content.slice(firstToken.length).trim()
  let agentPresent = false
  let agent = ''
  const agentMatch = /(?:^|\s)@agent=(\S*)/.exec(remainder)
  if (agentMatch) {
    agentPresent = true
    agent = agentMatch[1]
    remainder = `${remainder.slice(0, agentMatch.index)} ${remainder.slice(agentMatch.index + agentMatch[0].length)}`.trim()
  }
  if (!remainder.startsWith(ROSTER_ANNOTATION_PREFIX)) {
    return { rosterPresent: false, roster: '', agentPresent, agent }
  }
  return {
    rosterPresent: true,
    roster: remainder.slice(ROSTER_ANNOTATION_PREFIX.length).trim(),
    agentPresent,
    agent,
  }
}

// The one place the two staffing tiers are combined: a step's own roster wins
// over the roadmap-wide policy roster, and `undefined` means the built-in
// default is used downstream. Both the Horizon rows (MC-1882) and the
// orchestrator (MC-1883) call this — neither re-derives the fallback, so what a
// row displays and what a launch staffs cannot drift.
//
// Structurally typed rather than taking the full `RoadmapEntry`/`RoadmapPolicy`
// so a UI holding only a draft's roster fields still resolves through this
// function instead of open-coding a `??` chain.
export function resolveEntryRoster(
  entry: Pick<RoadmapEntry, 'roster'>,
  policy: Pick<RoadmapPolicy, 'roster'>,
): string | undefined {
  const entryRoster = entry.roster?.trim()
  if (entryRoster) return entryRoster
  const policyRoster = policy.roster?.trim()
  return policyRoster ? policyRoster : undefined
}

// The agent tier, combined with the same precedence and for the same reason:
// the step's `@agent=` wins over the roadmap's `agent:`, and `undefined` means
// the stock default downstream (claude-code today). One resolver, called by the
// Team band and the orchestrator both, so what the band shows and what a start
// launches cannot drift (MC-2145).
export function resolveEntryAgent(
  entry: Pick<RoadmapEntry, 'agent'>,
  policy: Pick<RoadmapPolicy, 'agent'>,
): string | undefined {
  const entryAgent = entry.agent?.trim()
  if (entryAgent) return entryAgent
  const policyAgent = policy.agent?.trim()
  return policyAgent ? policyAgent : undefined
}

/** Split an authored runtime token into its CLI and optional model. Only the
 *  FIRST slash splits, because model ids may themselves contain slashes
 *  (`openrouter/x`): `claude-code/claude-opus-5` → cli `claude-code`, model
 *  `claude-opus-5`; a bare `codex` → cli `codex`, no model. */
export function parseAgentRuntime(token: string): { cli: string; model?: string } {
  const trimmed = token.trim()
  const slash = trimmed.indexOf('/')
  if (slash < 0) return { cli: trimmed }
  const model = trimmed.slice(slash + 1)
  return { cli: trimmed.slice(0, slash), ...(model ? { model } : {}) }
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

// Parse a roadmap file into its policy, projects map, lanes, and preserved body.
// Never throws: a body that breaks the entry/lane grammar still yields the
// best-effort lanes it could recover plus a structured issue per offending line.
export function parseRoadmap(content: string): Roadmap {
  const { fields, body } = parseBacklogFrontmatter(content)
  const policy = parseRoadmapPolicy(fields)
  const status = isBacklogStatus(fields.status) ? fields.status : undefined
  const numericId = parseNumericId(fields.id)

  const frontmatterBlock = FRONTMATTER_RE.exec(content)?.[1] ?? ''
  const projects = parseRoadmapProjectAliases(frontmatterBlock)
  const knownAliases = new Set(projects.map((project) => project.alias))

  const lanes: RoadmapLane[] = []
  const issues: RoadmapParseIssue[] = []
  addDuplicateAliasIssues(projects, issues)
  let title: string | undefined
  let currentLane: RoadmapLane | null = null

  const lines = body.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const lineNumber = index + 1

    const heading = /^(#{1,6})\s+(.*)$/.exec(rawLine)
    if (heading) {
      const level = heading[1].length
      const text = heading[2].trim()
      if (level === 1) {
        if (title === undefined) title = text
      } else if (level === 2) {
        // Only `##` starts a lane. Deeper headings (`###` notes) are left as
        // opaque body prose so a hand-authored subsection is not a spurious lane.
        currentLane = { title: text, entries: [] }
        lanes.push(currentLane)
      }
      continue
    }

    const listItem = /^(\s*)-\s+(.*\S)\s*$/.exec(rawLine)
    if (!listItem) continue
    const indent = listItem[1].replace(/\t/g, '  ').length
    const rawToken = normalizeRef(listItem[2].split(/\s+/)[0])
    const annotation = splitEntryAnnotations(listItem[2])

    // A pre-MC-2031 plan stored an epic's members as indented lines beneath it.
    // Membership is now derived from live `epic:` frontmatter, so such a line is
    // read and IGNORED — never an error, and dropped by the next structural
    // write (renderRoadmapBody emits none). No on-disk migration exists or is
    // needed. Indentation is also how a hand-authored sub-list is written, and
    // neither shape means anything to the plan any more.
    if (indent >= 2) continue

    // A top-level list item is a lane entry.
    if (!currentLane) {
      issues.push({ line: lineNumber, kind: 'entry_before_lane', message: `Entry "${rawToken}" appears before any lane heading.` })
      continue
    }
    const resolved = resolveRef(rawToken, null, knownAliases)
    if (!looksLikeBacklogRef(resolved.relativePath)) {
      issues.push({ line: lineNumber, kind: 'unparseable_entry', message: `List item "${listItem[2]}" is not a backlog reference.` })
      continue
    }
    if (resolved.unknownAlias) {
      issues.push({ line: lineNumber, kind: 'unknown_alias', message: `Entry "${rawToken}" uses an undefined project alias.` })
    }
    if (annotation.rosterPresent && annotation.roster === '') {
      issues.push({ line: lineNumber, kind: 'empty_roster', message: `Entry "${rawToken}" has an empty @roster= annotation.` })
    }
    if (annotation.agentPresent && annotation.agent === '') {
      issues.push({ line: lineNumber, kind: 'empty_agent', message: `Entry "${rawToken}" has an empty @agent= annotation.` })
    }
    currentLane.entries.push({
      kind: entryKindForRelativePath(resolved.relativePath),
      ref: resolved.ref,
      projectKey: resolved.projectKey,
      relativePath: resolved.relativePath,
      ...(annotation.roster ? { roster: annotation.roster } : {}),
      ...(annotation.agent ? { agent: annotation.agent } : {}),
    })
  }

  return { policy, projects, status, numericId, title, lanes, body, issues }
}

// Parse the `projects:` frontmatter map. Supports the nested block form
// (`projects:` then indented `alias: /path` lines) and the inline form
// (`projects: { alias: /path, ... }`). Values are absolute project roots. Order
// and duplicates are preserved so validation can flag a repeated alias.
function parseRoadmapProjectAliases(frontmatterBlock: string): RoadmapProjectAlias[] {
  const lines = frontmatterBlock.split(/\r?\n/)
  const aliases: RoadmapProjectAlias[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const header = /^projects\s*:\s*(.*)$/i.exec(line)
    if (!header) continue
    const inline = header[1].trim()
    if (inline.startsWith('{')) {
      const inner = inline.replace(/^\{/, '').replace(/\}\s*$/, '')
      for (const pair of inner.split(',')) {
        const kv = /^\s*([A-Za-z0-9._-]+)\s*:\s*(.+?)\s*$/.exec(pair)
        if (kv) aliases.push({ alias: kv[1], path: stripInlineQuotes(kv[2]) })
      }
      return aliases
    }
    // Block form: read subsequent indented `alias: path` lines until a dedent.
    for (let child = index + 1; child < lines.length; child += 1) {
      const childLine = lines[child]
      if (childLine.trim() === '') continue
      const kv = /^(\s+)([A-Za-z0-9._-]+)\s*:\s*(.+)$/.exec(childLine)
      if (!kv) break
      aliases.push({ alias: kv[2], path: stripInlineQuotes(kv[3].trim()) })
    }
    return aliases
  }
  return aliases
}

function stripInlineQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1)
  }
  return trimmed
}

function addDuplicateAliasIssues(projects: RoadmapProjectAlias[], issues: RoadmapParseIssue[]): void {
  const seen = new Set<string>()
  const reported = new Set<string>()
  for (const project of projects) {
    if (seen.has(project.alias) && !reported.has(project.alias)) {
      reported.add(project.alias)
      issues.push({ line: 0, kind: 'duplicate_alias', message: `Project alias "${project.alias}" is declared more than once.` })
    }
    seen.add(project.alias)
  }
}

function parseRoadmapPolicy(fields: Record<string, string>): RoadmapPolicy {
  const advance = fields.advance === 'auto' ? 'auto' : 'approve'
  const merge = fields.merge === 'auto' ? 'auto' : 'manual'
  const concurrency = parsePositiveInt(fields.concurrency) ?? DEFAULT_ROADMAP_POLICY.concurrency
  const roster = fields.roster?.trim()
  const agent = fields.agent?.trim()
  // An unrecognised `permissions:` value is dropped rather than trusted, so a
  // typo reads as "unset" (= bypass) instead of resolving to some third thing.
  const permissions = fields.permissions?.trim()
  return {
    advance,
    merge,
    concurrency,
    ...(roster ? { roster } : {}),
    ...(agent ? { agent } : {}),
    ...(isRoadmapPermissionPreset(permissions) ? { permissions } : {}),
  }
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

function parseNumericId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

const BACKLOG_STATUSES: ReadonlySet<string> = new Set<BacklogItemStatusPayload>([
  'idea',
  'ready',
  'in_progress',
  'needs_input',
  'completed',
  'archived',
])

function isBacklogStatus(value: string | undefined): value is BacklogItemStatusPayload {
  return value !== undefined && BACKLOG_STATUSES.has(value)
}

// ---------------------------------------------------------------------------
// Frontmatter edits (canonical write path — body byte-stable)
// ---------------------------------------------------------------------------

// Edit a roadmap's policy scalars in place, preserving the body byte-for-byte.
// A thin, validating wrapper over serializeBacklogFrontmatterFields (the same
// serializer the Backlog service writes through), so a policy toggle never
// perturbs the lanes. Only the fields present in `updates` are touched.
export function setRoadmapPolicy(content: string, updates: Partial<RoadmapPolicy>): string {
  const frontmatterUpdates: BacklogFrontmatterUpdates = {}
  if (updates.advance !== undefined) frontmatterUpdates.advance = updates.advance
  if (updates.merge !== undefined) frontmatterUpdates.merge = updates.merge
  if (updates.concurrency !== undefined) {
    if (!Number.isInteger(updates.concurrency) || updates.concurrency < 1) {
      throw new Error(`Roadmap concurrency must be a positive integer, got ${updates.concurrency}.`)
    }
    frontmatterUpdates.concurrency = String(updates.concurrency)
  }
  // Key presence (not definedness) decides: `{ roster: undefined }` clears the
  // frontmatter scalar, an absent key leaves it untouched.
  if ('roster' in updates) frontmatterUpdates.roster = updates.roster?.trim() ? updates.roster.trim() : null
  if ('agent' in updates) frontmatterUpdates.agent = updates.agent?.trim() ? updates.agent.trim() : null
  if ('permissions' in updates) {
    if (updates.permissions !== undefined && !isRoadmapPermissionPreset(updates.permissions)) {
      throw new Error(`Roadmap permissions must be default, auto_workspace or bypass_all, got ${updates.permissions}.`)
    }
    frontmatterUpdates.permissions = updates.permissions ?? null
  }
  return serializeBacklogFrontmatterFields(content, frontmatterUpdates)
}

// Write the `projects:` alias map into the frontmatter as a nested block,
// preserving every other frontmatter key/line and the body byte-for-byte. The
// authoring UI (T3) calls this when a project's first item is dragged in. Emitting
// an empty map removes the block entirely. Rewriting an unchanged map is a no-op
// (byte-identical), so a re-save never churns the file. The nested block is the
// form parseRoadmapProjectAliases reads and serializeBacklogFrontmatterFields
// leaves untouched (it only edits top-level scalars).
export function setRoadmapProjects(content: string, projects: ReadonlyArray<RoadmapProjectAlias>): string {
  const match = FRONTMATTER_RE.exec(content)
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const blockLines = renderProjectsBlock(projects, eol)

  if (!match) {
    if (projects.length === 0) return content
    return `---${eol}${blockLines}${eol}---${eol}${content}`
  }

  // Drop any existing `projects:` header line plus its indented children, then
  // splice the fresh block in the same position (or at the end if it was absent).
  const originalLines = match[1].split(/\r?\n/)
  const kept: string[] = []
  let insertAt = -1
  for (let index = 0; index < originalLines.length; index += 1) {
    const line = originalLines[index]
    if (/^projects\s*:/i.test(line)) {
      insertAt = kept.length
      // Skip the header and, for the block form, its indented children.
      while (index + 1 < originalLines.length && /^\s+\S/.test(originalLines[index + 1])) index += 1
      continue
    }
    kept.push(line)
  }

  if (projects.length > 0) {
    const blockArray = blockLines.split(eol)
    const at = insertAt >= 0 ? insertAt : kept.length
    kept.splice(at, 0, ...blockArray)
  }

  const body = content.slice(match[0].length)
  if (!kept.some((line) => line.trim().length > 0)) return body
  const closeTrailing = /\r?\n$/.test(match[0]) ? eol : ''
  const next = `---${eol}${kept.join(eol)}${eol}---${closeTrailing}${body}`
  return next === content ? content : next
}

function renderProjectsBlock(projects: ReadonlyArray<RoadmapProjectAlias>, eol: string): string {
  if (projects.length === 0) return ''
  const lines = ['projects:']
  for (const project of projects) lines.push(`  ${project.alias}: ${project.path}`)
  return lines.join(eol)
}

// ---------------------------------------------------------------------------
// Render (canonical body serializer — for the authoring UI, T4)
// ---------------------------------------------------------------------------

// Re-emit a roadmap's body in canonical form from its lane model. Structural
// edits (reorder, lane split/merge, add/remove entries) round-trip through this;
// parse(renderRoadmapBody(...)) reproduces the same lanes/entries. The stored
// file's body is preserved verbatim on frontmatter-only edits (setRoadmapPolicy);
// this serializer is what T4 writes when the STRUCTURE changes. Entry refs keep
// their `alias:` prefix (`entry.ref`), so a project-qualified plan round-trips.
export function renderRoadmapBody(roadmap: Pick<Roadmap, 'title' | 'lanes'>): string {
  const out: string[] = []
  if (roadmap.title) {
    out.push(`# ${roadmap.title}`, '')
  }
  roadmap.lanes.forEach((lane, laneIndex) => {
    if (laneIndex > 0) out.push('')
    out.push(`## ${lane.title}`)
    for (const entry of lane.entries) {
      // Two spaces before `@` keep the ref visually separate on the line. An
      // entry without annotations emits exactly what it did before they
      // existed — no trailing whitespace, so an un-staffed file is byte-stable.
      // `@agent=` renders BEFORE `@roster=` because the roster name runs to
      // end-of-line while the agent token is whitespace-delimited.
      const roster = entry.roster?.trim()
      const agent = entry.agent?.trim()
      let line = `- ${entry.ref}`
      if (agent) line += `  ${AGENT_ANNOTATION_PREFIX}${agent}`
      if (roster) line += `  ${ROSTER_ANNOTATION_PREFIX}${roster}`
      out.push(line)
    }
  })
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

export type RoadmapValidation = {
  // Entry/child references that name no known backlog file, in first-seen order
  // (raw refs, matching entry.ref). Surfaced as "unknown", never dropped, so the
  // author can clear a stale entry instead of the roadmap silently reading
  // complete.
  danglingRefs: string[]
  // Refs that sit on at least one cycle across roadmap-order edges and dependsOn
  // edges combined — an author error (something must run before itself).
  cycleRefs: string[]
  // Parse issues carried through from parseRoadmap, plus any validation notes.
  issues: RoadmapParseIssue[]
  hasCycle: boolean
}

// The minimal item state validate/eligibility read off each referenced backlog
// item — a structural subset both the renderer read model (BacklogItem) and the
// main-process listing satisfy, so callers adapt without importing this module's
// internals. `ref` is the project-relative path; `projectKey` is its project
// (omitted/undefined = the home project). `dependsOn` are prerequisite slugs
// (filename stems), matching the frontmatter axis and resolved within the same
// project.
export type RoadmapItemState = {
  ref: string
  status: BacklogItemStatusPayload
  dependsOn?: string[]
  projectKey?: ProjectKey
  // The slug of the epic this item is a member of (frontmatter `epic:`). Epic
  // membership is stored UP on the child and derived down, so this is the ONLY
  // membership axis a horizon reads: an epic step is a bare reference whose
  // members resolve from the live item universe on every read.
  epic?: string
}

const itemProjectKey = (item: RoadmapItemState): ProjectKey => item.projectKey ?? null

// The graph/runtime identity of a backlog item in the universe — the SAME key a
// lane unit, a run link and a persisted lane handle use. One definition, so a
// member's key can never be spelled two ways (an un-normalized `ref` from one
// caller's scan would otherwise miss a normalized handle).
export function roadmapItemKey(item: RoadmapItemState): string {
  return qualifiedRef(itemProjectKey(item), normalizeRef(item.ref))
}

// Validate a parsed roadmap against the known backlog universe. `items` supplies
// dependsOn edges (keyed within each project) for cycle detection; without a
// dependsOn axis a roadmap's lane order is linear and cannot cycle. Dangling
// detection needs only the set of known `(project, path)` pairs — an item in one
// project never satisfies a same-named ref in another.
export function validateRoadmap(
  roadmap: Roadmap,
  items: ReadonlyArray<RoadmapItemState>,
): RoadmapValidation {
  const knownKeys = new Set<string>()
  const slugToKey = new Map<string, string>() // (project\0slug) -> qualifiedRef
  for (const item of items) {
    const project = itemProjectKey(item)
    const key = qualifiedRef(project, normalizeRef(item.ref))
    knownKeys.add(key)
    slugToKey.set(projectSlugKey(project, roadmapRefSlug(item.ref)), key)
  }

  const danglingRefs: string[] = []
  const seenDangling = new Set<string>()
  const markDangling = (rawRef: string, projectKey: ProjectKey, relativePath: string): void => {
    const key = qualifiedRef(projectKey, relativePath)
    if (knownKeys.has(key) || seenDangling.has(rawRef)) return
    seenDangling.add(rawRef)
    danglingRefs.push(rawRef)
  }

  // Order edges: predecessor unit -> successor unit within each lane. Units are
  // the flattened runnable references (an epic contributes its children), keyed by
  // their qualifiedRef so cross-project units never merge.
  const edges = new Map<string, Set<string>>()
  const addEdge = (from: string, to: string): void => {
    if (from === to) return
    const set = edges.get(from) ?? new Set<string>()
    set.add(to)
    edges.set(from, set)
  }

  const membersOf = epicMemberLookup(items)
  // Epic members collapse onto their step's node for ordering: the step (entry)
  // is the dispatch unit, so a member's dependency edge lands on the epic node —
  // a member depending on a later loose item still closes a cycle with the step.
  const memberOf = new Map<string, string>()
  for (const lane of roadmap.lanes) {
    // Dangling is checked over the references an author wrote. Members are no
    // longer among them: they are resolved FROM the known item set, so a member
    // can never be dangling — only a stale entry ref can.
    for (const entry of lane.entries) {
      markDangling(entry.ref, entry.projectKey, entry.relativePath)
    }
    // Order edges sequence the runnable units (one per entry).
    const units = flattenLaneUnits(lane)
    for (const unit of units) {
      for (const member of membersOf(unit)) {
        const memberKey = roadmapItemKey(member)
        if (!memberOf.has(memberKey)) memberOf.set(memberKey, unit.key)
      }
    }
    for (let index = 1; index < units.length; index += 1) {
      addEdge(units[index - 1].key, units[index].key)
    }
  }

  // Dependency edges: a prerequisite must run before its dependent, so an item
  // that dependsOn slug S gets an edge key(S) -> item.key. Only edges between refs
  // that both appear in the graph matter for cycle detection; a dependency on an
  // item outside the roadmap cannot close a cycle inside it. Slugs resolve within
  // the dependent's own project. Epic members remap to their step's node (an
  // intra-epic dependency collapses to a self-edge and is dropped).
  const nodeOf = (key: string): string => memberOf.get(key) ?? key
  for (const item of items) {
    const project = itemProjectKey(item)
    const dependentKey = qualifiedRef(project, normalizeRef(item.ref))
    for (const slug of item.dependsOn ?? []) {
      const prerequisiteKey = slugToKey.get(projectSlugKey(project, slug))
      if (prerequisiteKey) addEdge(nodeOf(prerequisiteKey), nodeOf(dependentKey))
    }
  }

  const cycleKeys = detectCycleRefs(edges)
  // Translate the cyclic qualifiedRefs back to the raw refs the author wrote so
  // the editor can highlight the offending entry lines.
  const keyToRawRef = new Map<string, string>()
  for (const lane of roadmap.lanes) {
    for (const unit of flattenLaneUnits(lane)) keyToRawRef.set(unit.key, unit.ref)
  }
  const cycleRefs: string[] = []
  const seenCycleRef = new Set<string>()
  for (const key of cycleKeys) {
    const rawRef = keyToRawRef.get(key) ?? key
    if (seenCycleRef.has(rawRef)) continue
    seenCycleRef.add(rawRef)
    cycleRefs.push(rawRef)
  }

  return {
    danglingRefs,
    cycleRefs,
    issues: roadmap.issues,
    hasCycle: cycleRefs.length > 0,
  }
}

function projectSlugKey(projectKey: ProjectKey, slug: string): string {
  return `${projectKey ?? ''} ${slug}`
}

// Tarjan's SCC over the "before" edge graph: every strongly-connected component
// of size >= 2 is exactly a set of refs that must each run before another in the
// same component — a cycle. Iterative (explicit stack) so a deep chain cannot
// overflow. Mirrors detectCycleItemIds in backlogDependencies.ts.
function detectCycleRefs(edges: Map<string, Set<string>>): string[] {
  const nodes = new Set<string>()
  for (const [from, tos] of edges) {
    nodes.add(from)
    for (const to of tos) nodes.add(to)
  }

  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const sccStack: string[] = []
  const cycleRefs: string[] = []
  const seenCycle = new Set<string>()
  let counter = 0
  const neighbors = (id: string): string[] => [...(edges.get(id) ?? [])]

  for (const root of nodes) {
    if (index.has(root)) continue
    const work: Array<{ id: string; next: number; adj: string[] }> = []
    const enter = (id: string): void => {
      index.set(id, counter)
      lowlink.set(id, counter)
      counter += 1
      sccStack.push(id)
      onStack.add(id)
      work.push({ id, next: 0, adj: neighbors(id) })
    }
    enter(root)

    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame.next < frame.adj.length) {
        const w = frame.adj[frame.next]
        frame.next += 1
        if (!index.has(w)) {
          enter(w)
        } else if (onStack.has(w)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id) ?? 0, index.get(w) ?? 0))
        }
        continue
      }
      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        for (;;) {
          const w = sccStack.pop() as string
          onStack.delete(w)
          component.push(w)
          if (w === frame.id) break
        }
        if (component.length > 1) {
          for (const id of component) {
            if (!seenCycle.has(id)) {
              seenCycle.add(id)
              cycleRefs.push(id)
            }
          }
        }
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent) lowlink.set(parent.id, Math.min(lowlink.get(parent.id) ?? 0, lowlink.get(frame.id) ?? 0))
    }
  }
  return cycleRefs
}

// ---------------------------------------------------------------------------
// Eligibility (the orchestrator's contract — pure, no IO)
// ---------------------------------------------------------------------------

// Per-item run state the orchestrator supplies, keyed by `qualifiedRef`. A lane
// predecessor is "merged" per the MC-1439 decision of record: a worktree run
// delivers via a pull request and is merged only when that PR is merged; a
// non-worktree ('shared') run has no PR, so its terminal signal is the item
// reaching a terminal status. Absence of a link means the item was never run
// under a tracked run — it is treated as a shared/manual item whose terminal
// signal is its status.
export type RoadmapRunState = {
  mode: 'worktree' | 'shared'
  // Worktree runs only: whether the delivering PR has merged. Ignored otherwise.
  prMerged?: boolean
}

// Why a lane has (or has not) a dispatchable entry.
// - eligible: `eligible` is the concrete backlog item to dispatch next.
// - lane_complete: every unit is terminal (merged).
// - in_progress: the frontier is actively being worked (in_progress/needs_input).
// - awaiting_merge: the frontier finished but its worktree PR is not yet merged
//   (MC-1439 — a completed-but-unmerged worktree item holds the lane).
// - blocked: the frontier is not ready, or ready with unresolved prerequisites.
// - dangling: the frontier references no known backlog item in a resolvable
//   project (an authoring contradiction).
// - unknown_project: the frontier's `alias:` maps to a project the instance
//   cannot resolve to a known root — the lane parks for a re-map, never drops.
// - empty: the lane has no entries.
export type RoadmapLaneReason =
  | 'eligible'
  | 'lane_complete'
  | 'in_progress'
  | 'awaiting_merge'
  | 'blocked'
  | 'dangling'
  | 'unknown_project'
  | 'empty'

// A resolved reference the orchestrator can act on: the identity key plus the
// project + path a driver maps to a workspace root and a backlog file.
export type RoadmapUnitRef = {
  key: string
  ref: string
  projectKey: ProjectKey
  relativePath: string
  // The step's own `@roster=` override, verbatim and UNRESOLVED (MC-1881) —
  // carried so the orchestrator can resolve staffing at the decision point
  // without re-looking-up the entry by path. Resolution is `resolveEntryRoster`.
  roster?: string
  // The step's own `@agent=` override, verbatim and UNRESOLVED (MC-2145), same
  // rules — resolution is `resolveEntryAgent`.
  agent?: string
}

export type RoadmapLaneEligibility = {
  lane: string
  // The backlog ref the orchestrator should dispatch next, or null. `eligibleRef`
  // is the raw ref (byte-stable, back-compatible display); `eligible` carries the
  // resolved project + path a driver needs to start the run in the right root.
  eligibleRef: string | null
  eligible: RoadmapUnitRef | null
  reason: RoadmapLaneReason
  // The frontier unit under consideration (first non-terminal unit), for
  // diagnostics — null when the lane is complete or empty.
  frontierRef: string | null
  frontier: RoadmapUnitRef | null
}

export type LaneUnit = {
  // The graph/runtime identity (qualifiedRef) — unique across projects.
  key: string
  // The raw authored ref (for display; keeps any `alias:` prefix).
  ref: string
  projectKey: ProjectKey
  relativePath: string
  // The entry kind the unit was built from ('unknown' is a validation verdict,
  // never assigned here).
  kind: RoadmapEntryKind
  // The step's own `@roster=` override, verbatim and UNRESOLVED (MC-1881). The
  // fallback to the roadmap policy is applied by `resolveEntryRoster` at the one
  // place staffing is decided — carrying the raw value here keeps this flattening
  // a pure projection of the entry rather than a second resolution site.
  roster?: string
  // The step's own `@agent=` override, same rules (MC-2145).
  agent?: string
}

// The runnable units of a lane: ONE unit per entry. A step is the dispatch
// granularity — an epic entry runs as a single sprint (the sprint plans the
// epic's members as its tasks), so the epic itself is the unit; its members are
// resolved live (epicMemberLookup) wherever progress display or shared-mode
// completion needs them.
// Exported so the steering surface (MC-1620) renders and counts exactly the units
// the orchestrator schedules — the board's "done vs up next" split is the frontier
// index over this same flattening, never a parallel re-derivation.
export function flattenLaneUnits(lane: RoadmapLane): LaneUnit[] {
  return lane.entries.map((entry) => ({
    key: qualifiedRef(entry.projectKey, entry.relativePath),
    ref: entry.ref,
    projectKey: entry.projectKey,
    relativePath: entry.relativePath,
    kind: entry.kind,
    ...(entry.roster ? { roster: entry.roster } : {}),
    ...(entry.agent ? { agent: entry.agent } : {}),
  }))
}

// The members of an epic step, resolved LIVE from the item universe (MC-2031).
// A horizon stores no membership: each member points UP at its epic through
// frontmatter `epic:`, exactly as the Backlog's own grouping does, so a child a
// sprint mints mid-epic is a member of the step the moment the file exists.
// Members resolve within the epic's OWN project — `epic:` is a slug, and a slug
// never crosses a project boundary — and epic files are never members of each
// other, so a nested epic ref is not picked up.
export type EpicMemberLookup = (
  unit: Pick<LaneUnit, 'kind' | 'ref' | 'projectKey'>,
) => ReadonlyArray<RoadmapItemState>

// Build the lookup once per pass; every consumer that needs an epic's members
// goes through it so the board, the orchestrator and eligibility can never
// disagree about who is in a step.
export function epicMemberLookup(items: ReadonlyArray<RoadmapItemState>): EpicMemberLookup {
  const byEpic = new Map<string, RoadmapItemState[]>()
  for (const item of items) {
    if (!item.epic) continue
    if (entryKindForRelativePath(normalizeRef(item.ref)) === 'epic') continue
    const key = projectSlugKey(itemProjectKey(item), item.epic)
    const members = byEpic.get(key)
    if (members) members.push(item)
    else byEpic.set(key, [item])
  }
  // Path order: the one ordering an epic's members have that is stable across
  // sessions and machines now that nothing stores a sequence. Runtime ordering
  // still comes from `dependsOn`, so this is presentation, never a constraint.
  for (const members of byEpic.values()) {
    members.sort((a, b) => normalizeRef(a.ref).localeCompare(normalizeRef(b.ref)))
  }
  return (unit) =>
    unit.kind === 'epic'
      ? (byEpic.get(projectSlugKey(unit.projectKey, roadmapRefSlug(unit.ref))) ?? [])
      : []
}

const TERMINAL_STATUSES: ReadonlySet<BacklogItemStatusPayload> = new Set<BacklogItemStatusPayload>([
  'completed',
  'archived',
])

// The next eligible entry per lane. For each lane the frontier is the first unit
// that is not yet MERGED (its predecessor, by construction, is merged); the lane
// is eligible when that frontier is `ready` with every prerequisite resolved.
// A step (entry) is the dispatch granularity: an epic entry is ONE unit — one
// sprint delivers the whole epic — whose effective status derives from its LIVE
// members (terminal only when all members are terminal), so the lane still
// advances truthfully when members are worked outside a tracked run.
//
// `items` is the backlog universe (flat, each tagged with its `projectKey`); a
// unit resolves against the items sharing its project. `resolvableProjects`, when
// supplied, is the set of project keys the instance can map to a known root — a
// frontier whose project is absent from it parks `unknown_project` rather than
// reading as a plain dangling ref. When omitted, every project present in `items`
// (plus the home project) is treated as resolvable, so single-project callers
// never see `unknown_project`.
export function nextEligible(
  roadmap: Roadmap,
  items: ReadonlyArray<RoadmapItemState>,
  runLinks: ReadonlyMap<string, RoadmapRunState>,
  resolvableProjects?: ReadonlySet<ProjectKey>,
): RoadmapLaneEligibility[] {
  const byKey = new Map<string, RoadmapItemState>()
  const bySlug = new Map<string, RoadmapItemState>()
  const presentProjects = new Set<ProjectKey>([null])
  for (const item of items) {
    const project = itemProjectKey(item)
    presentProjects.add(project)
    byKey.set(qualifiedRef(project, normalizeRef(item.ref)), item)
    bySlug.set(projectSlugKey(project, roadmapRefSlug(item.ref)), item)
  }
  const resolvable = resolvableProjects ?? presentProjects
  const membersOf = epicMemberLookup(items)

  // A unit's effective backlog state. An item unit reads its own state. An epic
  // unit runs as ONE sprint but is DELIVERED by its members, so its effective
  // status derives from its live members when they say more than the epic's own
  // frontmatter:
  //   1. every member terminal (and at least one member) → completed
  //   2. the epic's own status when it is live or terminal (a started sprint
  //      stamps the epic in_progress via the execution link)
  //   3. any member in_progress/needs_input → in_progress
  //   4. any member ready → ready
  //   5. else the epic's own status (idea etc. read as blocked, like any entry)
  const effectiveState = (unit: LaneUnit): RoadmapItemState | undefined => {
    const own = byKey.get(unit.key)
    if (unit.kind !== 'epic' || !own) return own
    const memberStatuses = membersOf(unit).map((member) => member.status)
    if (memberStatuses.length === 0) return own
    if (memberStatuses.every((status) => TERMINAL_STATUSES.has(status))) {
      return { ...own, status: 'completed' }
    }
    if (own.status === 'in_progress' || own.status === 'needs_input' || TERMINAL_STATUSES.has(own.status)) return own
    if (memberStatuses.some((status) => status === 'in_progress' || status === 'needs_input')) {
      return { ...own, status: 'in_progress' }
    }
    if (memberStatuses.some((status) => status === 'ready')) return { ...own, status: 'ready' }
    return own
  }

  const isMerged = (unit: LaneUnit): boolean => {
    const link = runLinks.get(unit.key)
    if (link?.mode === 'worktree') return link.prMerged === true
    // Migration guard: a run started under the old child-granularity keyed its
    // execution link on a MEMBER, not the epic. An unmerged member worktree PR
    // still holds the step — the lane must not advance past it.
    if (unit.kind === 'epic') {
      for (const member of membersOf(unit)) {
        const memberLink = runLinks.get(roadmapItemKey(member))
        if (memberLink?.mode === 'worktree' && memberLink.prMerged !== true) return false
      }
    }
    // Shared runs and manual/untracked items: terminal (effective) status is the
    // signal — an epic unit is delivered when all its members are.
    const state = effectiveState(unit)
    return state !== undefined && TERMINAL_STATUSES.has(state.status)
  }

  const dependsOnResolved = (state: RoadmapItemState, project: ProjectKey): boolean => {
    for (const slug of state.dependsOn ?? []) {
      const target = bySlug.get(projectSlugKey(project, slug))
      // A dangling prerequisite is unresolved: an unknown blocker must not read
      // as satisfied (Fallback Discipline). A prerequisite is resolved once its
      // target is terminal — the backlogDependencies.ts RESOLVED_STATUSES rule.
      if (!target || !TERMINAL_STATUSES.has(target.status)) return false
    }
    return true
  }

  // A step's full dependency gate. For an item unit that is its own dependsOn.
  // For an epic unit the MEMBERS' prerequisites gate the step too: one sprint
  // delivers the whole epic, so it must not start while any member depends on
  // unfinished work OUTSIDE the epic. Intra-epic dependencies are the sprint's
  // own ordering, never a start gate.
  const unitDependenciesResolved = (unit: LaneUnit, state: RoadmapItemState): boolean => {
    if (!dependsOnResolved(state, unit.projectKey)) return false
    if (unit.kind !== 'epic') return true
    const members = membersOf(unit)
    const memberSlugs = new Set(members.map((member) => roadmapRefSlug(member.ref)))
    for (const member of members) {
      // A delivered member's prerequisites cannot gate a step that has not run:
      // its work is already done. (The stored snapshot captured OPEN members
      // only, so skipping terminal ones here preserves that gate exactly.)
      if (TERMINAL_STATUSES.has(member.status)) continue
      for (const slug of member.dependsOn ?? []) {
        if (memberSlugs.has(slug)) continue
        const target = bySlug.get(projectSlugKey(itemProjectKey(member), slug))
        if (!target || !TERMINAL_STATUSES.has(target.status)) return false
      }
    }
    return true
  }

  const unitRef = (unit: LaneUnit): RoadmapUnitRef => ({
    key: unit.key,
    ref: unit.ref,
    projectKey: unit.projectKey,
    relativePath: unit.relativePath,
    ...(unit.roster ? { roster: unit.roster } : {}),
    ...(unit.agent ? { agent: unit.agent } : {}),
  })

  return roadmap.lanes.map((lane) => {
    const units = flattenLaneUnits(lane)
    if (units.length === 0) {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'empty', frontierRef: null, frontier: null }
    }

    const frontier = units.find((unit) => !isMerged(unit))
    if (!frontier) {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'lane_complete', frontierRef: null, frontier: null }
    }

    const frontierUnitRef = unitRef(frontier)
    // The frontier's project is not resolvable to a known root — park for a re-map
    // rather than treating the (necessarily missing) item as a plain dangling ref.
    if (!resolvable.has(frontier.projectKey)) {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'unknown_project', frontierRef: frontier.ref, frontier: frontierUnitRef }
    }

    const state = effectiveState(frontier)
    if (!state) {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'dangling', frontierRef: frontier.ref, frontier: frontierUnitRef }
    }
    if (state.status === 'ready' && unitDependenciesResolved(frontier, state)) {
      return { lane: lane.title, eligibleRef: frontier.ref, eligible: frontierUnitRef, reason: 'eligible', frontierRef: frontier.ref, frontier: frontierUnitRef }
    }
    if (state.status === 'in_progress' || state.status === 'needs_input') {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'in_progress', frontierRef: frontier.ref, frontier: frontierUnitRef }
    }
    // Terminal status but not merged — only reachable for a worktree run whose PR
    // has not merged (a shared/manual terminal item is `isMerged`, so it would
    // have been skipped). The lane waits on the merge.
    if (TERMINAL_STATUSES.has(state.status)) {
      return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'awaiting_merge', frontierRef: frontier.ref, frontier: frontierUnitRef }
    }
    return { lane: lane.title, eligibleRef: null, eligible: null, reason: 'blocked', frontierRef: frontier.ref, frontier: frontierUnitRef }
  })
}
