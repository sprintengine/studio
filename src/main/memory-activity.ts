import { app, BrowserWindow } from 'electron'
import { existsSync, watch as fsWatch, type FSWatcher } from 'fs'
import { copyFile, mkdir, readFile, readdir, writeFile, rm } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { open as fsOpen, type FileHandle } from 'fs/promises'
import { homedir } from 'os'
import type { ExecutionHostId } from '../shared/execution-host'
import { withConfigFileLock, writeFileAtomically } from './config-file-write'
import { hostRegistry } from './hosts/host-registry'
import {
  buildLauncherCommand,
  launcherCommandPattern,
  usableLocalLauncherRef,
  type StudioLauncherRef,
} from './integrations/launcher'
import { hostIdForPath, recordIntegrationWrite } from './integrations/ledger'

// =============================================================================
// Types
// =============================================================================

type ActivityEvent = {
  workspaceRoot: string
  sessionId: string
  nodeId: string
  prevNodeId: string | null
  tool: string
  ts: number
  synapseCount: number
}

export type ActivitySynapseSnapshot = {
  src: string
  dst: string
  count: number
  lastTs: number
}

export type ActivityStatus = {
  workspaceRoot: string | null
  isInstalled: boolean
  isWatching: boolean
  sessionsRecorded: number
  totalEvents: number
  eventsToday: number
  lastEventAt: number | null
}

export type ActivityInstallResult =
  { ok: true; settingsPath: string; hookScriptPath: string } | { ok: false; message: string }

export type ActivityUninstallResult = { ok: true } | { ok: false; message: string }

type SessionState = {
  lastNodeId: string | null
  fileOffset: number
}

type WorkspaceState = {
  workspaceRoot: string
  memoryRoot: string
  watcher: FSWatcher | null
  sessions: Map<string, SessionState>
  synapses: Map<string, ActivitySynapseSnapshot>
  events: { ts: number }[]
  isInstalled: boolean
}

const states = new Map<string, WorkspaceState>()

// =============================================================================
// Path helpers
// =============================================================================

const HOOK_TAG = 'sprintengine-knowledge-activity'
const HOOK_SCRIPT_REL = join('.sprintengine', 'hooks', 'knowledge-activity.mjs')
const TRACE_DIR_REL = join('.sprintengine', 'knowledge-trace')
const INSTALLED_RECORD_REL = join('.sprintengine', 'hooks', 'installed.json')
const CLAUDE_LOCAL_SETTINGS_REL = join('.claude', 'settings.local.json')

function workspaceKey(workspaceRoot: string): string {
  return resolve(workspaceRoot)
}

