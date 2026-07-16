import { existsSync } from 'fs'
import { mkdir, readFile, stat } from 'fs/promises'
import { spawn } from 'child_process'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type {
  SprintEngineArtifactCommandResult,
  SprintEngineMcpReadResult,
  SprintEngineProjectionReadResult,
  SprintEngineRegistryRoleReadInput,
  SprintEngineRegistryRolesReadInput,
  SprintEngineRosterRuntimeInput,
  SprintEngineRosterEnableInput,
  SprintEngineRunnerSetInput,
  SprintEngineStateInitializeInput,
  SprintEngineStateInitializeSource,
  SprintEngineStateInitializeSourceBundleItem,
  SprintEngineTaskCommentInput,
  SprintEngineTaskCreateInput,
  SprintEngineTaskMutationRole,
  SprintEngineTaskResolveInput,
  SprintEngineTaskStatusSetInput,
  SprintEngineTaskUpdateInput,
} from '../shared/electron-api'
import type {
  SprintEngineArtifactOpenPayload,
  SprintEngineArtifactReviewAction,
  SprintEngineArtifactReviewMode,
  SprintEngineArtifactReviewPayload,
  SprintEngineProjectionReadPayload,
  SprintEngineVcsPayload,
} from './ipc/sprintengine-ipc'
import { findSprintEngineRuntimeRoot } from './mcp-config-service'
import { getPluginSprintEngineRegistryRoots } from './plugin-registry-instance'
import { defaultUserRoleRegistryRoot } from './sprintengine-role-registry'

type SprintEngineArtifactDependencies = {
  getAuthenticatedUserId(): string | null
  openExternal(url: string): Promise<void>
  runMcpTool?: SprintEngineMcpToolRunner
}

type SprintEngineMcpActorContext = {
  id: string
  role: 'user' | 'renderer'
  authenticated: true
  mcpAuthorized: true
}

type SprintEngineMcpToolResponse =
  | { ok: true; tool: string; result: unknown }
  | { ok: false; tool: string; error?: { code?: string; message?: string } }

type SprintEngineMcpRunnerContext = {
  workspaceRoot: string
  allowedRoots?: string[]
  // Kill the MCP child and fail the read if it has not answered in this long.
  // Unset means wait indefinitely, which is only safe for a read a human is
  // sitting in front of. A read on an automated hot path (the mobile snapshot
  // publisher) must set this: a workspace root on a stalled network mount would
  // otherwise hang the process forever and take the whole snapshot with it.
  timeoutMs?: number
}

type SprintEngineMcpToolRunner = (
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>,
  actor: SprintEngineMcpActorContext
) => Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  response: SprintEngineMcpToolResponse | null
}>

type SprintEngineArtifactRecord = {
  id: string
  kind: string
  title: string
  path: string
  status: string
  createdBy: string
  taskId: string
}

type SprintEngineTaskRecord = {
  id: string
  status: string
  ownerAgentId: string
}

const validTaskRoles = new Set<SprintEngineTaskMutationRole>([
  'architect',
  'product',
  'developer',
  'frontend',
  'tester',
  'security',
  'performance',
  'production_readiness_reviewer',
])

type ValidSprintEngineStatePath = {
  statePath: string
  teamDirectory: string
  workspaceRoot: string
}

type SerializableSprintEngineStatePayload = {
  name: string
  goal: string
  agents: Record<string, unknown>
  tasks: unknown[]
  events: unknown[]
  artifacts: unknown[]
  useWorktrees: boolean
  roleRuntimes: Record<string, { model?: string | null; cli?: string | null }>
  enabledRoles: string[]
  rosterSource: 'user' | 'architect' | null
  allowedRuntimes: Array<{ cli: string; model: string | null }>
  // `null` = absent (engine default applies); `[]` = an explicit no-review run.
  defaultPhases: string[] | null
  requiredSweeps: string[]
  phaseRuntimes: Record<string, { cli: string; model: string | null }> | null
  source: SprintEngineStateInitializeSource | null
  sourceBundle: SprintEngineStateInitializeSourceBundleItem[]
}

type SprintEngineEventMetadata = {
  id?: string
  type?: string
  timestamp?: string
  actor?: string
  message?: string
}

const autoApprovableArtifactKinds = new Set([
  'architect_plan',
  'product_strategy',
  'requirements',
  'html_mockup',
  'design_notes',
  'branding',
  'security_review',
  'code_review',
  'spec_review',
  'performance_review',
  'production_readiness_review',
  'cross_platform_review',
  'validation_report',
])

function validateSprintEngineStatePath(input: unknown): ValidSprintEngineStatePath {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A sprint run path is required.')
  }

  const rawStatePath = input.trim()
  if (!isAbsolute(rawStatePath)) {
    throw new Error('Sprint run path must be absolute.')
  }

  const statePath = resolve(rawStatePath)
  const teamDirectory = dirname(statePath)
  const sprintEngineDirectory = dirname(teamDirectory)
  const multiCodeDirectory = dirname(sprintEngineDirectory)
  const workspaceRoot = dirname(multiCodeDirectory)

  if (
    basename(statePath) !== 'run.yaml'
    || basename(sprintEngineDirectory) !== 'sprintengine'
    || basename(multiCodeDirectory) !== '.multi-code'
    || workspaceRoot === multiCodeDirectory
  ) {
    throw new Error('Sprint run path must point to .multi-code/sprintengine/<team>/run.yaml.')
  }

  return { statePath, teamDirectory, workspaceRoot }
}

function isPathInsideOrEqual(parentPath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(targetPath))
  return (
    relativePath === ''
    || (!relativePath.startsWith('..') && !isAbsolute(relativePath) && !relativePath.split(sep).includes('..'))
  )
}

function resolveArtifactFilePath(state: ValidSprintEngineStatePath, artifactPathInput: unknown): string {
  if (typeof artifactPathInput !== 'string' || !artifactPathInput.trim()) {
    throw new Error('Artifact path is required.')
  }

  const artifactPath = artifactPathInput.trim()
  if (/^https?:\/\//i.test(artifactPath)) {
    return artifactPath
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/i.test(artifactPath)) {
    throw new Error('Only http, https, or workspace artifact file paths can be opened.')
  }

  const fullPath = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : [
        resolve(state.workspaceRoot, artifactPath),
        resolve(state.teamDirectory, artifactPath),
      ].find((candidate) => isPathInsideOrEqual(state.teamDirectory, candidate))
        ?? resolve(state.workspaceRoot, artifactPath)
  if (!isPathInsideOrEqual(state.teamDirectory, fullPath)) {
    throw new Error('Artifact path must stay inside the sprint team directory.')
  }

  return fullPath
}

