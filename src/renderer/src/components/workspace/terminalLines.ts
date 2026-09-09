import type { SessionFileChange, TerminalSessionSnapshot, WorkspaceChangeSummary } from '../../../../shared/electron-api'
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

/**
 * Whose changes a line's ±lines are — the honesty contract the tooltip and the
 * spoken label are derived from, one value wider than git's own
 * ({@link WorkspaceChangeSummary}`.scope`):
 *
 * - `session` — the agent's OWN edits, tallied from its editor tool calls as it
 *   made them (the per-session hook ledger). The only reading that separates
 *   two agents sharing one checkout, and the only one that is cumulative: a
 *   line edited twice counts twice, because it measures work done rather than
 *   the tree's distance from a base.
 * - `worktree` / `branch` / `folder` — the checkout's git reading, exactly as
 *   main's workspace-change-summary defines them.
 */
export type TerminalDiffScope = 'session' | 'worktree' | 'branch' | 'folder'

/**
 * The ledger's totals, or null when the session has no ±lines to state — a
 * plain shell, a CLI whose hooks we never installed, or an agent that has not
 * written anything yet. Null is the signal to fall back to the checkout's git
 * reading: a session that cannot speak for itself must keep exactly the numbers
 * it had before the ledger existed.
 *
 * A ledger whose entries carry NO counts is null too, and that is the whole of
 * why this returns null rather than zeros. The reporter records a path-only
 * entry when a tool result's shape is one it cannot count (NotebookEdit, a
 * MultiEdit whose result ships no structuredPatch, and whatever a non-Claude
 * CLI sends), so `+0 −0` is a reading we failed to take, not a session that
 * changed nothing — and the row draws nothing at all for zeros. Claiming the
 * scope on those would leave a CLI whose hooks half-work showing LESS than a
 * CLI with no hooks at all.
 *
 * A ledger that mixes the two still reports: the counted edits are stated and
 * the uncounted ones add only their file to the count. That under-reads, and
 * says so at full strength — the alternative is throwing away edits we DID
 * count for the sake of ones we did not, which is worse and, since a Claude
 * Edit / Write / MultiEdit all carry a patch, rarer than it sounds.
 *
 * The totals are of the entries the ledger still HOLDS: main bounds it
 * (MAX_SESSION_FILE_CHANGES) by dropping the least recently edited, so a run
 * that touches thousands of files reports the ones it remembers. Under-reading
 * a very long run is the intended trade — the alternative is an unbounded list
 * on every snapshot broadcast — and it errs downwards, never claiming more work
 * than was done.
 */
export function ledgerTotalsOf(
  fileChanges: ReadonlyArray<SessionFileChange> | undefined
): { additions: number; deletions: number; changedFiles: number } | null {
  if (!fileChanges || fileChanges.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const change of fileChanges) {
    additions += change.additions
    deletions += change.deletions
  }
  if (additions === 0 && deletions === 0) return null
  return { additions, deletions, changedFiles: fileChanges.length }
}

/**
 * What a line's ±lines are allowed to SAY, derived from the scope — the tooltip
 * on hover, the sentence a screen reader gets, and whether the numbers step
 * back. One place, so the two spellings can never drift apart.
 *
 * The words follow the sidebar's existing shape — the claim, an em dash, the
 * reason you may or may not believe it — and each names whose work it is: the
 * agent, the terminal, the branch, or nobody in particular.
 */
