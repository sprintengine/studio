// Part of the IPC contract: terminals, agent sessions, activity, process metrics and IPC stats.
// ../electron-api.ts re-exports everything here.

import type { AgentLaunchRecord } from '../agent-launch'
import type { BranchPullRequest } from '../git/pull-request'
import type { ObservedCheckout } from '../observed-checkout'
import type { AgentExecutionMode, CliPermissionPreset } from './agent-runtime'
import type { AgentCli } from './conversations'
import type { McpSettings } from './mcp'

export type TerminalKind = 'agent' | 'terminal'
export type TerminalPathStyle = 'posix' | 'windows' | 'wsl'
/**
 * Which runtime owns an agent session. `manual` is a session the app itself
 * launched; a capability module that runs its own agents names itself here.
 */
export type AgentSessionSystem = 'manual' | (string & {})

export type AgentSessionIdentity = {
  sessionId: string
  executionId: string
  system: AgentSessionSystem
  workspaceId: string
  workspaceRoot: string
  displayName: string
}

export type AgentSessionMetadata = Omit<AgentSessionIdentity, 'sessionId'> & {
  sessionId?: string
}

export type TerminalSpawnMetadata = {
  kind?: TerminalKind
  workspaceId?: string
  agentId?: string
  // The agent's session id within its CLI/harness, used as the resume token.
  // Distinct from the terminal-tracking `sessionId`; supplied on resume so the
  // CLI reattaches its own conversation. See TerminalSpawnPayload.cliSessionId.
  cliSessionId?: string
  // Agent display name, exposed to the session as SPRINTENGINE_AGENT_NAME for the
  // typed-handoff Backlog link label. See agentIdentityEnv (terminal-launch).
  agentName?: string
  terminalId?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  cliPermissionPreset?: CliPermissionPreset
  // Orthogonal Debug Mode toggle (the agent picker). Layers on top of the chosen
  // permission preset without changing its flags; the launch boundary prepends
  // the debug directive to the initial prompt when set. Transient per-spawn —
  // not persisted like cliPermissionPreset.
  debugMode?: boolean
  // Model id passed to the agent CLI when its plugin declares modelSelection;
  // undefined means the CLI's own default model.
  cliModel?: string
  // Reasoning-effort level passed to the agent CLI when its plugin declares
  // reasoningSelection; undefined means the CLI's own default effort, which
  // passes no flag. Travels with cliModel from the spawning surface.
  cliReasoning?: string
  memoryRootPath?: string
  memoryRelativeRoot?: string
  agentSession?: AgentSessionMetadata
  visible?: boolean
  mcpSettings?: McpSettings
  // True when `mcpSettings` is a connector launch's isolated single-server
  // config: the spawn prunes any other MCP server from the worktree config and
  // git-excludes it.
  // Undefined/false for ordinary spawns (workspace MCP merges as usual).
  connectorLaunch?: boolean
  // Skill-at-spawn (the composer's "+ Skill" attachment, or a scheduled
  // automation's skill): the builtin skill to ensure-install into the working
  // directory at spawn so the prefilled invocation resolves to a present skill.
  // Generalizes the debug-skill install; best-effort at the launch boundary and
  // carries none of the connector MCP coupling (no prune, no worktree .mcp.json
  // exclude). The invocation itself is prefilled renderer-side, never auto-sent.
  spawnSkillId?: string
}

export type SessionActivity =
  | { kind: 'working'; since: number }
  | { kind: 'idle'; since: number }
  | { kind: 'exited'; at: number; exitCode: number }
  | { kind: 'failed'; at: number; exitCode: number; message?: string }

// Authoritative agent phase, reported by the agent CLI's own lifecycle hooks
// (see backlog/2026-06-26-authoritative-agent-state-hooks.md). This is the
// richer, less ambiguous companion to `SessionActivity`: it can tell
// `awaiting_input` (blocked on a permission/prompt) apart from `idle` (turn
// finished) — a distinction output-scraping structurally cannot make.
export type AgentPhase =
  'starting' | 'thinking' | 'tool_use' | 'awaiting_input' | 'idle' | 'exited' | 'failed' | 'stalled'

/** Main's answer to a window's one-time registry hydration offer. */
export type WorkspaceRegistryHydrateResult = {
  changed: boolean
  reason: 'seeded' | 'already_present' | 'refused_dangerous_empty' | 'seeded_empty_intent'
  classification?: string
  seededWorkspaceCount?: number
  droppedRecordIds?: string[]
}

// Provenance for an AgentState. `hook` means the phase came from an
// authoritative lifecycle-hook frame; `inferred` means a lifecycle stamp —
// `starting` at spawn, `stalled` from the watchdog, `exited`/`failed` from the
// pty. Output-timing status inference was deleted (decision of record
// 2026-08-31): nothing ever guesses a phase from output recency.
export type AgentStateSource = 'hook' | 'lifecycle'