function getBundledHookScriptPath(): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'hooks', 'claude-knowledge-activity.mjs')
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
    join(app.getAppPath(), 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
    join(__dirname, '..', '..', 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
    join(__dirname, '..', '..', '..', 'resources', 'hooks', 'claude-knowledge-activity.mjs'),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

// =============================================================================
// Settings.local.json merge / unmerge
// =============================================================================

type ClaudeHookEntry = {
  type: 'command'
  command: string
  _sprintengine?: string
}

type ClaudeMatcherBlock = {
  matcher?: string
  hooks?: ClaudeHookEntry[]
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeMatcherBlock[]>
  [key: string]: unknown
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

// Run through the Studio launcher (`integrations/launcher.ts`) of the machine
// the workspace is on — this one, or the WSL distribution a `\\wsl.localhost`
// folder is inside — which runs the hook that ships with the app: nothing is
// copied into the workspace, no Node on PATH is assumed, and the entry is a
// quiet no-op once the app is gone. The knowledge root stays relative — the
// hook resolves it against the session's working directory, the workspace.
function knowledgeLauncherFor(workspaceRoot: string): StudioLauncherRef | null {
  const hostId = hostIdForPath(workspaceRoot)
  if (hostId === 'local') return usableLocalLauncherRef(homedir())
  const host = hostRegistry().get(hostId as ExecutionHostId)
  return host.kind === 'wsl' ? (host.agentIntegration()?.commandRuntime.launcher ?? null) : null
}

// Without a launcher (a distribution whose helper is not up, or a launcher
// that could not be written): the older form, a copy of the hook in the
// workspace run by the `node` of whichever machine the CLI runs on.
function buildHookCommand(memoryRelativeRoot: string, launcher: StudioLauncherRef | null): string {
  const memoryRel = memoryRelativeRoot.split(sep).join('/')
  if (!launcher) return `node "${HOOK_SCRIPT_REL.split(sep).join('/')}" --knowledge-root "${memoryRel}"`
  return buildLauncherCommand(launcher, 'knowledge-activity', ['--knowledge-root', memoryRel])
}

/** Whether a hook command is this feature's, in the launcher form or the copied-script form before it. */
function isKnowledgeActivityCommand(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    (launcherCommandPattern('knowledge-activity').test(command) ||
      /\.sprintengine\/hooks\/knowledge-activity\.mjs["'] --knowledge-root /u.test(command))
  )
}

function ensureMatcherBlock(blocks: ClaudeMatcherBlock[], matcher: string): ClaudeMatcherBlock {
  const found = blocks.find((b) => b.matcher === matcher)
  if (found) {
    if (!Array.isArray(found.hooks)) found.hooks = []
    return found
  }
  const next: ClaudeMatcherBlock = { matcher, hooks: [] }
  blocks.push(next)
  return next
}

function isSprintEngineEntry(entry: ClaudeHookEntry): boolean {
  return entry?._sprintengine === HOOK_TAG || isKnowledgeActivityCommand(entry?.command)
}

// Under the per-file lock every writer of this settings file shares (the MCP
// sync, the agent-state install, the start-up migration), and written through a
// temporary file, so neither this nor they lose the other's change.
function mergeSprintEngineHook(settingsPath: string, hookCommand: string): Promise<void> {
  return withConfigFileLock(settingsPath, () => mergeSprintEngineHookLocked(settingsPath, hookCommand))
}

async function mergeSprintEngineHookLocked(settingsPath: string, hookCommand: string): Promise<void> {
  const existing = (await readJsonIfExists<ClaudeSettings>(settingsPath)) ?? {}
  const settings: ClaudeSettings = { ...existing }
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []

  const blocks = settings.hooks.PostToolUse as ClaudeMatcherBlock[]
  const block = ensureMatcherBlock(blocks, 'Read|Edit|Write')

  // Replace any prior sprintengine entry; preserve all unrelated hooks the user
  // configured themselves.
  const ours: ClaudeHookEntry = {
    type: 'command',
    command: hookCommand,
    _sprintengine: HOOK_TAG,
  }
  const filtered = (block.hooks ?? []).filter((entry) => !isSprintEngineEntry(entry))
  filtered.push(ours)
  block.hooks = filtered

  await mkdir(resolve(settingsPath, '..'), { recursive: true })
  await writeFileAtomically(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

function unmergeSprintEngineHook(settingsPath: string): Promise<void> {
  return withConfigFileLock(settingsPath, () => unmergeSprintEngineHookLocked(settingsPath))
}

async function unmergeSprintEngineHookLocked(settingsPath: string): Promise<void> {
  const existing = await readJsonIfExists<ClaudeSettings>(settingsPath)
  if (!existing?.hooks?.PostToolUse) return
  const blocks = existing.hooks.PostToolUse as ClaudeMatcherBlock[]
  for (const block of blocks) {
    if (!Array.isArray(block.hooks)) continue
    block.hooks = block.hooks.filter((entry) => !isSprintEngineEntry(entry))
  }
  // Drop blocks that became empty so we don't leave dangling matchers.
  existing.hooks.PostToolUse = blocks.filter((b) => Array.isArray(b.hooks) && b.hooks.length > 0)
  if (existing.hooks.PostToolUse.length === 0) delete existing.hooks.PostToolUse
  if (Object.keys(existing.hooks).length === 0) delete existing.hooks

  await writeFileAtomically(settingsPath, JSON.stringify(existing, null, 2) + '\n')
}

// =============================================================================
// Install / uninstall
// =============================================================================

export async function installMemoryActivityHook(
  workspaceRoot: string,
  memoryRelativeRoot: string,
): Promise<ActivityInstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }
  if (!memoryRelativeRoot?.trim()) {
    return { ok: false, message: 'Knowledge folder must be configured before tracking activity.' }
  }

  const sourceScript = getBundledHookScriptPath()
  if (!sourceScript) {
    return { ok: false, message: 'Knowledge activity hook script is missing from this build.' }
  }

  try {
    const hookDir = resolve(workspaceRoot, '.sprintengine', 'hooks')
    await mkdir(hookDir, { recursive: true })
    const launcher = knowledgeLauncherFor(workspaceRoot)
    if (launcher) {
      // The copy an earlier build made is no longer run by anything.
      await rm(resolve(workspaceRoot, HOOK_SCRIPT_REL), { force: true }).catch(() => undefined)
    } else {
      await copyFile(sourceScript, resolve(workspaceRoot, HOOK_SCRIPT_REL))
    }

    const traceDir = resolve(workspaceRoot, TRACE_DIR_REL)
    await mkdir(traceDir, { recursive: true })

    const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL)
    const createdFile = !existsSync(settingsPath)
    const command = buildHookCommand(memoryRelativeRoot, launcher)
    await mergeSprintEngineHook(settingsPath, command)
    recordIntegrationWrite({
      kind: 'knowledge-activity-hook',
      path: settingsPath,
      marker: HOOK_TAG,
      hostId: hostIdForPath(settingsPath),
      cli: 'claude-code',
      repo: workspaceRoot,
      createdFile,
      detail: { record: resolve(workspaceRoot, INSTALLED_RECORD_REL) },
    })

    const installedRecord = {
      installedAt: new Date().toISOString(),
      memoryRelativeRoot,
      hookScript: HOOK_SCRIPT_REL.split(sep).join('/'),
      claudeSettings: CLAUDE_LOCAL_SETTINGS_REL.split(sep).join('/'),
      command,
      tag: HOOK_TAG,
    }
    await writeFile(
      resolve(workspaceRoot, INSTALLED_RECORD_REL),
      JSON.stringify(installedRecord, null, 2) + '\n',
      'utf8',
    )

    const state = ensureWorkspaceState(workspaceRoot, memoryRelativeRoot)
    state.isInstalled = true

    return { ok: true, settingsPath, hookScriptPath: sourceScript }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to install knowledge activity hook.',
    }
  }
}

export async function uninstallMemoryActivityHook(workspaceRoot: string): Promise<ActivityUninstallResult> {
  if (!workspaceRoot?.trim()) return { ok: false, message: 'Workspace root is required.' }

  try {
    const settingsPath = resolve(workspaceRoot, CLAUDE_LOCAL_SETTINGS_REL)
    if (existsSync(settingsPath)) await unmergeSprintEngineHook(settingsPath)

    const installedRecord = resolve(workspaceRoot, INSTALLED_RECORD_REL)
    if (existsSync(installedRecord)) await rm(installedRecord, { force: true })

    const state = states.get(workspaceKey(workspaceRoot))
    if (state) state.isInstalled = false

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Failed to uninstall memory activity hook.',
    }
  }
}

export async function isMemoryActivityInstalled(workspaceRoot: string): Promise<boolean> {
  if (!workspaceRoot?.trim()) return false
  return existsSync(resolve(workspaceRoot, INSTALLED_RECORD_REL))
}

// =============================================================================
// Watcher / synapse accumulator
// =============================================================================

function ensureWorkspaceState(workspaceRoot: string, memoryRelativeRoot: string): WorkspaceState {
  const key = workspaceKey(workspaceRoot)
  let state = states.get(key)
  if (state) {
    state.memoryRoot = memoryRelativeRoot
    return state
  }
  state = {
    workspaceRoot: key,
    memoryRoot: memoryRelativeRoot,
    watcher: null,
    sessions: new Map(),
    synapses: new Map(),
    events: [],
    isInstalled: false,
  }
  states.set(key, state)
  return state
}

function synapseKey(src: string, dst: string): string {
  return `${src}\0${dst}`
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

async function readJsonlFromOffset(path: string, offset: number): Promise<{ lines: string[]; nextOffset: number }> {
  let handle: FileHandle | null = null
  try {
    handle = await fsOpen(path, 'r')
    const stats = await handle.stat()
    if (stats.size <= offset) return { lines: [], nextOffset: stats.size }
    const length = stats.size - offset
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, offset)
    const text = buf.toString('utf8')
    const newlineEnd = text.lastIndexOf('\n')
    if (newlineEnd < 0) return { lines: [], nextOffset: offset }
    const consumable = text.slice(0, newlineEnd)
    const lines = consumable.split('\n').filter((l) => l.trim().length > 0)
    return { lines, nextOffset: offset + Buffer.byteLength(consumable, 'utf8') + 1 }
  } catch {
    return { lines: [], nextOffset: offset }
  } finally {
    await handle?.close()
  }
}

function processEventLine(state: WorkspaceState, sessionId: string, line: string): ActivityEvent | null {
  let parsed: { sessionId?: string; tool?: string; file?: string; ts?: number } | null = null
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed?.file || typeof parsed.file !== 'string') return null
  const tool = typeof parsed.tool === 'string' ? parsed.tool : 'Unknown'
  const ts = typeof parsed.ts === 'number' ? parsed.ts : Date.now()
  const nodeId = parsed.file
  const eventSessionId = parsed.sessionId ?? sessionId

  let session = state.sessions.get(eventSessionId)
  if (!session) {
    session = { lastNodeId: null, fileOffset: 0 }
    state.sessions.set(eventSessionId, session)
  }

  let synapseCount = 0
  if (session.lastNodeId && session.lastNodeId !== nodeId) {
    const key = synapseKey(session.lastNodeId, nodeId)
    const prior = state.synapses.get(key)
    const next: ActivitySynapseSnapshot = {
      src: session.lastNodeId,
      dst: nodeId,
      count: (prior?.count ?? 0) + 1,
      lastTs: ts,
    }
    state.synapses.set(key, next)
    synapseCount = next.count
  }

  const event: ActivityEvent = {
    workspaceRoot: state.workspaceRoot,
    sessionId: eventSessionId,
    nodeId,
    prevNodeId: session.lastNodeId,
    tool,
    ts,
    synapseCount,
  }
  session.lastNodeId = nodeId
  state.events.push({ ts })
  return event
}

