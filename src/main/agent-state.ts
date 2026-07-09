import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import type { AgentPhase, AgentState, AgentStateSource, SessionActivity } from '../shared/electron-api'

// =============================================================================
// Authoritative agent state — pure core (no Electron deps, fully unit-testable)
//
// This module owns three concerns that need no main-process runtime:
//   1. The hook event → AgentPhase mapping (the detection vocabulary).
//   2. The AgentPhase → legacy SessionActivity bridge (so existing consumers
//      keep working untouched while the richer phase rides alongside).
//   3. Validating an untrusted reporter frame and (un)installing the reporter
//      hook into a workspace's .claude/settings.local.json.
//
// The Electron-bound half (the socket listener + session resolution + renderer
// broadcast + launch-time install) lives in a sibling service module so this
// stays importable from a plain Node test harness.
// =============================================================================

export const AGENT_STATE_HOOK_TAG = 'multicode-agent-state'

// Where the reporter script is copied inside a workspace. The reporter also
// honours a MULTICODE_AGENT_STATE_SOCKET env fallback (see the .mjs), but the
// install always passes the socket via --socket, so it is not referenced here.
export const AGENT_STATE_HOOK_SCRIPT_REL = join('.multicode', 'hooks', 'agent-state.mjs')

const CLAUDE_LOCAL_SETTINGS_REL = join('.claude', 'settings.local.json')

// The Claude Code lifecycle events we register the reporter for. One reporter
// command is registered under every event — it reads `hook_event_name` from the
// hook payload to know which phase to report.
//
// `PreToolUse` and `PostToolUse` each fire once per tool call — equal frequency.
// We drop `PreToolUse` and keep `PostToolUse`, not because one is rarer, but
// because of what each produces:
//
//   - `PreToolUse` is pure overhead here: its only product is the
//     `thinking ↔ tool_use` distinction, which bridges to the same `working`
//     activity, is deduped by the renderer, and is surfaced nowhere.
//   - `PostToolUse` is load-bearing: after the user answers a permission prompt
//     (`Notification` → awaiting_input), its `→ thinking` frame is the ONLY
//     signal that clears `awaiting_input` mid-turn — the agent resumes with no
//     other hook frame until `Stop`, and output never writes `agentState.phase`.
//     Dropping it leaves the "needs input" indicator falsely lit until turn end.
//
// So this halves the per-tool reporter spawns (2 → 1) by dropping the one we
// don't need; it does NOT eliminate them. The broadcast-storm guard in
// `ingestAgentStateFrame` keeps the remaining PostToolUse churn from causing
// snapshot IPCs. Eliminating the last per-tool spawn entirely needs a cheaper
// reporter (native binary) or an output-based resume signal — separate backlog.
export const AGENT_STATE_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SubagentStop' },
  { event: 'SessionEnd' },
]

// =============================================================================
// Event → phase mapping keeps runtime events in one shared vocabulary
// =============================================================================

// Claude Code's `Notification` event is overloaded: it fires for a real
// permission/elicitation prompt (the agent is genuinely blocked on the user) AND
// for purely informational reasons — most importantly the `idle_prompt` "waiting
// for your input" nudge that fires ~60s after the agent already Stopped (→ idle).
// The documented, stable `notification_type` field distinguishes them
// (https://code.claude.com/docs/en/hooks.md). We ALLOW-LIST the genuinely
// blocking types rather than deny-listing informational ones: `awaiting_input`
// is sticky for a dormant agent (only a later PostToolUse/Stop clears it, and a
// stopped agent emits neither), so one unlisted informational type used to park
// a session as falsely "needs input" forever — including exempting it from the
// idle reaper (the 2026-07-07 parked-agents incident). An unknown/absent
// `notification_type` now drops (prior phase stands); if a future Claude build
// adds a new BLOCKING type, add it here — the failure mode until then is an
// agent that reads idle while prompting, recoverable via resume-on-keystroke.
// Documented types as of 2026-07-08: permission_prompt, idle_prompt,
// auth_success, elicitation_dialog, elicitation_complete, elicitation_response,
// agent_needs_input, agent_completed. The reporters (.mjs) MUST mirror this set.
export const AWAITING_INPUT_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'agent_needs_input',
])