export type AgentState = {
  phase: AgentPhase
  since: number
  source: AgentStateSource
}

// The last prompt a person submitted to an agent session, captured from the
// CLI's `UserPromptSubmit` lifecycle hook. `text` is their verbatim typing,
// truncated to MAX_AGENT_PROMPT_LENGTH; `at` is when the hook reported it.
//
// Only CLIs whose reporter forwards the prompt supply this (Claude Code, Codex,
// Grok Build). A hookless or unsupported CLI simply never sets it, and every
// consumer treats absence as "nothing to show" rather than an error.
export type SessionPrompt = {
  text: string
  at: number
}

// One file this agent session has changed, as its own PostToolUse hooks
// reported it (Edit / Write / MultiEdit / NotebookEdit). The counts are
// CUMULATIVE sums of the hook's own diff hunks: a line edited twice counts
// twice, because the ledger answers "how much did this agent do", not "how far
// has the tree moved" — that second question is git's, and git is deliberately
// not consulted here (decision of record 2026-09-09). `edits` is the number of
// tool calls that touched the path, so a file rewritten ten times is
// distinguishable from one touched once.
//
// A subagent's edits count for the session that spawned it: the work is the
// session's. (Unlike the observed cwd, which a subagent's isolated worktree
// would falsify — see the reporter.)
export type SessionFileChange = {
  // Absolute path as the tool reported it. Never a patch or file content: the
  // ledger crosses a 64KB-per-frame socket and is broadcast to every window.
  path: string
  additions: number
  deletions: number
  edits: number
  lastEditedAt: number
}

// How much of the model's context window this session has consumed, as its own
// status line reports it. `at` is the moment the whole percent LAST MOVED, not
// the moment of the last reading — the CLI refreshes its status line after
// every assistant message, and a timestamp that advanced on each one would be
// a repaint per message for a number that had not changed.
export type SessionContextUsage = {
  usedPercentage: number
  at: number
}

export type TerminalSessionSnapshot = {
  sessionId: string
  processAlive: boolean
  kind: TerminalKind
  pathStyle?: TerminalPathStyle
  workspaceId?: string
  agentId?: string
  // Display name from spawn metadata. The session-manager label for agent
  // sessions whose agentId has no workspace.agents record (e.g. an agent main
  // spawned without this window's knowledge).
  agentName?: string
  terminalId?: string
  // The agent's session id within its own CLI/harness (the id used to resume the
  // conversation), captured from lifecycle hooks. Distinct from `sessionId`,
  // which is the studio's own terminal-tracking id. Equal to it for Claude (we mint
  // and pass the id); minted by the harness and learned post-launch for Codex etc.
  cliSessionId?: string
  cli?: AgentCli
  cwd?: string
  executionMode?: AgentExecutionMode
  worktreeId?: string
  worktreePath?: string
  // Where the session's own hooks last saw it, resolved through git into the
  // checkout containing that cwd. Distinct from the launch-intent
  // fields above (`cwd`, `worktreePath`): an agent that creates a worktree and
  // moves into it, or is launched by hand into one the app did not make, is
  // only describable here. Absent for plain terminals and for CLIs whose hooks
  // carry no cwd; `resolved: false` until git has answered.
  observedCheckout?: ObservedCheckout
  agentSession?: AgentSessionIdentity
  // Present only on sessions the main-process AgentLaunchService composed:
  // the launch decisions main made — name, CLI, model, permission
  // preset, connector environment. The renderer projects these into
  // an AgentState so a headless-launched agent gets a tab it never created, and
  // so a window opened after the launch sees the same agent the launch made.
  // Absent for renderer-launched agents (which already own their record) and
  // for plain terminals.
  agentRecord?: AgentLaunchRecord
  visible: boolean
  // Freeze-the-view: agent process killed to reclaim memory, scrollback kept
  // painted, resumable on keystroke. `processAlive` is false while suspended.
  suspended: boolean
  // User lock ("keep running"): the reaper never suspends or disposes this
  // session while set. Session-scoped — toggled from the terminal's lock
  // control; does not survive an app restart (the process it protects doesn't
  // either).
  reapExempt: boolean
  startedAt: number
  lastOutputAt: number | null
  lastInputAt: number | null
  lastVisibleAt: number | null
  // When the agent's last turn ended — the hook-reported Stop, epoch ms. Kept
  // apart from `activity`, which the reaper's suspend and the quit path
  // overwrite with the moment the PROCESS died, so a parked chat can say when
  // it actually finished. Survives suspend, resume and an app restart (carried
  // in the snapshot sidecar). Absent for plain terminals and before the first
  // turn end.
  lastTurnEndedAt?: number | null
  activity: SessionActivity
  // Authoritative phase from lifecycle hooks, when available. Absent for
  // sessions whose CLI emits no hooks (the legacy idle-timer `activity` above
  // remains the floor). `source` distinguishes hook truth from inference.
  agentState?: AgentState
  // The last prompt submitted to this session. Absent for plain terminals and
  // for CLIs whose reporter does not forward one.
  lastPrompt?: SessionPrompt
  // What this session has edited, newest-edited first (by the order the edits
  // were observed, which differs from their timestamps only by socket delivery
  // skew). Fed by the CLI's own
  // PostToolUse hooks, so it is empty for plain terminals, for hookless CLIs,
  // and for an agent that has not written anything yet — never absent, so a
  // consumer can count without a guard. Bounded (see MAX_SESSION_FILE_CHANGES);
  // survives an app restart with the session parked, and starts over when the
  // pty is respawned.
  fileChanges: SessionFileChange[]
  // The pull requests this conversation has, newest first (epic
  // `pull-request-marks`, decision 10): the union of the ones on the repository
  // and branch its checkout is observed to be on and the ones it opened itself
  // in ANY repository (`cd ../website && gh pr create` is a real thing an agent
  // does), de-duplicated by URL. Main owns the fact — see
  // `main/pull-request-record.ts` — and the list is empty for a plain terminal,
  // for a session whose checkout is not resolved yet, and for a branch GitHub
  // says has none. Nothing is ever drawn from an absent answer: a lookup that
  // could not be made leaves the last known list standing rather than emptying
  // it.
  //
  // Optional on the wire only because fixtures across the app build a snapshot
  // literal; every snapshot main sends carries the array. A later phase can
  // tighten it once those fixtures name the field.
  pullRequests?: BranchPullRequest[]
  // Subagents this session started and has not seen stop — the count main
  // already keeps to hold a turn end open while background work runs, surfaced
  // so a row can say "3 running" instead of a bare spinner. Zero for plain
  // terminals and for CLIs that report no subagent events.
  activeSubagents: number
  // Context-window usage, from the session's own status line. Null for a plain
  // terminal, for a CLI with no status line, for one whose person's status line
  // could not be wrapped, and for a session that has not made an API call yet —
  // never a guess. A /compact does NOT clear it: the CLI reports no percentage
  // for a moment afterwards, and "not known right now" is not "empty", so the
  // last known reading stands until a real one replaces it.
  contextUsage: SessionContextUsage | null
  exitedAt: number | null
  outputBufferLength: number
  retainedOutputBytes: number
  historyTier?: 'standard' | 'recent'
  replayLimitBytes?: number
}

