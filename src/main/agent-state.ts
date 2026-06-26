import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import type { AgentPhase, SessionActivity } from '../shared/electron-api'

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

// The Claude Code lifecycle events we register the reporter for, with the
// matcher each event expects. Tool events (`PreToolUse`/`PostToolUse`) take a
// tool-name matcher; the rest are not tool-scoped and omit it. One reporter
// command is registered under every event — it reads `hook_event_name` from the
// hook payload to know which phase to report.
export const AGENT_STATE_HOOK_EVENTS: ReadonlyArray<{ event: string; matcher?: string }> = [
  { event: 'SessionStart' },
  { event: 'UserPromptSubmit' },
  { event: 'PreToolUse', matcher: '*' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'Notification' },
  { event: 'Stop' },
  { event: 'SubagentStop' },
  { event: 'SessionEnd' },
]

// =============================================================================
// Event → phase mapping keeps runtime events in one shared vocabulary
// =============================================================================

export function mapHookEventToPhase(event: string): AgentPhase | null {
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
// Untrusted frame validation
//
// Frames arrive over a local socket from a reporter process. Treat every field
// as untrusted data: validate shape and the phase enum, never act on anything
// beyond the typed fields below.
// =============================================================================

export type AgentStateFrame = {
  type: 'agent_state'
  agentId: string
  workspaceId: string | null
  sessionId: string | null
  phase: AgentPhase
  event: string | null
  ts: number
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
  const ts = typeof raw.ts === 'number' && Number.isFinite(raw.ts) ? raw.ts : now
  return {
    type: 'agent_state',
    agentId,
    workspaceId: optionalString(raw.workspaceId),
    sessionId: optionalString(raw.sessionId),
    phase: phase as AgentPhase,
    event: optionalString(raw.event),
    ts,
  }
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

export function buildAgentStateHookCommand(socketPath: string): string {
  // The script path is workspace-relative — normalize to forward slashes, which
  // Node accepts on every platform. The socket path is passed VERBATIM: on
  // Windows it is a `\\.\pipe\...` named pipe whose backslashes must survive (a
  // separator rewrite would corrupt it to `//./pipe/...`, which connect() can't
  // open); on POSIX it has no backslashes, so verbatim is identical. Both are
  // double-quoted so spaces survive the shell.
  const scriptRel = AGENT_STATE_HOOK_SCRIPT_REL.split(sep).join('/')
  return `node "${scriptRel}" --socket "${socketPath}"`
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

export async function mergeAgentStateHooks(settingsPath: string, command: string): Promise<void> {
  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) ?? {}
  const settings: ClaudeSettings = { ...existing }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}

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

  for (const { event } of AGENT_STATE_HOOK_EVENTS) {
    const blocks = existing.hooks[event]
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue
      block.hooks = block.hooks.filter((entry) => !isAgentStateEntry(entry))
    }
    const kept = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
    if (kept.length === 0) delete existing.hooks[event]
    else existing.hooks[event] = kept
  }
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

    const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL)
    await mergeAgentStateHooks(settingsPath, buildAgentStateHookCommand(options.socketPath))

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