export function mapHookEventToPhase(event: string, notificationType?: string | null): AgentPhase | null {
  switch (event) {
    case 'SessionStart':
      return 'starting'
    case 'UserPromptSubmit':
      return 'thinking'
    case 'PreToolUse':
      return 'tool_use'
    case 'PostToolUse':
      // No discrete "thinking-start" hook exists; the interval between a tool
      // finishing and the next PreToolUse/Stop is the model thinking.
      return 'thinking'
    case 'Notification':
      // Only a known-blocking notification is an attention request; anything
      // else (informational, unknown, or untyped) drops so the prior phase
      // stands — see the allow-list rationale above.
      if (notificationType && AWAITING_INPUT_NOTIFICATION_TYPES.has(notificationType)) return 'awaiting_input'
      return null
    case 'PermissionRequest':
      return 'awaiting_input'
    case 'Stop':
    case 'SubagentStop':
      return 'idle'
    case 'SessionEnd':
      return 'exited'
    default:
      return null
  }
}

// =============================================================================
// Phase → legacy SessionActivity bridge
//
// Keeps the existing 4-variant activity field honest from the richer phase so
// every current consumer (sidebar bolding, reaping, diagnostics) keeps working.
// Returns null for terminal phases (`exited`/`failed`): a real process exit is
// owned authoritatively by the pty onExit handler, which carries the exit code
// a hook frame does not — we never synthesize an exit from a hook.
// =============================================================================

// True when an authoritative hook phase says the agent is actively working, so
// the legacy output idle-timer must NOT override it to idle — the Stop hook
// reports the real idle transition and the stall watch catches a genuine hang.
// Inferred or absent state never qualifies, so non-hook sessions are unaffected.
export function isAuthoritativeWorkingPhase(state: AgentState | undefined): boolean {
  return state?.source === 'hook' && (state.phase === 'tool_use' || state.phase === 'thinking')
}

// At-rest phases the idle reaper may reclaim once rested past its threshold:
// 'idle' (authoritative turn end) and 'stalled' (inferred quiet ≥90s). Stalled
// counts as rest deliberately — a lost Stop frame lands a genuinely-finished
// agent there, and treating stalled as protected parked sessions forever
// (2026-07-07 incident). Shared by the reap candidate mapping and the
// sprint-agent inactive-run guard so the two can't drift.
export function isAtRestAgentPhase(phase: AgentPhase | null | undefined): boolean {
  return phase === 'idle' || phase === 'stalled'
}

export function deriveActivityFromPhase(phase: AgentPhase, since: number): SessionActivity | null {
  switch (phase) {
    case 'starting':
    case 'thinking':
    case 'tool_use':
      return { kind: 'working', since }
    case 'awaiting_input':
    case 'idle':
    case 'stalled':
      return { kind: 'idle', since }
    case 'exited':
    case 'failed':
      return null
    default:
      return null
  }
}

// =============================================================================
// Stall evaluation (pure; the runtime drives the timer from this decision)
//
// A hook-reported working phase (`starting`/`thinking`/`tool_use`) that goes
// quiet — no newer frame and no terminal output — past the threshold is treated
// as stalled. Output advancing `lastOutputAt` (a streaming tool, a startup
// banner) or a newer frame keeps it alive; the runtime re-checks after the
// returned delay rather than firing once. `starting` is included so a resumed
// session that never receives a prompt (SessionStart is its only frame — no
// Stop ever follows) converts to `stalled` and becomes reclaimable via the
// reap policy's stalled expiry, instead of parking as "working" forever.
// =============================================================================

export type StallEvaluation =
  | { action: 'stalled' }
  | { action: 'recheck'; afterMs: number }
  | { action: 'clear' }