/**
 * One changed session on `terminal:sessions-delta`: its snapshot, with the two
 * lists present only when they moved since the session was last broadcast. An
 * absent list means "unchanged — keep the one you have", never "empty".
 */
export type TerminalSessionDeltaEntry = Omit<TerminalSessionSnapshot, 'fileChanges' | 'pullRequests'> & {
  fileChanges?: SessionFileChange[]
  pullRequests?: BranchPullRequest[]
}

/**
 * What changed among the sessions since the last broadcast: the sessions that
 * changed, and the ids of those that are gone. The full list is
 * `terminal:list`, which a window reads once when it subscribes and on its
 * recovery poll.
 */
export type TerminalSessionsDelta = {
  upserts: TerminalSessionDeltaEntry[]
  removed: string[]
}

// One process row from Electron's app.getAppMetrics() plus throttled child
// process tree sampling. `kind` maps Electron's process type and known spawned
// child categories to the roles operators reason about: 'main' (Browser),
// 'renderer' (Tab), 'gpu', 'utility', terminal/agent/helper children, and
// 'other'. `cpuPercent` is the rolling CPU share since the previous metrics
// sample for Electron rows, and best-effort OS CPU% for child rows. `threads` is
// populated from a throttled, off-poll OS sample (macOS `ps -M`, Linux /proc) —
// not on the 1s poll, since per-poll ps/lsof would add the overhead the panel
// exists to measure. `fileDescriptors` remains undefined (same per-poll-cost
// reason).
export type ProcessMetricKind = 'main' | 'renderer' | 'gpu' | 'utility' | 'agent' | 'terminal' | 'helper' | 'other'

export type ProcessMetricSample = {
  pid: number
  kind: ProcessMetricKind
  // Electron's raw process type ('Browser' | 'Tab' | 'GPU' | 'Utility' | …) and
  // the utility/service name when present, so the panel can disambiguate
  // multiple renderers/utilities without guessing.
  type: string
  name?: string
  cpuPercent: number
  // Reported process memory in bytes. Electron rows use Electron working set
  // (reported in KB and converted by main); spawned child rows use OS RSS. On
  // macOS neither should be treated as Activity Monitor physical footprint.
  memoryBytes: number
  threads?: number
  fileDescriptors?: number
  // V8 heap detail, currently populated only for the main process (from
  // process.memoryUsage() in the IPC handler). getAppMetrics does not expose
  // per-renderer heap; the renderer's own heap is sampled separately via
  // performance.memory in the metrics-history store.
  heapUsedBytes?: number
  heapTotalBytes?: number
}