function resolveSprintEngineArtifactId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Artifact id is required.')
  }
  const artifactId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(artifactId)) {
    throw new Error('Artifact id must be a safe sprintengine identifier.')
  }
  return artifactId
}

function resolveSprintEngineTaskId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Task id is required.')
  }
  const taskId = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(taskId)) {
    throw new Error('Task id must be a safe sprintengine identifier.')
  }
  return taskId
}

// Roster roles accept any configured registry role (including custom and
// plugin-installed ids), so this only screens for a safe identifier; the
// Sprint Engine CLI canonicalizes the id and rejects unknown roles.
function resolveSprintEngineRosterRole(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Roster role is required.')
  }
  const role = input.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(role)) {
    throw new Error('Roster role must be a safe sprintengine identifier.')
  }
  return role
}

function resolveTaskRole(input: unknown): SprintEngineTaskMutationRole {
  if (typeof input !== 'string' || !validTaskRoles.has(input as SprintEngineTaskMutationRole)) {
    throw new Error('Task role is invalid.')
  }
  return input as SprintEngineTaskMutationRole
}

function resolveOptionalTaskRole(input: unknown): SprintEngineTaskMutationRole | undefined {
  return input === undefined || input === null ? undefined : resolveTaskRole(input)
}

function resolveOptionalString(input: unknown, field: string): string | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'string') throw new Error(`${field} must be a string.`)
  return input.trim()
}

function resolveRequiredString(input: unknown, field: string): string {
  const value = resolveOptionalString(input, field)
  if (!value) throw new Error(`${field} is required.`)
  return value
}

function resolveStringList(input: unknown, field: string): string[] | undefined {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) throw new Error(`${field} must be a list.`)
  return input.flatMap((item): string[] => {
    if (typeof item !== 'string') return []
    const value = item.trim()
    return value ? [value] : []
  })
}