export function evaluateAgentStall(input: {
  phase: AgentPhase
  source: AgentStateSource
  phaseSince: number
  lastOutputAt: number | null
  now: number
  thresholdMs: number
}): StallEvaluation {
  // Only a hook-driven working phase can stall; anything else means the agent is
  // responsive (idle/awaiting), already terminal, or running on inference.
  if (input.source !== 'hook') return { action: 'clear' }
  if (input.phase !== 'starting' && input.phase !== 'thinking' && input.phase !== 'tool_use') {
    return { action: 'clear' }
  }
  const lastActivityAt = Math.max(input.phaseSince, input.lastOutputAt ?? 0)
  const quietForMs = input.now - lastActivityAt
  if (quietForMs >= input.thresholdMs) return { action: 'stalled' }
  return { action: 'recheck', afterMs: input.thresholdMs - quietForMs }
}

// =============================================================================
// Untrusted frame validation
//
// Frames arrive over a local socket from a reporter process. Treat every field
// as untrusted data: validate shape and the phase enum, never act on anything
// beyond the typed fields below.
// =============================================================================

// A self-scheduled wakeup reported by the CLI's PostToolUse hook (Claude Code's
// ScheduleWakeup tool; Codex shares the hook payload schema, and the OpenCode
// adapter can emit the same field if that CLI grows an equivalent). `stop`
// tears the loop down; `delaySeconds` arms a timer inside the CLI process.
export type AgentStateFrameWakeup = { stop: true } | { delaySeconds: number }

// ScheduleWakeup's runtime clamps delaySeconds to [60, 3600]. Anything past
// clamp+slack is a reporter/clock anomaly — cap it so one bad frame cannot
// park a session on a far-future hold.
export const MAX_WAKEUP_DELAY_SECONDS = 2 * 3600

export type AgentStateFrame = {
  type: 'agent_state'
  agentId: string
  workspaceId: string | null
  sessionId: string | null
  phase: AgentPhase
  event: string | null
  ts: number
  wakeup?: AgentStateFrameWakeup
}

const VALID_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'starting',
  'thinking',
  'tool_use',
  'awaiting_input',
  'idle',
  'exited',
  'failed',
  'stalled',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function parseAgentStateFrame(raw: unknown, now: number): AgentStateFrame | null {
  if (!isRecord(raw)) return null
  if (raw.type !== 'agent_state') return null
  const agentId = optionalString(raw.agentId)
  if (!agentId) return null
  const phase = raw.phase
  if (typeof phase !== 'string' || !VALID_PHASES.has(phase as AgentPhase)) return null
  // Clamp to server arrival time: raw.ts is reporter-supplied and compared
  // cross-clock against the main-process clock (terminal-runtime drops frames
  // where since > frame.ts, and since is written from Date.now()). A far-future
  // ts would pin the phase forever and future-date "working since"; a reporter
  // cannot legitimately be ahead of now, so cap it.
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? Math.min(raw.ts, now) : now
  const frame: AgentStateFrame = {
    type: 'agent_state',
    agentId,
    workspaceId: optionalString(raw.workspaceId),
    sessionId: optionalString(raw.sessionId),
    phase: phase as AgentPhase,
    event: optionalString(raw.event),
    ts,
  }
  const wakeup = parseFrameWakeup(raw.wakeup)
  if (wakeup) frame.wakeup = wakeup
  return frame
}

// A malformed wakeup drops (frame stands without it) — the reporter is
// untrusted, and a bogus hold is worse than a missed one: it parks a session.
function parseFrameWakeup(raw: unknown): AgentStateFrameWakeup | null {
  if (!isRecord(raw)) return null
  if (raw.stop === true) return { stop: true }
  if (typeof raw.delaySeconds === 'number' && Number.isFinite(raw.delaySeconds) && raw.delaySeconds > 0) {
    return { delaySeconds: Math.min(raw.delaySeconds, MAX_WAKEUP_DELAY_SECONDS) }
  }
  return null
}

// =============================================================================
// Frame → session resolution (pure; tested independently of the runtime)
//
// The reporter frame carries MULTICODE_AGENT_ID — for an interactively-launched
// agent that equals the session's agentId; we also match the execution and PTY
// session ids so resolution is robust to launch paths that key identity
// differently. When more than one live session matches the same id (e.g. a
// relaunch reusing it), prefer the one in the reported workspace, then the most
// recently started.
// =============================================================================

export type AgentStateCandidate<T> = {
  value: T
  agentId?: string
  executionId?: string
  sessionId?: string
  workspaceId?: string
  startedAt: number
}