async function tailSessionFile(
  state: WorkspaceState,
  fileName: string,
  options: { broadcastEvents: boolean } = { broadcastEvents: true },
): Promise<void> {
  if (!fileName.endsWith('.jsonl')) return
  const sessionId = fileName.replace(/\.jsonl$/u, '')
  const filePath = resolve(state.workspaceRoot, TRACE_DIR_REL, fileName)
  if (!existsSync(filePath)) return

  let session = state.sessions.get(sessionId)
  if (!session) {
    session = { lastNodeId: null, fileOffset: 0 }
    state.sessions.set(sessionId, session)
  }

  const { lines, nextOffset } = await readJsonlFromOffset(filePath, session.fileOffset)
  session.fileOffset = nextOffset
  for (const line of lines) {
    const event = processEventLine(state, sessionId, line)
    if (event && options.broadcastEvents) broadcast('memory-activity:event', event)
  }
}

async function rebuildFromDisk(state: WorkspaceState): Promise<void> {
  const traceDir = resolve(state.workspaceRoot, TRACE_DIR_REL)
  if (!existsSync(traceDir)) return
  let entries: string[] = []
  try {
    entries = await readdir(traceDir)
  } catch {
    return
  }
  // Replay every existing session so synapse counts match live state, but
  // do NOT re-broadcast history as live pulses — the renderer will request
  // a synapse snapshot once on connect.
  const jsonlFiles = entries.filter((n) => n.endsWith('.jsonl')).sort()
  for (const name of jsonlFiles) {
    await tailSessionFile(state, name, { broadcastEvents: false })
  }
}