function resolveRecord(input: unknown, field: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${field} must be an object.`)
  }
  return input as Record<string, unknown>
}

function resolveArray(input: unknown, field: string): unknown[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error(`${field} must be a list.`)
  return input
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null
}

function eventMetadataFromUnknown(input: unknown): SprintEngineEventMetadata | null {
  const record = asRecord(input)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id : undefined
  const type = typeof record.type === 'string' ? record.type : undefined
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : undefined
  const actor = typeof record.actor === 'string' ? record.actor : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (!id && !type && !timestamp && !actor && !message) return null
  return { id, type, timestamp, actor, message }
}

function collectSprintEngineEvents(toolResult: unknown): SprintEngineEventMetadata[] {
  const record = asRecord(toolResult)
  if (!record) return []
  const events: SprintEngineEventMetadata[] = []
  const add = (candidate: unknown) => {
    const event = eventMetadataFromUnknown(candidate)
    if (event) events.push(event)
  }
  add(record.event)
  add(record.notification)
  if (Array.isArray(record.events)) {
    for (const event of record.events) add(event)
  }
  if (Array.isArray(record.notifications)) {
    for (const event of record.notifications) add(event)
  }
  return events
}

async function readLatestSprintEngineEvent(state: ValidSprintEngineStatePath): Promise<SprintEngineEventMetadata | null> {
  try {
    const content = await readFile(join(state.teamDirectory, 'events.jsonl'), 'utf8')
    const line = content.trim().split(/\r?\n/u).filter(Boolean).at(-1)
    if (!line) return null
    return eventMetadataFromUnknown(JSON.parse(line))
  } catch {
    return null
  }
}

async function buildSprintEngineMutationData(
  state: ValidSprintEngineStatePath,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const projectionPath = join(state.teamDirectory, 'projection.json')
  const projectionContent = await readFile(projectionPath, 'utf8')
  const projectionStats = await stat(projectionPath)
  const projectionToken = `${projectionStats.mtimeMs}:${projectionStats.size}`
  const toolEvents = collectSprintEngineEvents(data.tool)
  const latestEvent = toolEvents.at(-1) ?? await readLatestSprintEngineEvent(state)
  return {
    ...data,
    projectionContent,
    projectionToken,
    ...(toolEvents.length > 0 ? { events: toolEvents } : {}),
    ...(latestEvent ? { latestEvent, latestEventId: latestEvent.id } : {}),
  }
}

function parseSprintEngineCliJsonOutput(stdout: string): unknown {
  const responseLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
  if (!responseLine) return null
  try {
    return JSON.parse(responseLine) as unknown
  } catch {
    return null
  }
}

function resolveInitialSprintEngineStatePayload(payload: SprintEngineStateInitializeInput): SerializableSprintEngineStatePayload {
  return {
    name: resolveRequiredString(payload?.name, 'sprint name'),
    goal: resolveOptionalString(payload?.goal, 'sprint goal') ?? '',
    agents: resolveRecord(payload?.agents, 'sprint agents'),
    tasks: resolveArray(payload?.tasks, 'sprint tasks'),
    events: resolveArray(payload?.events, 'sprint events'),
    artifacts: resolveArray(payload?.artifacts, 'sprint artifacts'),
    useWorktrees: payload?.useWorktrees === true,
    roleRuntimes: resolveRoleRuntimes(payload?.roleRuntimes),
    enabledRoles: resolveEnabledRoles(payload?.enabledRoles),
    rosterSource: resolveRosterSource(payload?.rosterSource),
    allowedRuntimes: resolveAllowedRuntimes(payload?.allowedRuntimes),
    defaultPhases: resolveDefaultPhases(payload?.defaultPhases),
    requiredSweeps: resolveRequiredSweeps(payload?.requiredSweeps),
    phaseRuntimes: resolvePhaseRuntimes(payload?.phaseRuntimes),
    source: resolveInitSource(payload?.source),
    sourceBundle: resolveInitSourceBundle(payload?.sourceBundle),
  }
}

// The run's phase list. `undefined` stays `null` (absent -> engine default);
// an array — INCLUDING the empty one — is forwarded verbatim, because `[]` is the
// operator saying "no review step on this run". Non-string entries are dropped;
// the engine rejects any unknown phase name by contract.
function resolveDefaultPhases(input: SprintEngineStateInitializeInput['defaultPhases']): string[] | null {
  if (!Array.isArray(input)) return null
  return input.filter((phase): phase is string => typeof phase === 'string' && phase.trim().length > 0)
}

// Mandated sweep roles. Unlike `defaultPhases`, an empty list is the same as absent
// (no mandate), so this collapses to a plain array and the flag is only forwarded
// when non-empty. The engine rejects any id that is not a registry sweep role.
function resolveRequiredSweeps(input: SprintEngineStateInitializeInput['requiredSweeps']): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  for (const role of input) {
    if (typeof role === 'string' && role.trim()) seen.add(role.trim())
  }
  return [...seen]
}

// Per-phase runtime bindings (MC-1543). An entry with no `cli` cannot spawn a
// session, so it is dropped here rather than forwarded — the engine would reject it
// anyway, and a half-honoured premium mode is worse than none. Returns `null` when
// nothing survives, so the flag is omitted and zero extra sessions are created.
function resolvePhaseRuntimes(
  input: SprintEngineStateInitializeInput['phaseRuntimes'],
): Record<string, { cli: string; model: string | null }> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const resolved: Record<string, { cli: string; model: string | null }> = {}
  for (const [phase, binding] of Object.entries(input)) {
    if (!phase.trim() || !binding || typeof binding !== 'object') continue
    const cli = typeof binding.cli === 'string' ? binding.cli.trim() : ''
    if (!cli) continue
    const model = typeof binding.model === 'string' && binding.model.trim() ? binding.model.trim() : null
    resolved[phase.trim()] = { cli, model }
  }
  return Object.keys(resolved).length > 0 ? resolved : null
}

// Keep only source entries with the non-empty string fields Python persists.
// A bundle item without a path carries no reference, so it is dropped.
function resolveInitSourceItem(
  input: SprintEngineStateInitializeSource | SprintEngineStateInitializeSourceBundleItem | undefined,
): SprintEngineStateInitializeSource | null {
  if (!input || typeof input !== 'object') return null
  const kind = typeof input.kind === 'string' ? input.kind.trim() : ''
  const origin = typeof input.origin === 'string' ? input.origin.trim() : ''
  const path = typeof input.path === 'string' ? input.path.trim() : ''
  if (!kind || !origin || !path) return null
  const resolved: SprintEngineStateInitializeSource = { kind, origin, path }
  const planKind = 'planKind' in input && typeof input.planKind === 'string' ? input.planKind.trim() : ''
  const originalPath = typeof input.originalPath === 'string' ? input.originalPath.trim() : ''
  const capturedAt = typeof input.capturedAt === 'string' ? input.capturedAt.trim() : ''
  if (planKind) resolved.planKind = planKind
  if (originalPath) resolved.originalPath = originalPath
  if (capturedAt) resolved.capturedAt = capturedAt
  return resolved
}

function resolveInitSource(
  input: SprintEngineStateInitializeInput['source'],
): SprintEngineStateInitializeSource | null {
  return resolveInitSourceItem(input)
}

function resolveInitSourceBundle(
  input: SprintEngineStateInitializeInput['sourceBundle'],
): SprintEngineStateInitializeSourceBundleItem[] {
  if (!Array.isArray(input)) return []
  return input
    .map((item) => resolveInitSourceItem(item))
    .filter((item): item is SprintEngineStateInitializeSourceBundleItem => item !== null)
}

// The enabled role ids (architect always included) forwarded to Python init as
// `configuredRoles`. Trim, drop empties, and dedupe while preserving order so
// the run.yaml list is stable; an empty result sends no flag (the architect
// then seats the team itself under the lazy roster).
function resolveEnabledRoles(input: SprintEngineStateInitializeInput['enabledRoles']): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const role of input) {
    const roleKey = typeof role === 'string' ? role.trim() : ''
    if (!roleKey || seen.has(roleKey)) continue
    seen.add(roleKey)
    out.push(roleKey)
  }
  return out
}

// Keep only roles with a usable model or cli string; a role left on the CLI's
// default model contributes nothing (no model flag is fabricated downstream).
function resolveRoleRuntimes(
  input: SprintEngineStateInitializeInput['roleRuntimes']
): Record<string, { model?: string | null; cli?: string | null }> {
  if (!input || typeof input !== 'object') return {}
  const out: Record<string, { model?: string | null; cli?: string | null }> = {}
  for (const [role, entry] of Object.entries(input)) {
    const roleKey = role.trim()
    if (!roleKey || !entry || typeof entry !== 'object') continue
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    const cli = typeof entry.cli === 'string' ? entry.cli.trim() : ''
    if (!model && !cli) continue
    out[roleKey] = { ...(model ? { model } : {}), ...(cli ? { cli } : {}) }
  }
  return out
}

// Only the two known roster-source modes survive; anything else (including
// user-mode) leaves the flag off so Python keeps its default 'user' semantics.
function resolveRosterSource(
  input: SprintEngineStateInitializeInput['rosterSource'],
): 'user' | 'architect' | null {
  return input === 'architect' || input === 'user' ? input : null
}

// The sprint's ticked model palette. Drops entries with no usable cli and
// collapses each model to a trimmed string or null (the CLI's own default),
// mirroring the engine's `apply_allowed_runtimes` parse so what we forward is
// exactly what the run stores.
function resolveAllowedRuntimes(
  input: SprintEngineStateInitializeInput['allowedRuntimes'],
): Array<{ cli: string; model: string | null }> {
  if (!Array.isArray(input)) return []
  const out: Array<{ cli: string; model: string | null }> = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const cli = typeof entry.cli === 'string' ? entry.cli.trim() : ''
    if (!cli) continue
    const model = typeof entry.model === 'string' && entry.model.trim() ? entry.model.trim() : null
    out.push({ cli, model })
  }
  return out
}

function getSprintEngineMcpRuntimeRoot(): string {
  return findSprintEngineRuntimeRoot() ?? process.cwd()
}

function getSprintEngineMcpPythonExecutable(runtimeRoot: string): string {
  const venvPython = process.platform === 'win32'
    ? join(runtimeRoot, '.venv', 'Scripts', 'python.exe')
    : join(runtimeRoot, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  return process.platform === 'win32' ? 'python' : 'python3'
}

function validateWorkspaceRoot(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Workspace root is required.')
  }
  const rawWorkspaceRoot = input.trim()
  if (!isAbsolute(rawWorkspaceRoot)) {
    throw new Error('Workspace root must be absolute.')
  }
  const workspaceRoot = resolve(rawWorkspaceRoot)
  if (!existsSync(workspaceRoot)) {
    throw new Error('Workspace root does not exist.')
  }
  return workspaceRoot
}

// The run-store schema version this build understands. MIRRORS `RUN_SCHEMA_VERSION`
// in sprintengine_core/store.py. v2 (MC-1542, single-owner tasks) deleted quality
// gates and the `changes_requested`/`testing`/`product` statuses; v3 (MC-1591,
// leases replace the roster) removed the persistent `agents` map from run.yaml;
// v4 (MC-1611, multi-repo runs) made `vcs.repos` the run's declared repo list.
export const SPRINT_ENGINE_RUN_SCHEMA_VERSION = 4

/**
 * Reject an out-of-date run store, returning a readable message (or null when the
 * store is current).
 *
 * Decision 8 is a pre-release clean break: old stores are local runtime state and
 * are never migrated. The one requirement is that the rejection is LOUD at every
 * surface that reads a store. The renderer reads `projection.json` straight off
 * disk without going through Python, so this guard — not the Python loader — is
 * what stops the board, wizard, backlog links, and module mount from silently
 * rendering gate-era data.
 *
 * A projection carrying a `run` object with no `schemaVersion` predates the field
 * and is therefore version 1. A payload with no `run` object at all is not a
 * projection; that is malformed input, judged downstream by
 * `normalizeSprintEngineProjection`, and this guard stays silent rather than
 * blaming it on an old Multicode.
 */
export function describeUnsupportedSprintEngineStore(projection: unknown, teamDirectory: string): string | null {
  if (!projection || typeof projection !== 'object') return null
  const run = (projection as { run?: unknown }).run
  if (!run || typeof run !== 'object' || Array.isArray(run)) return null
  const rawVersion = (run as { schemaVersion?: unknown }).schemaVersion
  const version = typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : 1
  if (version >= SPRINT_ENGINE_RUN_SCHEMA_VERSION) return null
  return (
    `This sprint was created by an older version of Multicode (run store v${version}, ` +
    `this build reads v${SPRINT_ENGINE_RUN_SCHEMA_VERSION}). Sprints can now span more ` +
    `than one project (and before that, leases replaced the roster and single-owner ` +
    `tasks replaced quality gates), so the run cannot be opened. Delete ` +
    `"${teamDirectory}" and start the sprint again.`
  )
}

function sprintEngineInitArgs(state: ValidSprintEngineStatePath, payload: SerializableSprintEngineStatePayload): string[] {
  const args = ['--state', state.statePath, 'init', '--name', payload.name, '--goal', payload.goal || payload.name]
  if (payload.useWorktrees) {
    args.push('--use-worktrees', 'true')
  }
  for (const [agentId, agent] of Object.entries(payload.agents)) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue
    const role = (agent as Record<string, unknown>).role
    if (typeof role === 'string' && role.trim()) {
      args.push('--agent', `${role.trim()}:${agentId}`)
    }
  }
  if (Object.keys(payload.roleRuntimes).length > 0) {
    args.push('--role-runtimes-json', JSON.stringify(payload.roleRuntimes))
  }
  if (payload.enabledRoles.length > 0) {
    args.push('--configured-roles-json', JSON.stringify(payload.enabledRoles))
  }
  if (payload.rosterSource) {
    args.push('--roster-source', payload.rosterSource)
  }
  if (payload.allowedRuntimes.length > 0) {
    args.push('--allowed-runtimes-json', JSON.stringify(payload.allowedRuntimes))
  }
  // `[]` must reach the engine (an explicit no-review run), so this branches on
  // presence, not truthiness, unlike every other array flag above.
  if (payload.defaultPhases !== null) {
    args.push('--default-phases-json', JSON.stringify(payload.defaultPhases))
  }
  if (payload.requiredSweeps.length > 0) {
    args.push('--required-sweeps-json', JSON.stringify(payload.requiredSweeps))
  }
  // Must follow --allowed-runtimes-json: the engine validates bindings against the palette.
  if (payload.phaseRuntimes) {
    args.push('--phase-runtimes-json', JSON.stringify(payload.phaseRuntimes))
  }
  if (payload.source) {
    args.push('--source-json', JSON.stringify(payload.source))
  }
  if (payload.sourceBundle.length > 0) {
    args.push('--source-bundle-json', JSON.stringify(payload.sourceBundle))
  }
  return args
}

function runSprintEngineCli(state: ValidSprintEngineStatePath, args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const runtimeRoot = getSprintEngineMcpRuntimeRoot()
    const toolPath = join(runtimeRoot, 'scripts', 'sprintengine_tool.py')
    const child = spawn(getSprintEngineMcpPythonExecutable(runtimeRoot), [toolPath, ...args], {
      cwd: state.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, state.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
      },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      resolvePromise({ exitCode: 1, stdout, stderr: stderr || error.message })
    })
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, stdout, stderr })
    })
  })
}

function runSprintEngineMcpToolProcess(
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>,
  actor: SprintEngineMcpActorContext
): ReturnType<SprintEngineMcpToolRunner> {
  return new Promise((resolvePromise) => {
    const allowedRoots = Array.from(new Set([context.workspaceRoot, ...(context.allowedRoots ?? [])]))
    const args = ['-m', 'sprintengine_mcp']
    for (const root of allowedRoots) {
      args.push('--allowed-root', root)
    }
    const runtimeRoot = getSprintEngineMcpRuntimeRoot()
    const child = spawn(getSprintEngineMcpPythonExecutable(runtimeRoot), args, {
      cwd: context.workspaceRoot,
      env: {
        ...process.env,
        PYTHONPATH: [runtimeRoot, context.workspaceRoot, process.env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
        SPRINTENGINE_MCP_USER_ID: actor.id,
        SPRINTENGINE_MCP_USER_AUTHORIZED: '1',
      },
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    // A child that never closes would leave this promise pending forever, and
    // every awaiting caller with it. Settle once, kill the child, and let the
    // caller treat it as a failed read.
    let settled = false
    const timer = context.timeoutMs !== undefined
      ? setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          resolvePromise({
            exitCode: 1,
            stdout,
            stderr: stderr || `The sprintengine MCP tool did not respond within ${context.timeoutMs}ms.`,
            response: null,
          })
        }, context.timeoutMs)
      : null

    const settle = (result: Awaited<ReturnType<SprintEngineMcpToolRunner>>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolvePromise(result)
    }

    child.on('error', (error) => {
      settle({ exitCode: 1, stdout, stderr: stderr || error.message, response: null })
    })
    child.on('close', (exitCode) => {
      let response: SprintEngineMcpToolResponse | null = null
      const responseLine = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
      if (responseLine) {
        try {
          response = JSON.parse(responseLine) as SprintEngineMcpToolResponse
        } catch {
          response = null
        }
      }
      settle({ exitCode, stdout, stderr, response })
    })
    child.stdin.end(`${JSON.stringify({ tool, payload, actor })}\n`)
  })
}

function rendererMcpActor(): SprintEngineMcpActorContext {
  return {
    id: 'multicode-renderer',
    role: 'renderer',
    authenticated: true,
    mcpAuthorized: true,
  }
}

function sprintEngineRegistryRootsForRead(): Array<{ id: string; root: string }> {
  try {
    const roots = [...getPluginSprintEngineRegistryRoots()]
    // User-global third-party roles: same { roles/, skills/ } shape as plugin
    // souls dirs, so the existing MCP discovery enumerates them once the root is
    // on the search path. Only added when the directory exists.
    const userRoot = defaultUserRoleRegistryRoot()
    if (existsSync(userRoot)) roots.push({ id: 'user-roles', root: userRoot })
    return roots
  } catch {
    return []
  }
}

async function runReadOnlyMcpTool(
  runner: SprintEngineMcpToolRunner,
  context: SprintEngineMcpRunnerContext,
  tool: string,
  payload: Record<string, unknown>
): Promise<SprintEngineMcpReadResult> {
  const toolResult = await runner(context, tool, payload, rendererMcpActor())
  if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
    const message = toolResult.response && !toolResult.response.ok
      ? toolResult.response.error?.message
      : undefined
    return {
      ok: false,
      message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
      stdout: toolResult.stdout,
      stderr: toolResult.stderr,
      exitCode: toolResult.exitCode ?? 'unknown',
    }
  }
  return { ok: true, data: toolResult.response.result }
}

// The one role-registry read. `sprintengine.roles.list` resolves the layered
// registry (workspace -> plugin -> user -> bundled), and `pluginRegistryRoots` is
// what carries the plugin *and* user-global layers — user roles are mounted as a
// registry root (see sprintEngineRegistryRootsForRead), not through the MCP's own
// user_root. Omit them and the read silently degrades to bundled-only, which is
// precisely the role set a caller asking for the registry does not want.
//
// Shared by the renderer IPC (settings, wizard) and the mobile snapshot producer
// (src/main/mobile/sprintengine/role-catalog.ts) so the phone's launch picker and
// the desktop's wizard can never disagree about which roles exist.
async function readSprintEngineRegistryRolesWith(
  runMcpTool: SprintEngineMcpToolRunner,
  payload: SprintEngineRegistryRolesReadInput | undefined,
  timeoutMs?: number
): Promise<SprintEngineMcpReadResult> {
  try {
    const workspaceRoot = validateWorkspaceRoot(payload?.workspaceRoot)
    const pluginRegistryRoots = sprintEngineRegistryRootsForRead()
    return await runReadOnlyMcpTool(
      runMcpTool,
      {
        workspaceRoot,
        allowedRoots: pluginRegistryRoots.map((root) => root.root),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      'sprintengine.roles.list',
      { workspaceRoot, includeShadowed: payload?.includeShadowed === true, pluginRegistryRoots }
    )
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Registry roles for a workspace, outside the IPC handler bag (mobile snapshot).
 *
 * Bounded, unlike the renderer's read: this one runs on the snapshot publish path,
 * where a hung Python child would stall every snapshot the phone ever gets.
 */
export function readSprintEngineRegistryRoles(
  payload: SprintEngineRegistryRolesReadInput,
  timeoutMs?: number
): Promise<SprintEngineMcpReadResult> {
  return readSprintEngineRegistryRolesWith(runSprintEngineMcpToolProcess, payload, timeoutMs)
}

async function requireSprintEngineMcpAuthority(
  deps: SprintEngineArtifactDependencies
): Promise<SprintEngineMcpActorContext> {
  const userId = deps.getAuthenticatedUserId()
  if (!userId) {
    throw new Error('Artifact review requires an authenticated Multicode user.')
  }

  return {
    id: userId,
    role: 'user',
    authenticated: true,
    mcpAuthorized: true,
  }
}

function parseSprintEngineProjectionForArtifactReview(content: string): {
  tasks: SprintEngineTaskRecord[]
  artifacts: SprintEngineArtifactRecord[]
} {
  const parsed = JSON.parse(content) as Record<string, unknown>
  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).flatMap((task): SprintEngineTaskRecord[] => {
    if (!task || typeof task !== 'object') return []
    const record = task as Record<string, unknown>
    return typeof record.id === 'string' && typeof record.status === 'string'
      ? [{
          id: record.id,
          status: record.status,
          ownerAgentId: typeof record.ownerAgentId === 'string' ? record.ownerAgentId : '',
        }]
      : []
  })
  const artifacts = (Array.isArray(parsed.artifacts) ? parsed.artifacts : []).flatMap((artifact): SprintEngineArtifactRecord[] => {
    if (!artifact || typeof artifact !== 'object') return []
    const record = artifact as Record<string, unknown>
    if (typeof record.id !== 'string') return []
    return [{
      id: record.id,
      kind: typeof record.kind === 'string' ? record.kind : '',
      title: typeof record.title === 'string' ? record.title : '',
      path: typeof record.path === 'string' ? record.path : '',
      status: typeof record.status === 'string' ? record.status : '',
      createdBy: typeof record.createdBy === 'string' ? record.createdBy : '',
      taskId: typeof record.taskId === 'string' ? record.taskId : '',
    }]
  })
  return { tasks, artifacts }
}

// Stored artifact paths are project-relative but recorded in two equivalent
// forms that resolve to the same file: a bare team-relative path (`plan.md`)
// and a full-prefix path (`.multi-code/sprintengine/<team>/plan.md`). Normalize
// both to the team-relative form so a duplicate stored differently is
// recognized as the same file. Mirrors Python `artifact_absolute_path` (which
// resolves both forms to `<teamDir>/<rest>`) and the renderer helper of the
// same name, keeping all three auto-approval layers in agreement.
function normalizeSprintEngineArtifactFileKey(path: string): string {
  const segments = path
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  if (segments[0] === '.multi-code' && segments[1] === 'sprintengine' && segments.length > 3) {
    return segments.slice(3).join('/')
  }
  return segments.join('/')
}

function isSameSprintEngineArtifactFile(left: string, right: string): boolean {
  const leftKey = normalizeSprintEngineArtifactFileKey(left)
  return leftKey !== '' && leftKey === normalizeSprintEngineArtifactFileKey(right)
}

export function getArtifactAutoApprovalBlocker(
  artifact: SprintEngineArtifactRecord,
  tasks: SprintEngineTaskRecord[],
  artifacts: SprintEngineArtifactRecord[]
): string | null {
  if (artifact.status === 'approved') return 'Artifact is already approved.'
  if (artifact.status === 'superseded') return 'Superseded artifacts are obsolete and cannot be auto-approved.'
  if (!['ready_for_review', 'changes_requested'].includes(artifact.status)) {
    return 'Artifact status is not eligible for auto-approval.'
  }
  if (!artifact.path.trim()) return 'Artifact file path is missing.'
  if (!autoApprovableArtifactKinds.has(artifact.kind)) return 'Artifact kind is not eligible for auto-approval.'

  const task = tasks.find((candidate) => candidate.id === artifact.taskId)
  if (!task) return 'Artifact task was not found.'

  const blockingArtifacts = artifacts.filter((candidate) =>
    candidate.taskId === task.id
    && candidate.status !== 'approved'
    && candidate.status !== 'superseded'
    && autoApprovableArtifactKinds.has(candidate.kind)
    // Exclude stale same-file duplicates of the candidate: they are not
    // independent review gates, so a leftover draft placeholder pointing at the
    // same file must not veto approval. The candidate itself stays in the set
    // (it is the same file as itself but not a different artifact), keeping the
    // guard below meaningful. Distinct-file pending siblings still block.
    && !(candidate.id !== artifact.id && isSameSprintEngineArtifactFile(candidate.path, artifact.path))
  )
  if (blockingArtifacts.length === 0) return 'No blocking review artifact is waiting for approval.'

  const ineligibleBlockingArtifact = blockingArtifacts.find((candidate) =>
    !['ready_for_review', 'changes_requested'].includes(candidate.status) || !candidate.path.trim()
  )
  if (ineligibleBlockingArtifact) {
    return `Related artifact ${ineligibleBlockingArtifact.id} is not eligible for auto-approval.`
  }

  return null
}

async function readSprintEngineProjectionForArtifactReview(state: ValidSprintEngineStatePath): Promise<{
  tasks: SprintEngineTaskRecord[]
  artifacts: SprintEngineArtifactRecord[]
}> {
  const projectionContent = await readFile(join(state.teamDirectory, 'projection.json'), 'utf8')
  return parseSprintEngineProjectionForArtifactReview(projectionContent)
}

async function assertAutoApprovalAllowed(state: ValidSprintEngineStatePath, artifactId: string): Promise<SprintEngineArtifactRecord> {
  const { tasks, artifacts } = await readSprintEngineProjectionForArtifactReview(state)
  const artifact = artifacts.find((candidate) => candidate.id === artifactId)
  if (!artifact) throw new Error('Requested artifact was not found in the sprint projection.')

  const blocker = getArtifactAutoApprovalBlocker(artifact, tasks, artifacts)
  if (blocker) throw new Error(blocker)
  if (/^https?:\/\//i.test(artifact.path)) throw new Error('Remote artifact links cannot be auto-approved.')

  const artifactPath = resolveArtifactFilePath(state, artifact.path)
  const artifactStats = await stat(artifactPath)
  if (!artifactStats.isFile()) throw new Error('Artifact path must be a file.')
  await readFile(artifactPath, 'utf8')
  return artifact
}

export function createSprintEngineArtifactHandlers(deps: SprintEngineArtifactDependencies): {
  openArtifact(payload: SprintEngineArtifactOpenPayload): Promise<SprintEngineArtifactCommandResult>
  reviewArtifact(
    payload: SprintEngineArtifactReviewPayload,
    action: SprintEngineArtifactReviewAction,
    mode: SprintEngineArtifactReviewMode
  ): Promise<SprintEngineArtifactCommandResult>
  initializeSprintEngineState(payload: SprintEngineStateInitializeInput): Promise<SprintEngineArtifactCommandResult>
  updateTask(payload: SprintEngineTaskUpdateInput): Promise<SprintEngineArtifactCommandResult>
  createTask(payload: SprintEngineTaskCreateInput): Promise<SprintEngineArtifactCommandResult>
  commentTask(payload: SprintEngineTaskCommentInput): Promise<SprintEngineArtifactCommandResult>
  resolveTaskInput(payload: SprintEngineTaskResolveInput): Promise<SprintEngineArtifactCommandResult>
  setTaskStatus(payload: SprintEngineTaskStatusSetInput): Promise<SprintEngineArtifactCommandResult>
  setRunnerMode(payload: SprintEngineRunnerSetInput): Promise<SprintEngineArtifactCommandResult>
  cancelRun(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  createPullRequest(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  refreshPullRequestStatus(payload: SprintEngineVcsPayload): Promise<SprintEngineArtifactCommandResult>
  setRoleRuntime(payload: SprintEngineRosterRuntimeInput): Promise<SprintEngineArtifactCommandResult>
  enableRole(payload: SprintEngineRosterEnableInput): Promise<SprintEngineArtifactCommandResult>
  readProjection(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineProjectionReadResult>
  readRegistryRoles(payload: SprintEngineRegistryRolesReadInput): Promise<SprintEngineMcpReadResult>
  readRegistryRole(payload: SprintEngineRegistryRoleReadInput): Promise<SprintEngineMcpReadResult>
  summarizeFeedback(payload: SprintEngineProjectionReadPayload): Promise<SprintEngineMcpReadResult>
} {
  const runMcpTool = deps.runMcpTool ?? runSprintEngineMcpToolProcess
  return {
    async openArtifact(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const targetPath = resolveArtifactFilePath(state, payload?.artifactPath)

        if (/^https?:\/\//i.test(targetPath)) {
          await deps.openExternal(targetPath)
          return { ok: true, data: { path: targetPath } }
        }

        const targetStats = await stat(targetPath)
        if (!targetStats.isFile()) {
          return { ok: false, message: 'Artifact path must be a file.' }
        }

        const content = await readFile(targetPath, 'utf8')
        return { ok: true, data: { path: targetPath, name: basename(targetPath), content } }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async reviewArtifact(payload, action, mode) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const artifactId = resolveSprintEngineArtifactId(payload?.artifactId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        let feedback: string | undefined

        if (action === 'request-changes') {
          feedback = typeof payload?.feedback === 'string' ? payload.feedback.trim() : ''
          if (!feedback) return { ok: false, message: 'Artifact change requests require feedback.' }
        }
        if (mode === 'auto-run') {
          if (action !== 'approve') throw new Error('Auto-run can only approve eligible artifacts.')
          await assertAutoApprovalAllowed(state, artifactId)
        }

        const reviewPayload = {
          statePath: state.statePath,
          artifactId,
          id: actor.id,
          ...(feedback ? { feedback } : {}),
          ...(action === 'approve' ? { approvalMode: mode === 'auto-run' ? 'policy' : 'manual' } : {}),
        }
        const toolName = action === 'approve' ? 'sprintengine.artifact.approve' : 'sprintengine.artifact.request_changes'

        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, toolName, reviewPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action,
            actor: reviewPayload.id,
            authorizedUserId: actor.id,
            mode,
            artifactId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async initializeSprintEngineState(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const initialState = resolveInitialSprintEngineStatePayload(payload)
        await mkdir(state.teamDirectory, { recursive: true })
        const toolResult = await runSprintEngineCli(state, sprintEngineInitArgs(state, initialState))
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine init command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'initialize-state',
            actor: actor.id,
          }),
        }
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
          return { ok: true, data: { action: 'initialize-state', created: false } }
        }
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async updateTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolPayload = {
          statePath: state.statePath,
          taskId,
          actor: actor.id,
          title: resolveOptionalString(payload?.title, 'Task title'),
          description: resolveOptionalString(payload?.description, 'Task description'),
          role: resolveOptionalTaskRole(payload?.role),
          acceptance: resolveStringList(payload?.acceptanceCriteria, 'Acceptance criteria'),
          note: resolveStringList(payload?.implementationNotes, 'Implementation notes'),
          taskNote: resolveStringList(payload?.notes, 'Task notes'),
          clearAcceptance: Array.isArray(payload?.acceptanceCriteria),
          clearNotes: Array.isArray(payload?.implementationNotes),
          clearTaskNotes: Array.isArray(payload?.notes),
        }
        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, 'sprintengine.plan.update_task', toolPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'update-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async createTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const toolPayload = {
          statePath: state.statePath,
          actor: actor.id,
          title: resolveRequiredString(payload?.title, 'Task title'),
          description: resolveOptionalString(payload?.description, 'Task description') ?? '',
          role: resolveTaskRole(payload?.role),
          acceptance: resolveStringList(payload?.acceptanceCriteria, 'Acceptance criteria') ?? [],
          note: resolveStringList(payload?.implementationNotes, 'Implementation notes') ?? [],
          taskNote: resolveStringList(payload?.notes, 'Task notes') ?? [],
        }
        const toolResult = await runMcpTool({ workspaceRoot: state.workspaceRoot }, 'sprintengine.plan.add_task', toolPayload, actor)
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        // MCP mutation tools return acks ({taskId}) rather than task echoes;
        // accept the legacy {task: {id}} shape from older bundled runtimes.
        const result = toolResult.response.result as { taskId?: unknown; task?: { id?: unknown } }
        const taskId = typeof result.taskId === 'string'
          ? result.taskId
          : typeof result.task?.id === 'string' ? result.task.id : null
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'create-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async commentTask(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const body = resolveRequiredString(payload?.body, 'Task comment')
        const toolResult = await runMcpTool(
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.task.comment',
          { statePath: state.statePath, taskId, id: actor.id, body, source: 'user' },
          actor
        )
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'comment-task',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async resolveTaskInput(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const resolution = resolveRequiredString(payload?.resolution, 'Task input resolution')
        const toolResult = await runMcpTool(
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.task.resolve_input',
          {
            statePath: state.statePath,
            taskId,
            id: actor.id,
            resolution,
            complete: payload?.complete === true,
          },
          actor
        )
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: payload?.complete === true ? 'resolve-task-input-complete' : 'resolve-task-input',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async setTaskStatus(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const taskId = resolveSprintEngineTaskId(payload?.taskId)
        const actor = await requireSprintEngineMcpAuthority(deps)
        const status = resolveRequiredString(payload?.status, 'Task status')
        const toolResult = await runMcpTool(
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.task.status',
          { statePath: state.statePath, taskId, id: actor.id, status },
          actor
        )
        if (toolResult.exitCode !== 0 || !toolResult.response?.ok) {
          const message = toolResult.response && !toolResult.response.ok
            ? toolResult.response.error?.message
            : undefined
          return {
            ok: false,
            message: message ?? (toolResult.stderr.trim() || 'The sprintengine MCP command failed.'),
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }

        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'set-task-status',
            actor: actor.id,
            taskId,
            tool: toolResult.response.result,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async setRunnerMode(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        // Field rename: legacy `mode: 'auto' | 'off'` → `cliWatchPolling:
        // 'enabled' | 'disabled'`. Accept either shape from older callers and
        // translate to the new canonical value. SprintEngineRunnerSetInput in
        // src/shared/electron-api.ts documents this contract.
        const legacyModeAlias = (payload as { mode?: unknown } | undefined)?.mode
        let cliWatchPolling: string | undefined
        if (payload?.cliWatchPolling === 'enabled' || payload?.cliWatchPolling === 'disabled') {
          cliWatchPolling = payload.cliWatchPolling
        } else if (legacyModeAlias === 'auto') {
          cliWatchPolling = 'enabled'
        } else if (legacyModeAlias === 'off') {
          cliWatchPolling = 'disabled'
        }
        if (cliWatchPolling !== 'enabled' && cliWatchPolling !== 'disabled') {
          throw new Error('CLI watch polling must be enabled or disabled (legacy mode: auto|off also accepted).')
        }
        const toolResult = await runSprintEngineCli(state, [
          '--state',
          state.statePath,
          'runner',
          'set',
          '--cli-watch-polling',
          cliWatchPolling,
          '--actor',
          'ui',
        ])
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine runner command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'runner-set-mode',
            cliWatchPolling,
            tool: parseSprintEngineCliJsonOutput(toolResult.stdout),
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    // Push the run worktree branch and open a pull request. Best-effort: a
    // push/PR failure is recorded on the vcs record (status=failed +
    // pullRequestError) and surfaced through the refreshed projection, so the
    // summary shows the real reason and a Retry rather than a silent "pending".
    // User cancellation (MC-1604b): run the engine `cancel` op under the run
    // lock — run status → canceled, non-done tasks canceled, owners/leases
    // released. The caller (the module) additionally parks the automation
    // runtime via sprintRuntime.cancelRun so live agents are torn down; this
    // service only owns the state write, mirroring createPullRequest's shape.
    async cancelRun(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const toolResult = await runSprintEngineCli(state, [
          '--state',
          state.statePath,
          'cancel',
          '--id',
          'ui',
        ])
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'Canceling the sprint failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'cancel-run',
            tool: parseSprintEngineCliJsonOutput(toolResult.stdout),
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async createPullRequest(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const toolResult = await runSprintEngineCli(state, [
          '--state',
          state.statePath,
          'vcs',
          'pr',
          '--id',
          'ui',
        ])
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'Opening the pull request failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'vcs-pr',
            tool: parseSprintEngineCliJsonOutput(toolResult.stdout),
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    // Resolve and persist whether the run branch has merged (PR state or branch
    // ancestry). Read-only network/git probe; never mutates the working tree.
    async refreshPullRequestStatus(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const toolResult = await runSprintEngineCli(state, [
          '--state',
          state.statePath,
          'vcs',
          'pr-status',
        ])
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'Refreshing pull-request status failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'vcs-pr-status',
            tool: parseSprintEngineCliJsonOutput(toolResult.stdout),
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async setRoleRuntime(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const role = resolveSprintEngineRosterRole(payload?.role)
        const cli = typeof payload?.cli === 'string' ? payload.cli.trim() : ''
        if (!cli) {
          return { ok: false, message: 'A CLI id is required when setting a role runtime.' }
        }
        const model = typeof payload?.model === 'string' ? payload.model.trim() : ''
        const args = [
          '--state',
          state.statePath,
          'roster',
          'runtime',
          '--role',
          role,
          '--cli',
          cli,
          '--actor',
          'ui',
        ]
        if (model) {
          args.push('--model', model)
        }
        const toolResult = await runSprintEngineCli(state, args)
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine roster command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        const tool = parseSprintEngineCliJsonOutput(toolResult.stdout)
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'roster-runtime',
            role,
            tool,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async enableRole(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const role = resolveSprintEngineRosterRole(payload?.role)
        const args = [
          '--state',
          state.statePath,
          'roster',
          'enable',
          '--role',
          role,
          '--actor',
          'ui',
        ]
        const cli = typeof payload?.cli === 'string' ? payload.cli.trim() : ''
        if (cli) {
          args.push('--cli', cli)
          const model = typeof payload?.model === 'string' ? payload.model.trim() : ''
          if (model) {
            args.push('--model', model)
          }
        }
        const toolResult = await runSprintEngineCli(state, args)
        if (toolResult.exitCode !== 0) {
          return {
            ok: false,
            message: toolResult.stderr.trim() || toolResult.stdout.trim() || 'The sprintengine roster command failed.',
            stdout: toolResult.stdout,
            stderr: toolResult.stderr,
            exitCode: toolResult.exitCode ?? 'unknown',
          }
        }
        const tool = parseSprintEngineCliJsonOutput(toolResult.stdout)
        return {
          ok: true,
          data: await buildSprintEngineMutationData(state, {
            action: 'roster-enable',
            role,
            tool,
          }),
        }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readProjection(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        const projectionPath = join(state.teamDirectory, 'projection.json')
        // Cheap change-detection: stat the file and fingerprint it as mtime:size.
        // If the caller's last-seen token matches, the projection has not changed
        // since they read it, so we skip the read + parse + IPC payload entirely.
        let stats: Awaited<ReturnType<typeof stat>>
        try {
          stats = await stat(projectionPath)
        } catch (error) {
          // Missing projection.json splits on whether the run directory itself is
          // gone. Gone = the run was archived or deleted out from under the
          // workspace, which no retry heals — `permanent` lets pollers stop.
          // Directory present but projection not yet written (a just-created run)
          // stays transient so the next poll picks it up.
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (code === 'ENOENT' && !existsSync(state.teamDirectory)) {
            return {
              ok: false,
              permanent: true,
              message:
                `Sprint run data is missing: "${state.teamDirectory}" no longer exists `
                + '(moved or deleted). Restore the folder or remove this workspace.',
            }
          }
          throw error
        }
        const token = `${stats.mtimeMs}:${stats.size}`
        if (payload?.knownToken && payload.knownToken === token) {
          return { ok: true, data: null, token, unchanged: true }
        }
        const projectionContent = await readFile(projectionPath, 'utf8')
        const projection = JSON.parse(projectionContent)
        const rejection = describeUnsupportedSprintEngineStore(projection, state.teamDirectory)
        if (rejection) return { ok: false, message: rejection, permanent: true }
        return { ok: true, data: projection, token }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async readRegistryRoles(payload) {
      return readSprintEngineRegistryRolesWith(runMcpTool, payload)
    },

    async readRegistryRole(payload) {
      try {
        const workspaceRoot = validateWorkspaceRoot(payload?.workspaceRoot)
        const roleId = resolveRequiredString(payload?.roleId, 'Role id')
        const pluginRegistryRoots = sprintEngineRegistryRootsForRead()
        return runReadOnlyMcpTool(
          runMcpTool,
          { workspaceRoot, allowedRoots: pluginRegistryRoots.map((root) => root.root) },
          'sprintengine.roles.get',
          { workspaceRoot, roleId, pluginRegistryRoots }
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },

    async summarizeFeedback(payload) {
      try {
        const state = validateSprintEngineStatePath(payload?.statePath)
        return runReadOnlyMcpTool(
          runMcpTool,
          { workspaceRoot: state.workspaceRoot },
          'sprintengine.feedback.summarize',
          { statePath: state.statePath }
        )
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}
