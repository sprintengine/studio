// What the Skills pane draws, derived in one pure pass.
//
// The pane's whole job is to render `agentCapabilities` faithfully, and the
// interesting part of that is the states: a directory that failed to read, a
// CLI that reads no skills at all, and an agent that simply has none must all
// look different from each other. Keeping the derivation pure and separate from
// the JSX is what lets each of those be asserted directly (skillsPaneModel.test)
// instead of inferred from rendered markup.
//
// Nothing here invents data. Every count, row and tool count comes from the
// resolver's payload; a field the resolver did not send is absent, never zero
// and never a placeholder.

import type {
  AgentMcpServer,
  AgentSkill,
  AgentSkillSource,
  CapabilityDiagnostic,
} from '../../../../../shared/skills'
import type { AgentSkillTarget, BuiltinSkill } from '../../../../../shared/electron-api'

/** What the resolver answered, once, for the focused agent. */
export type CapabilitySnapshot = {
  support: 'native' | 'prompt-shim' | 'unsupported'
  harnessId: string
  skills: AgentSkill[]
  servers: AgentMcpServer[]
  diagnostics: CapabilityDiagnostic[]
}

export type SkillsPaneInput = {
  /** null while the first read is in flight. */
  snapshot: CapabilitySnapshot | null
  loading: boolean
  /** Set when the question could not be asked at all (no workspace open). */
  unavailableMessage: string | null
  /** Null when no agent tab is focused — the pane has nothing to describe. */
  agentLabel: string | null
  query: string
  /**
   * Built-in skills this workspace could install, so search reaches past what
   * the agent already has. They are never mixed into the reachable list: they
   * live under their own heading and are the only rows that offer Add.
   */
  catalogue: BuiltinSkill[]
  /** Skill ids attached this session whose CLI only reads them after a restart. */
  restartPending: string[]
  /** The last add/remove that did not fully succeed, if it has not been dismissed. */
  writeReport: SkillWriteReport | null
}

export type SkillWriteReport = {
  verb: 'add' | 'remove'
  skillId: string
  targets: AgentSkillTarget[]
  /** Set when the write could not be attempted at all. */
  message: string | null
}

export type PaneSkillRow = {
  key: string
  skillId: string
  /** The row's identity to every CLI that reads it: the directory name. */
  title: string
  /** First sentence of the real description; '' when the skill declares none. */
  supporting: string
  description: string
  /** Where the copy came from, in words. '' for a catalogue row. */
  sourceLabel: string
  installed: boolean
  /** Every CLI that reads the directory this skill lives in. */
  pluginIds: string[]
}

export type PaneServerRow = {
  key: string
  serverId: string
  title: string
  supporting: string
  /** Absent unless the config stated it — a count is never guessed. */
  toolCount: number | null
  scope: 'workspace' | 'user'
  configPath: string
}

export type PaneNotice =
  | { kind: 'unsupported'; agentLabel: string }
  | { kind: 'unreadable'; capability: 'skills' | 'servers'; path: string; message: string }
  | { kind: 'stale'; message: string }
  | { kind: 'restart'; agentLabel: string; skillIds: string[] }
  | {
      kind: 'write-partial'
      verb: 'add' | 'remove'
      skillId: string
      written: string[]
      failed: { path: string; message: string }[]
    }
  | { kind: 'write-failed'; verb: 'add' | 'remove'; skillId: string; message: string }

export type PaneBody =
  | { kind: 'loading' }
  | { kind: 'no-agent' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'no-matches'; query: string }
  | { kind: 'empty' }
  /**
   * A path failed to read and nothing survived it. The banners above the body
   * already name the path and offer the retry, so the body draws nothing — the
   * one thing it must never do is fall through to the plain "no skills" line,
   * which would report a broken dependency as an ordinary empty workspace.
   */
  | { kind: 'fault' }
  | {
      kind: 'sections'
      skills: PaneSkillRow[]
      available: PaneSkillRow[]
      servers: PaneServerRow[]
      /** Catalogue entries not shown because nothing is being searched for. */
      catalogueRemaining: number
    }

export type SkillsPaneView = {
  notices: PaneNotice[]
  body: PaneBody
}

const SOURCE_LABEL: Record<AgentSkillSource, string> = {
  builtin: 'Built in',
  source: 'A skill source',
  local: 'This workspace',
}

/**
 * The supporting clause is one sentence, because the row is one line. The rest
 * of the description is not dropped — it is what the tooltip and the expanded
 * detail show.
 */
export function firstSentence(description: string): string {
  const trimmed = description.trim()
  if (!trimmed) return ''
  const end = trimmed.search(/[.!?](\s|$)/)
  return end === -1 ? trimmed : trimmed.slice(0, end + 1)
}

function matchesQuery(haystack: readonly string[], normalized: string): boolean {
  if (!normalized) return true
  return haystack.some((value) => value.toLowerCase().includes(normalized))
}