export async function startMemoryActivityWatcher(workspaceRoot: string, memoryRelativeRoot: string): Promise<void> {
  if (!workspaceRoot?.trim() || !memoryRelativeRoot?.trim()) return
  const state = ensureWorkspaceState(workspaceRoot, memoryRelativeRoot)
  if (state.watcher) return

  const traceDir = resolve(workspaceRoot, TRACE_DIR_REL)
  await mkdir(traceDir, { recursive: true })

  await rebuildFromDisk(state)
  broadcastSynapses(state)
  broadcastStatus(state)

  // fs.watch fires for create+modify on every platform we care about (macOS,
  // Linux, Windows). We don't need recursive — the trace dir is flat.
  state.watcher = fsWatch(traceDir, { persistent: false }, (_event, fileName) => {
    if (!fileName) return
    const name = String(fileName)
    void tailSessionFile(state, name).then(() => broadcastStatus(state))
  })
}

export function stopMemoryActivityWatcher(workspaceRoot: string): void {
  const state = states.get(workspaceKey(workspaceRoot))
  if (!state?.watcher) return
  state.watcher.close()
  state.watcher = null
}

// =============================================================================
// Status / synapse snapshots for the renderer
// =============================================================================

function isToday(ts: number, now: number): boolean {
  const a = new Date(ts)
  const b = new Date(now)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function getMemoryActivityStatus(workspaceRoot: string | null): ActivityStatus {
  if (!workspaceRoot?.trim()) {
    return {
      workspaceRoot: null,
      isInstalled: false,
      isWatching: false,
      sessionsRecorded: 0,
      totalEvents: 0,
      eventsToday: 0,
      lastEventAt: null,
    }
  }
  const state = states.get(workspaceKey(workspaceRoot))
  if (!state) {
    return {
      workspaceRoot,
      isInstalled: existsSync(resolve(workspaceRoot, INSTALLED_RECORD_REL)),
      isWatching: false,
      sessionsRecorded: 0,
      totalEvents: 0,
      eventsToday: 0,
      lastEventAt: null,
    }
  }
  const now = Date.now()
  const totalEvents = state.events.length
  const eventsToday = state.events.filter((e) => isToday(e.ts, now)).length
  const lastEventAt = state.events.length > 0 ? state.events[state.events.length - 1].ts : null
  return {
    workspaceRoot: state.workspaceRoot,
    isInstalled: state.isInstalled || existsSync(resolve(state.workspaceRoot, INSTALLED_RECORD_REL)),
    isWatching: state.watcher !== null,
    sessionsRecorded: state.sessions.size,
    totalEvents,
    eventsToday,
    lastEventAt,
  }
}

export function getMemoryActivitySynapses(workspaceRoot: string): ActivitySynapseSnapshot[] {
  const state = states.get(workspaceKey(workspaceRoot))
  if (!state) return []
  return [...state.synapses.values()]
}

function broadcastStatus(state: WorkspaceState): void {
  broadcast('memory-activity:status', getMemoryActivityStatus(state.workspaceRoot))
}

function broadcastSynapses(state: WorkspaceState): void {
  broadcast('memory-activity:synapses', {
    workspaceRoot: state.workspaceRoot,
    synapses: [...state.synapses.values()],
  })
}
