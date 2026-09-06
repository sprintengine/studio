import type { TerminalSessionSnapshot, WorkspaceChangeSummary } from '../../../../shared/electron-api'
import { sessionRecencyOf } from '../../hooks/useTerminalSessions'
import type { Workspace } from '../../types/workspace'
import { resolveWorkspaceWorktree } from '../../utils/workspaceWorktree'
import { agentCheckoutOf, agentCheckoutProbePath } from './agentCheckout'
import type { RemoteSessionRow } from './remoteBand/remoteSessionsModel'
import { checkoutPathFor } from './useSidebarGitSummaries'

// The sidebar row's terminal lines (sidebar-lists-every-terminal): one line
// per live terminal under the row's title — its CLI mark (whose tooltip
// names the terminal), the branch it is on (a worktree of its own drawn at
// full strength), the ±lines of that checkout, and how long it has worked or
// sat idle. The face-pile of heads and the single row-level branch are gone:
// the lines ARE the count, and each one says where IT is.
//
// Pure: sessions and summaries in, lines out. The view renders a line; the
// row decides how many to show.

/** Lines past this fold into one "+N more" line — a row never grows past the screen. */
export const MAX_TERMINAL_LINES = 4

export type TerminalLine = {
  key: string
  kind: 'agent' | 'shell' | 'remote'
  cli: string | null
  /**
   * What the terminal is called — the mark's tooltip and accessible name, not
   * line text (owner ruling 2026-09-05); also the tie-break when lines sort.
   * Null when the row's title already names it (a remote band row).
   */
  name: string | null
  /** The machine a remote pane lives on; the glyph beside the name says so. */
  machineName: string | null
  branch: string | null
  /** A linked worktree of the terminal's own: the branch reads at full strength. */
  worktree: boolean
  /** The observed directory, for hover: where the terminal sits, which may be a subdirectory. */
  cwd: string | null
  /** The observed directory no longer exists (a worktree pruned under the agent). */
  removed: boolean
  additions: number
  deletions: number
  diffScope: 'worktree' | 'branch' | 'folder'
  working: boolean
  workingSince: number | null
  needsInput: boolean
  failed: boolean
  idleSince: number | null
  /** Words for the idle time's sr-only sentence: "Idle", or "Paused" for a paused remote row. */
  idleLabel: string
}

export type TerminalLinesWorkspace = Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState' | 'agents' | 'remoteOrigin'>

function launchIntentOf(workspace: TerminalLinesWorkspace, session: TerminalSessionSnapshot) {
  const worktree = resolveWorkspaceWorktree(workspace)
  const agent = session.agentId ? workspace.agents?.[session.agentId] : undefined
  return {
    workspaceWorktree: worktree ? { gitRoot: worktree.gitRoot, branch: worktree.branch ?? null } : null,
    execution: agent?.execution ?? null,
  }
}

/**
 * The checkout a session's line reports on — the checkout git observed the
 * session in, else its launch intent, else the workspace's own — or null when
 * it sits somewhere that is not a checkout at all.
 */
export function sessionCheckoutPath(workspace: TerminalLinesWorkspace, session: TerminalSessionSnapshot): string | null {
  return agentCheckoutProbePath(agentCheckoutOf(session, launchIntentOf(workspace, session)), checkoutPathFor(workspace))
}

/**
 * The distinct checkouts a row's live sessions sit on, for the git poll: two
 * agents on one checkout ask once, an agent in its own worktree asks for it.
 */
export function checkoutPathsOf(workspace: TerminalLinesWorkspace, sessions: ReadonlyArray<TerminalSessionSnapshot>): string[] {
  const paths = new Set<string>()
  for (const session of sessions) {
    const path = sessionCheckoutPath(workspace, session)
    if (path) paths.add(path)
  }
  return [...paths]
}

function recencyOf(session: TerminalSessionSnapshot) {
  const recency = sessionRecencyOf(session)
  return {
    working: session.activity.kind === 'working',
    workingSince: recency.workingSince,
    needsInput: recency.needsInput,
    failed: session.activity.kind === 'failed',
    idleSince: recency.idleSince,
    idleLabel: 'Idle',
  }
}