function skillRow(skill: AgentSkill): PaneSkillRow {
  return {
    key: `skill:${skill.id}`,
    skillId: skill.id,
    title: skill.id,
    supporting: firstSentence(skill.description),
    description: skill.description,
    sourceLabel: SOURCE_LABEL[skill.source],
    installed: true,
    pluginIds: skill.pluginIds,
  }
}

function catalogueRow(skill: BuiltinSkill): PaneSkillRow {
  return {
    key: `available:${skill.id}`,
    skillId: skill.id,
    title: skill.id,
    supporting: firstSentence(skill.description),
    description: skill.description,
    sourceLabel: '',
    installed: false,
    pluginIds: [],
  }
}

function serverRow(server: AgentMcpServer): PaneServerRow {
  return {
    key: `server:${server.id}`,
    serverId: server.id,
    title: server.id,
    supporting: server.transport,
    toolCount: typeof server.toolCount === 'number' ? server.toolCount : null,
    scope: server.scope,
    configPath: server.configPath,
  }
}

/**
 * A CLI that reads no skills at all. `prompt-shim` is deliberately not here: it
 * reads them by another route, so blanking its list would be wrong.
 */
export function readsSkills(support: CapabilitySnapshot['support']): boolean {
  return support !== 'unsupported'
}

function noticesFor(input: SkillsPaneInput, snapshot: CapabilitySnapshot | null): PaneNotice[] {
  const notices: PaneNotice[] = []
  const agentLabel = input.agentLabel ?? ''

  if (snapshot && !readsSkills(snapshot.support)) {
    notices.push({ kind: 'unsupported', agentLabel })
  }

  for (const diagnostic of snapshot?.diagnostics ?? []) {
    if (diagnostic.reason === 'watch_unavailable') {
      notices.push({ kind: 'stale', message: diagnostic.message })
      continue
    }
    // `unreadable` and `malformed` are both "this path did not answer". They
    // read the same to the person looking at the pane — what matters is that a
    // path is named and the list below is not passed off as the truth.
    if (diagnostic.capability === 'freshness') continue
    notices.push({
      kind: 'unreadable',
      capability: diagnostic.capability,
      path: diagnostic.path,
      message: diagnostic.message,
    })
  }

  const report = input.writeReport
  if (report) {
    if (report.message) {
      notices.push({
        kind: 'write-failed',
        verb: report.verb,
        skillId: report.skillId,
        message: report.message,
      })
    } else {
      const failed = report.targets.filter((target) => target.status === 'failed')
      if (failed.length > 0) {
        notices.push({
          kind: 'write-partial',
          verb: report.verb,
          skillId: report.skillId,
          written: report.targets
            .filter((target) => target.status === 'written' || target.status === 'removed')
            .map((target) => target.path),
          failed: failed.map((target) => ({
            path: target.path,
            message: target.message ?? 'The write did not report a reason.',
          })),
        })
      }
    }
  }

  if (input.restartPending.length > 0 && snapshot && readsSkills(snapshot.support)) {
    notices.push({ kind: 'restart', agentLabel, skillIds: [...input.restartPending] })
  }

  return notices
}

export function buildSkillsPaneView(input: SkillsPaneInput): SkillsPaneView {
  const snapshot = input.snapshot
  const notices = noticesFor(input, snapshot)
  const normalized = input.query.trim().toLowerCase()

  if (input.agentLabel === null) return { notices, body: { kind: 'no-agent' } }
  if (input.unavailableMessage) {
    return { notices, body: { kind: 'unavailable', message: input.unavailableMessage } }
  }
  // Loading only wins while there is nothing to show. A refetch behind an
  // invalidation keeps the current list on screen instead of flashing a spinner
  // over a list that is about to come back almost identical.
  if (!snapshot) return { notices, body: input.loading ? { kind: 'loading' } : { kind: 'empty' } }

  const skills = snapshot.skills
    .map(skillRow)
    .filter((row) => matchesQuery([row.skillId, row.description, row.sourceLabel], normalized))
  const servers = snapshot.servers
    .map(serverRow)
    .filter((row) => matchesQuery([row.serverId, row.supporting, row.configPath], normalized))

  // The catalogue is search-only. At rest the pane answers "what can this agent
  // reach", and a standing list of things it cannot would bury that answer.
  const reachable = new Set(snapshot.skills.map((skill) => skill.id))
  const installable = input.catalogue.filter((skill) => !reachable.has(skill.id))
  const available = normalized
    ? installable
      .map(catalogueRow)
      .filter((row) => matchesQuery([row.skillId, row.description], normalized))
    : []

  const readFault = snapshot.diagnostics.some((diagnostic) => diagnostic.capability !== 'freshness')

  if (skills.length === 0 && servers.length === 0 && available.length === 0) {
    if (readFault) return { notices, body: { kind: 'fault' } }
    if (normalized) return { notices, body: { kind: 'no-matches', query: input.query.trim() } }
    return { notices, body: { kind: 'empty' } }
  }

  return {
    notices,
    body: {
      kind: 'sections',
      skills,
      available,
      servers,
      catalogueRemaining: normalized ? 0 : installable.length,
    },
  }
}