function candidateMatchesAgent<T>(candidate: AgentStateCandidate<T>, agentId: string): boolean {
  return candidate.agentId === agentId || candidate.executionId === agentId || candidate.sessionId === agentId
}

export function selectAgentStateTarget<T>(
  candidates: ReadonlyArray<AgentStateCandidate<T>>,
  frame: { agentId: string; workspaceId: string | null }
): T | undefined {
  const matches = candidates.filter((candidate) => candidateMatchesAgent(candidate, frame.agentId))
  if (matches.length <= 1) return matches[0]?.value
  const scoped = frame.workspaceId
    ? matches.filter((candidate) => candidate.workspaceId === frame.workspaceId)
    : matches
  const pool = scoped.length > 0 ? scoped : matches
  return pool.reduce((latest, candidate) => (candidate.startedAt > latest.startedAt ? candidate : latest)).value
}

// =============================================================================
// settings.local.json merge / unmerge (idempotent, tagged)
//
// Mirrors the proven pattern in memory-activity.ts: preserve every hook the user
// or another feature configured, replace only our prior tagged entries, and
// drop emptied blocks/events on uninstall so nothing dangles.
// =============================================================================

type ClaudeHookEntry = {
  type: 'command'
  command: string
  _multicode?: string
}

type ClaudeMatcherBlock = {
  matcher?: string
  hooks?: ClaudeHookEntry[]
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeMatcherBlock[]>
  [key: string]: unknown
}

// Raw shell command both install paths embed (Claude into JSON, Codex into TOML).
// `scriptPath` MUST be absolute: hook commands run with no guaranteed cwd (the
// session's working directory can drift into a subdirectory mid-run), so a
// workspace-relative path would misresolve and fail with MODULE_NOT_FOUND. The
// path is normalized to forward slashes (Node accepts them everywhere, incl.
// `C:/...` on Windows, which also avoids embedding unescaped backslashes).
// `socketPath` is VERBATIM: on Windows it is a `\\.\pipe\...` named pipe whose
// backslashes must survive (a separator rewrite would corrupt it to
// `//./pipe/...`, which connect() can't open); on POSIX it has none. Both args
// are double-quoted so spaces survive the shell.
export function buildAgentStateReporterCommand(scriptPath: string, socketPath: string): string {
  return `node "${scriptPath.split(sep).join('/')}" --socket "${socketPath}"`
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    const text = await readFile(path, 'utf8')
    if (!text.trim()) return {} as T
    return JSON.parse(text) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function isAgentStateEntry(entry: ClaudeHookEntry): boolean {
  return entry?._multicode === AGENT_STATE_HOOK_TAG
}

function ensureMatcherBlock(blocks: ClaudeMatcherBlock[], matcher: string | undefined): ClaudeMatcherBlock {
  const found = blocks.find((b) => b.matcher === matcher)
  if (found) {
    if (!Array.isArray(found.hooks)) found.hooks = []
    return found
  }
  const next: ClaudeMatcherBlock = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }
  blocks.push(next)
  return next
}

// Remove every Multicode-tagged reporter entry from ALL event keys, pruning
// emptied matcher-blocks and then emptied event keys. Sweeping all keys — rather
// than only the currently-registered AGENT_STATE_HOOK_EVENTS — self-heals an
// entry left behind by a prior release that registered an event we have since
// dropped (e.g. PreToolUse). Without this, that stale hook would keep spawning
// the reporter on every tool call and uninstall could never reach it.
function stripAgentStateEntries(hooks: Record<string, ClaudeMatcherBlock[]>): void {
  for (const event of Object.keys(hooks)) {
    const blocks = hooks[event]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue
      block.hooks = block.hooks.filter((entry) => !isAgentStateEntry(entry))
    }
    const kept = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
    if (kept.length === 0) delete hooks[event]
    else hooks[event] = kept
  }
}