// OS-wide memory, sampled out-of-band (getAppMetrics only covers Electron's own
// processes). This is what actually predicts system exhaustion across every app.
// `availableBytes`/`utilizationRatio` are best-effort availability estimates;
// they are not the operating system's memory-pressure signal. `source` records
// how they were derived ('vm_stat' macOS, 'proc' linux, 'os' fallback).
export type SystemMemorySample = {
  totalBytes: number
  availableBytes: number
  usedBytes: number
  compressedBytes: number
  swapUsedBytes: number
  // 0..1 estimated utilization: 1 - available/total. On Darwin, available
  // includes free + speculative + inactive + purgeable pages, so usedBytes is
  // an estimated non-reclaimable amount rather than Activity Monitor "Memory
  // Used" and this ratio must never be labelled OS memory pressure.
  utilizationRatio: number
  source: 'vm_stat' | 'proc' | 'os'
}

// One terminal/agent's real process cost, attributed to its workspace. The
// memory is the RSS of the pty's whole subtree (the CLI plus any MCP/dev-server
// children), summed in the main process where pids and sessions meet.
export type WorkspaceTerminalMemorySample = {
  sessionId: string
  kind: TerminalKind
  cli: AgentCli | null
  agentId: string | null
  terminalId: string | null
  activityKind: string
  processAlive: boolean
  memoryBytes: number
  startedAt: number
}

// Per-workspace rollup of resident agent/terminal memory. Only live sessions
// contribute; shared overhead (main/renderer/GPU) is intentionally not
// attributed, so the sum is "what this workspace's terminals cost", not the
// whole app.
export type WorkspaceMemorySample = {
  workspaceId: string
  // At least one live agent PTY — the same "hot" signal the sidebar bolds.
  resident: boolean
  totalMemoryBytes: number
  // Earliest startedAt across the workspace's live terminals ("live for …").
  becameLiveAt: number | null
  terminals: WorkspaceTerminalMemorySample[]
}

// One terminal the main-process reaper acted on, kept in a bounded ring buffer
// so the diagnostics panel can show an audit trail of what was reaped and from
// which workspace. `idle-suspend` is the memory-bounded sweep
// (`runIdleAgentReapSweep`) suspending an idle agent outside the hot set;
// `idle-dispose` is the same sweep DISPOSING an idle module-driven agent (it
// leaves → revives via dispatch rather than freezing the view);
// `stale-dispose` is the 24h backstop (`reapStaleTerminals`). The
// suspend reasons preserve the agent's resume flags so it relaunches with
// `--resume` on reopen.
export type TerminalReapReason = 'idle-suspend' | 'idle-dispose' | 'stale-dispose'

export type TerminalReapEvent = {
  reapedAt: number
  reason: TerminalReapReason
  sessionId: string
  workspaceId: string | null
  agentId: string | null
  terminalId: string | null
  cli: string | null
  kind: string
  // Idle window (ms since last real interaction) that triggered an idle-suspend.
  idleMs?: number
  // Unseen window (ms since last seen) that triggered a stale-dispose.
  unseenMs?: number
}

export type ProcessMetricsSnapshot = {
  sampledAt: number
  // Best-effort: empty when app.getAppMetrics() is unavailable in the current
  // runtime rather than throwing, so the panel degrades to "unavailable".
  processes: ProcessMetricSample[]
  // Best-effort: omitted until the first out-of-band sample lands.
  systemMemory?: SystemMemorySample
  // Best-effort: per-workspace RSS attribution; omitted until the first sample.
  workspaceMemory?: WorkspaceMemorySample[]
  // Most-recent-first audit trail of terminals the reaper suspended/disposed
  // this session (bounded). Omitted when nothing has been reaped yet.
  reapEvents?: TerminalReapEvent[]
}

// Per-api-method IPC accounting, accumulated in the preload (see preload/ipcStats).
// Counts are monotonic since process start; the renderer diffs consecutive
// snapshots to derive per-second rates.
export type IpcChannelStat = {
  name: string
  calls: number
  outBytes: number
  inEvents: number
  inBytes: number
}

export type IpcStatsSnapshot = {
  sampledAt: number
  channels: IpcChannelStat[]
}

export type TerminalSpawnResult =
  { ok: true; sessionId: string } | { ok: false; sessionId: string; message: string; exitCode: number }

export type GitFileStatus = 'new' | 'modified' | 'deleted' | 'renamed' | 'conflicted'