function lineOfSession(
  workspace: TerminalLinesWorkspace,
  session: TerminalSessionSnapshot,
  summaries: Record<string, WorkspaceChangeSummary>
): TerminalLine {
  const checkout = agentCheckoutOf(session, launchIntentOf(workspace, session))
  const probePath = agentCheckoutProbePath(checkout, checkoutPathFor(workspace))
  const summary = probePath ? summaries[probePath] : undefined
  const agent = session.agentId ? workspace.agents?.[session.agentId] : undefined
  const isAgent = session.kind === 'agent'
  // Only a checkout names a branch; a folder, a removed directory or an
  // unverified path has none, and the summary (keyed by checkout) has none
  // for them either, so nothing is claimed.
  const checkoutBranch = checkout && (checkout.kind === 'worktree' || checkout.kind === 'main') ? checkout.branch : null
  return {
    key: session.sessionId,
    kind: isAgent ? 'agent' : 'shell',
    cli: session.cli ?? null,
    name: isAgent ? agent?.name ?? session.agentName ?? 'Agent' : 'Terminal',
    machineName: null,
    branch: checkoutBranch ?? summary?.branch ?? null,
    worktree: checkout?.kind === 'worktree',
    cwd: checkout?.cwd ?? null,
    removed: checkout?.kind === 'missing',
    additions: summary?.additions ?? 0,
    deletions: summary?.deletions ?? 0,
    diffScope: summary?.scope ?? 'folder',
    ...recencyOf(session),
  }
}

/**
 * A fleet pane the layout mounts from another machine: its checkout is on
 * that machine's disk, so the only branch this side can name is the one a
 * remote-born workspace had stamped at its create; no ±lines are claimed.
 * No name either — the machine's name is the glyph's tooltip and accessible
 * name, never row text (owner ruling 2026-09-05), and the pane has no other.
 */
function lineOfFleetPane(
  workspace: TerminalLinesWorkspace,
  pane: { tabId: string; machineName: string; cli?: string }
): TerminalLine {
  return {
    key: pane.tabId,
    kind: 'remote',
    cli: pane.cli ?? null,
    name: null,
    machineName: pane.machineName,
    branch: workspace.remoteOrigin?.checkout?.branch ?? null,
    worktree: false,
    cwd: null,
    removed: false,
    additions: 0,
    deletions: 0,
    diffScope: 'folder',
    working: false,
    workingSince: null,
    needsInput: false,
    failed: false,
    idleSince: null,
    idleLabel: 'Idle',
  }
}

/** A remote band row's one line: the row's title names the conversation, so the line does not. */
export function lineOfRemoteRow(row: RemoteSessionRow): TerminalLine {
  return {
    key: row.sessionId,
    kind: 'remote',
    cli: row.cli,
    name: null,
    machineName: null,
    branch: row.branch,
    worktree: row.diffScope === 'worktree',
    cwd: null,
    removed: false,
    additions: row.additions,
    deletions: row.deletions,
    diffScope: row.diffScope,
    working: row.activity === 'working',
    workingSince: row.activity === 'working' ? row.since : null,
    needsInput: row.activity === 'needs-input',
    failed: false,
    idleSince: row.activity === 'working' ? null : row.since,
    idleLabel: row.activity === 'paused' ? 'Paused' : 'Idle',
  }
}

/** The moment a line last did anything, for ordering; a line that never said is oldest. */
function activityAt(line: TerminalLine, session?: TerminalSessionSnapshot): number {
  return Math.max(
    line.workingSince ?? 0,
    line.idleSince ?? 0,
    session?.lastOutputAt ?? 0,
    session?.lastInputAt ?? 0
  )
}

/**
 * A row's lines, in the order they show: the terminals doing something first,
 * then by how recently each did anything, remote panes (which never say) last.
 * Past {@link MAX_TERMINAL_LINES} the rest fold into `overflow`.
 */
export function terminalLinesOf(input: {
  workspace: TerminalLinesWorkspace
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  fleetPanes: ReadonlyArray<{ tabId: string; machineName: string; cli?: string }>
  summaries: Record<string, WorkspaceChangeSummary>
}): { lines: TerminalLine[]; overflow: number } {
  const ranked = [
    ...input.sessions.map((session) => {
      const line = lineOfSession(input.workspace, session, input.summaries)
      return { line, at: activityAt(line, session) }
    }),
    ...input.fleetPanes.map((pane) => {
      const line = lineOfFleetPane(input.workspace, pane)
      return { line, at: activityAt(line) }
    }),
  ]
  ranked.sort((a, b) => {
    if (a.line.working !== b.line.working) return a.line.working ? -1 : 1
    if (a.at !== b.at) return b.at - a.at
    return (a.line.name ?? '').localeCompare(b.line.name ?? '')
  })
  const lines = ranked.map((entry) => entry.line)
  if (lines.length <= MAX_TERMINAL_LINES) return { lines, overflow: 0 }
  return { lines: lines.slice(0, MAX_TERMINAL_LINES), overflow: lines.length - MAX_TERMINAL_LINES }
}