export async function mergeAgentStateHooks(settingsPath: string, command: string): Promise<void> {
  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) ?? {}
  const settings: ClaudeSettings = { ...existing }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

  // Clean up first (incl. entries for events we no longer register), then add the
  // current set — so install is both idempotent and a migration for stale hooks.
  stripAgentStateEntries(settings.hooks)

  for (const { event, matcher } of AGENT_STATE_HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = []
    const blocks = settings.hooks[event]
    const block = ensureMatcherBlock(blocks, matcher)
    const ours: ClaudeHookEntry = { type: 'command', command, _multicode: AGENT_STATE_HOOK_TAG }
    const filtered = (block.hooks ?? []).filter((entry) => !isAgentStateEntry(entry))
    filtered.push(ours)
    block.hooks = filtered
  }

  await mkdir(resolve(settingsPath, '..'), { recursive: true })
  await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

export async function unmergeAgentStateHooks(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing?.hooks || typeof existing.hooks !== 'object') return

  // Sweep ALL event keys (not just the currently-registered ones) so uninstall
  // also removes hooks left by an older release under a since-dropped event.
  stripAgentStateEntries(existing.hooks)
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks

  await writeFile(settingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf8')
}

// =============================================================================
// Install / uninstall
//
// The caller (the Electron-bound service) resolves the bundled reporter script
// path and the live socket path; this stays free of Electron so it is testable.
// =============================================================================

export type AgentStateInstallResult =
  | { ok: true; settingsPath: string; hookScriptPath: string }
  | { ok: false; message: string }

export async function installAgentStateHook(
  workspaceRoot: string,
  options: { sourceScriptPath: string; socketPath: string }
): Promise<AgentStateInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!options.socketPath?.trim()) return { ok: false, message: 'Agent-state socket path is required.' }
  if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
    return { ok: false, message: 'Agent-state reporter script is missing from this build.' }
  }

  try {
    const hookDir = resolve(workspaceRoot, '.multicode', 'hooks')
    await mkdir(hookDir, { recursive: true })
    const destScript = resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
    await copyFile(options.sourceScriptPath, destScript)

    // Reference the reporter by its ABSOLUTE path (the dir we just copied it to),
    // not a workspace-relative path: hook commands run with no guaranteed cwd, so
    // a relative path breaks the moment the session's cwd drifts off the root.
    // This mirrors the Codex install path below.
    const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL)
    await mergeAgentStateHooks(settingsPath, buildAgentStateReporterCommand(destScript, options.socketPath))

    return { ok: true, settingsPath, hookScriptPath: destScript }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install agent-state hook.',
    }
  }
}

export async function uninstallAgentStateHook(workspaceRoot: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  try {
    const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL)
    if (existsSync(settingsPath)) await unmergeAgentStateHooks(settingsPath)
    const destScript = resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
    if (existsSync(destScript)) await rm(destScript, { force: true })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to uninstall agent-state hook.',
    }
  }
}

// =============================================================================
// Codex install path (Phase 2)
//
// Codex shipped lifecycle hooks with the same event schema + stdin payload as
// Claude Code (hook_event_name / session_id), but configured as TOML in
// .codex/config.toml rather than JSON. So the reporter script and the runtime
// ingestion are unchanged — only the injection target differs. We write a single
// tagged managed block (own markers, never the MCP block's) so the rest of the
// user's config.toml is preserved and the block is idempotently replaceable —
// the same discipline the MCP writer uses, which avoids the known footgun of an
// installer corrupting config.toml.
// =============================================================================

const CODEX_CONFIG_REL = join('.codex', 'config.toml')
const CODEX_AGENT_STATE_START = '# >>> multicode agent-state hooks managed'
const CODEX_AGENT_STATE_END = '# <<< multicode agent-state hooks managed'

// Codex uses `PermissionRequest` (not Claude's `Notification`) for the
// awaiting-input case, and has no `SessionEnd` (process exit is owned by the pty
// exit listener). The reporter already maps PermissionRequest → awaiting_input.
// `PreToolUse` is dropped and `PostToolUse` kept for the same reasons as Claude
// above — see AGENT_STATE_HOOK_EVENTS. PostToolUse → thinking is what clears
// awaiting_input after a PermissionRequest is answered.
export const AGENT_STATE_CODEX_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PermissionRequest' },
  { event: 'Stop' },
  { event: 'SubagentStop' },
]