export function diffScopeCopy(
  line: Pick<TerminalLine, 'diffScope' | 'branch' | 'additions' | 'deletions'>
): { tooltip: string; srText: string; dim: boolean } {
  const { additions, deletions } = line
  if (line.diffScope === 'session') {
    // The only reading that is one agent's alone, so it is the only one that
    // says "this agent" rather than "this terminal" or "this checkout". Its
    // second clause carries the same weight the others' do — what you must not
    // assume. Here that is the counting: these are the agent's editing tool
    // calls as it made them, so a line edited twice counts twice and work it
    // has since undone is still in the number. The spoken label has to carry it
    // too: a screen reader never gets the tooltip (it is portalled on hover),
    // and "by this agent" alone would be the one sr sentence MORE confident
    // than the words beside it.
    return {
      tooltip: 'Changed by this agent — the edits it made through its tools, including ones it has since undone',
      srText: `${additions} added, ${deletions} removed by this agent’s own edits`,
      dim: false,
    }
  }
  if (line.diffScope === 'worktree') {
    return {
      tooltip: 'Changed by this terminal — it has its own worktree',
      srText: `${additions} added, ${deletions} removed by this terminal`,
      dim: false,
    }
  }
  if (line.diffScope === 'branch') {
    return {
      tooltip: `Changed on ${line.branch ?? 'this branch'} — this terminal shares the checkout, so a person or another terminal may have made some of it`,
      srText: `${additions} added, ${deletions} removed on ${line.branch ?? 'this branch'}`,
      dim: false,
    }
  }
  return {
    tooltip: 'Uncommitted changes in this folder — this terminal has no branch of its own',
    srText: `${additions} added, ${deletions} removed in this folder`,
    // A folder reading is the repo's state, not this terminal's work: the
    // numbers are real but nobody can say who made them, so they step back.
    dim: true,
  }
}

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
  /**
   * How many files the numbers cover. Only a `session` reading counts them —
   * the git summary carries its own `changedFiles`, and a line that falls back
   * to it takes that; a line that claims nothing says 0.
   */
  changedFiles: number
  diffScope: TerminalDiffScope
  /**
   * Subagents this session has running (`activeSubagents` on the snapshot).
   * Exposed for the renderer that will say "3 running"; nothing draws it yet,
   * so it is 0 for every line that is not a local agent session.
   */
  activeSubagents: number
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
  // The numbers: this session's own ledger when it has one, else the
  // checkout's git reading exactly as before (hook-file-ledger, owner decision
  // 2026-09-09 — "no git for a session that has a ledger"). The git reading is
  // keyed by CHECKOUT, so two agents sharing one gave the same ±lines on both
  // their lines and neither could be believed; the ledger is the session's own.
  // The branch, the worktree flag and the cwd still come from the checkout
  // below — where a session sits is a fact about the checkout whatever it has
  // edited.
  //
  // The ledger wins over `worktree` scope too, which is the one place the trade
  // is not free: a linked worktree is already exclusive to one session, and its
  // git span also sees edits made through the shell (a codemod, `git apply`)
  // and falls when the agent reverts, neither of which the ledger can. What it
  // buys is one meaning for the number on every line of the sidebar — "the work
  // this agent did" — rather than two that look identical and are not.
  //
  // Only an agent line reads a ledger. A shell has none today (frames are
  // routed by agent id), and the words this scope licenses say "this agent".
  const ledger = isAgent ? ledgerTotalsOf(session.fileChanges) : null
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
    additions: ledger?.additions ?? summary?.additions ?? 0,
    deletions: ledger?.deletions ?? summary?.deletions ?? 0,
    changedFiles: ledger?.changedFiles ?? summary?.changedFiles ?? 0,
    diffScope: ledger ? 'session' : summary?.scope ?? 'folder',
    activeSubagents: isAgent ? session.activeSubagents ?? 0 : 0,
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
    changedFiles: 0,
    diffScope: 'folder',
    activeSubagents: 0,
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
    // A remote sends a git reading with no file count in it, and no ledger at
    // all: a session on another machine never claims `session` scope here.
    changedFiles: 0,
    diffScope: row.diffScope,
    activeSubagents: 0,
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
 * What the ROW as a whole may claim about ±lines, or null when it may claim
 * nothing new — which is today's behaviour, and the row draws no aggregate at
 * all.
 *
 * The rule is all-or-nothing on purpose. A sum is only the row's own work when
 * every agent under it is self-reporting; the moment ONE line falls back to its
 * checkout's git reading, adding that reading to the others' ledgers would mix
 * two different measurements — one cumulative and per-agent, one a distance
 * from a merge base shared by everybody — and the total would mean nothing.
 *
 * Only agent lines are counted: the claim is "the agents' own edits", so a
 * plain shell (which reports no edits) neither contributes nor disqualifies,
 * and a remote pane's checkout is on another disk. Whatever eventually draws
 * this has to say the agents, then — a person typing `sed` in a shell under the
 * row made changes this number does not have. Every line the row HAS is
 * counted, including the ones folded into `overflow` — the figure is the row's,
 * not the visible four's.
 *
 * One thing for the phase that draws it: this flips between null and a value
 * discontinuously. It appears the moment the LAST agent under the row makes its
 * first countable edit, and disappears again when any one of them respawns its
 * pty (the ledger lives and dies with the process). A renderer that simply
 * shows it will blink; holding the last value, or saying how many agents are
 * reporting, is the honest way to draw a figure that comes and goes.
 */
export type RowDiff = {
  additions: number
  deletions: number
  /**
   * Files EDITED, summed across the ledgers — not distinct paths. Two agents
   * that both touched `a.ts` make it 2, and the row cannot tell: each ledger
   * is its own and the paths are gone by the time the lines are summed. Named
   * for what it counts so nothing downstream writes "3 files changed" against
   * a number that does not mean that.
   */
  fileEdits: number
  scope: 'session'
}

function rowDiffOf(lines: ReadonlyArray<TerminalLine>): RowDiff | null {
  const agentLines = lines.filter((line) => line.kind === 'agent')
  if (agentLines.length === 0) return null
  if (!agentLines.every((line) => line.diffScope === 'session')) return null
  return agentLines.reduce<RowDiff>(
    (total, line) => ({
      additions: total.additions + line.additions,
      deletions: total.deletions + line.deletions,
      fileEdits: total.fileEdits + line.changedFiles,
      scope: 'session',
    }),
    { additions: 0, deletions: 0, fileEdits: 0, scope: 'session' }
  )
}

/**
 * A row's lines, in the order they show: the terminals doing something first,
 * then by how recently each did anything, remote panes (which never say) last.
 * Past {@link MAX_TERMINAL_LINES} the rest fold into `overflow`.
 *
 * `rowDiff` is the row's own aggregate when every agent under it reports a
 * ledger (see {@link RowDiff}); null keeps the row exactly as it was. Nothing
 * draws it yet — the row's lines each carry their own numbers today.
 */
export function terminalLinesOf(input: {
  workspace: TerminalLinesWorkspace
  sessions: ReadonlyArray<TerminalSessionSnapshot>
  fleetPanes: ReadonlyArray<{ tabId: string; machineName: string; cli?: string }>
  summaries: Record<string, WorkspaceChangeSummary>
}): { lines: TerminalLine[]; overflow: number; rowDiff: RowDiff | null } {
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
  // Taken before the cap: a row with six agents reports all six.
  const rowDiff = rowDiffOf(lines)
  if (lines.length <= MAX_TERMINAL_LINES) return { lines, overflow: 0, rowDiff }
  return { lines: lines.slice(0, MAX_TERMINAL_LINES), overflow: lines.length - MAX_TERMINAL_LINES, rowDiff }
}