// TOML basic strings share JSON's escaping (matches the repo's MCP writer), so
// JSON.stringify yields a valid quoted value — and correctly escapes the Windows
// pipe path's backslashes.
function tomlBasicString(value: string): string {
  return JSON.stringify(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function renderCodexAgentStateHooksBlock(command: string): string {
  const lines: string[] = [
    CODEX_AGENT_STATE_START,
    '# Generated by Multicode for authoritative agent-state reporting. Remove this block to disable.',
  ]
  for (const { event, matcher } of AGENT_STATE_CODEX_HOOK_EVENTS) {
    lines.push('', `[[hooks.${event}]]`)
    if (matcher !== undefined) lines.push(`matcher = ${tomlBasicString(matcher)}`)
    lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlBasicString(command)}`)
  }
  lines.push(CODEX_AGENT_STATE_END)
  return lines.join('\n')
}

// Replace (or, with an empty block, remove) our managed hooks block, preserving
// everything else in the file. Mirrors the MCP writer's replaceManagedBlock.
function replaceCodexAgentStateBlock(previous: string, block: string): string {
  const pattern = new RegExp(`${escapeRegExp(CODEX_AGENT_STATE_START)}[\\s\\S]*?${escapeRegExp(CODEX_AGENT_STATE_END)}\\n?`, 'm')
  const trimmed = previous.replace(pattern, '').trimEnd()
  if (!block) return trimmed ? `${trimmed}\n` : ''
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
}

export function mergeCodexAgentStateHooks(previous: string, command: string): string {
  return replaceCodexAgentStateBlock(previous, renderCodexAgentStateHooksBlock(command))
}

export function unmergeCodexAgentStateHooks(previous: string): string {
  return replaceCodexAgentStateBlock(previous, '')
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function installCodexAgentStateHook(
  workspaceRoot: string,
  options: { sourceScriptPath: string; socketPath: string }
): Promise<AgentStateInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!options.socketPath?.trim()) return { ok: false, message: 'Agent-state socket path is required.' }
  if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
    return { ok: false, message: 'Agent-state reporter script is missing from this build.' }
  }

  try {
    const hookDir = resolve(workspaceRoot, '.multicode', 'hooks')
    await mkdir(hookDir, { recursive: true })
    const destScript = resolve(workspaceRoot, AGENT_STATE_HOOK_SCRIPT_REL)
    await copyFile(options.sourceScriptPath, destScript)

    // Codex hook commands run without a guaranteed cwd, so reference the reporter
    // by its absolute path (vs the workspace-relative path Claude uses).
    const command = buildAgentStateReporterCommand(destScript, options.socketPath)
    const configPath = resolve(workspaceRoot, CODEX_CONFIG_REL)
    await mkdir(resolve(configPath, '..'), { recursive: true })
    const previous = (await readTextIfExists(configPath)) ?? ''
    await writeFile(configPath, mergeCodexAgentStateHooks(previous, command), 'utf8')

    return { ok: true, settingsPath: configPath, hookScriptPath: destScript }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install Codex agent-state hook.',
    }
  }
}

export async function uninstallCodexAgentStateHook(
  workspaceRoot: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  try {
    const configPath = resolve(workspaceRoot, CODEX_CONFIG_REL)
    const previous = await readTextIfExists(configPath)
    if (previous !== null) await writeFile(configPath, unmergeCodexAgentStateHooks(previous), 'utf8')
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to uninstall Codex agent-state hook.',
    }
  }
}

// =============================================================================
// OpenCode install path (Phase 3)
//
// OpenCode has no command-hook mechanism like Claude/Codex (no per-event command
// fed a JSON stdin payload). Instead it auto-loads in-process JS plugins from
// .opencode/plugin/ and exposes a typed event stream. So the OpenCode reporter is
// a *plugin* (resources/hooks/opencode-agent-state.mjs) that maps OpenCode events
// to the same AgentPhase vocabulary and writes the same socket frame — the
// runtime ingestion is unchanged. A plugin can't take a --socket arg, so the live
// socket path is baked into the plugin file at install time (token substitution);
// the plugin also honours MULTICODE_AGENT_STATE_SOCKET as a fallback.
//
// The dest extension is .js, not .mjs: OpenCode's loader picks up .js/.ts from
// .opencode/plugin but not .mjs (verified against opencode v1.17.11). The bundled
// template ships as .mjs (the packaging filter is **/*.mjs) and is rewritten to
// .js on install, so source and dest extensions intentionally differ.
// =============================================================================

export const OPENCODE_PLUGIN_REL = join('.opencode', 'plugin', 'multicode-agent-state.js')

// The quoted token in the plugin template that install replaces with the live
// socket path. Replacing the WHOLE quoted literal with JSON.stringify(path) keeps
// the value valid even for a Windows pipe path full of backslashes (splicing a
// bare string back inside the quotes would let those backslashes act as JS
// escapes and corrupt the path).
const OPENCODE_SOCKET_PLACEHOLDER = "'__MULTICODE_AGENT_STATE_SOCKET__'"

// OpenCode's lifecycle events differ from Claude/Codex; map them to the same
// AgentPhase vocabulary. The plugin reporter MUST mirror this.
//   - `message.updated` is the working signal — OpenCode has no discrete
//     thinking-start event; an updating message means the model is producing.
//   - `permission.replied → thinking` is load-bearing: it's the only signal that
//     clears awaiting_input mid-turn after the user answers a prompt (the analog
//     of Claude's PostToolUse → thinking).
//   - No event maps to `exited`: a real process exit is owned authoritatively by
//     the pty exit listener (same as Codex).
export function mapOpencodeEventToPhase(type: string): AgentPhase | null {
  switch (type) {
    case 'session.created':
      return 'starting'
    case 'message.updated':
      return 'thinking'
    case 'permission.updated':
      return 'awaiting_input'
    case 'permission.replied':
      return 'thinking'
    case 'session.idle':
    case 'session.error':
      return 'idle'
    default:
      return null
  }
}

// Extract the OpenCode session id from an event payload. Events carry it
// differently: most as `properties.sessionID`; session.* lifecycle events as
// `properties.info.id` (a Session); message.updated as `properties.info.sessionID`
// (a Message). The plugin reporter MUST mirror this. The id is optional for the
// runtime (frames resolve by agentId), so an unknown shape returns null safely.
export function opencodeSessionIdFromEvent(event: unknown): string | null {
  if (!isRecord(event)) return null
  const props = event.properties
  if (!isRecord(props)) return null
  if (typeof props.sessionID === 'string' && props.sessionID) return props.sessionID
  const info = props.info
  if (isRecord(info)) {
    if (typeof info.sessionID === 'string' && info.sessionID) return info.sessionID
    if (typeof info.id === 'string' && info.id) return info.id
  }
  return null
}

export function renderOpencodeAgentStatePlugin(template: string, socketPath: string): string {
  return template.split(OPENCODE_SOCKET_PLACEHOLDER).join(JSON.stringify(socketPath))
}

export async function installOpencodeAgentStateHook(
  workspaceRoot: string,
  options: { sourceScriptPath: string; socketPath: string }
): Promise<AgentStateInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!options.socketPath?.trim()) return { ok: false, message: 'Agent-state socket path is required.' }
  if (!options.sourceScriptPath || !existsSync(options.sourceScriptPath)) {
    return { ok: false, message: 'Agent-state reporter script is missing from this build.' }
  }

  try {
    const destScript = resolve(workspaceRoot, OPENCODE_PLUGIN_REL)
    await mkdir(resolve(destScript, '..'), { recursive: true })
    const template = await readFile(options.sourceScriptPath, 'utf8')
    await writeFile(destScript, renderOpencodeAgentStatePlugin(template, options.socketPath), 'utf8')
    return { ok: true, settingsPath: destScript, hookScriptPath: destScript }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install OpenCode agent-state hook.',
    }
  }
}

export async function uninstallOpencodeAgentStateHook(
  workspaceRoot: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  try {
    const destScript = resolve(workspaceRoot, OPENCODE_PLUGIN_REL)
    if (existsSync(destScript)) await rm(destScript, { force: true })
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to uninstall OpenCode agent-state hook.',
    }
  }
}
