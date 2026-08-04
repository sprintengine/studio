import { createHash } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { readFile, stat } from 'fs/promises'
import {
  SPRINT_ENGINE_AUTOMATION_INTENT_FILE,
  parseSprintEngineAutomationIntentRecord,
} from '../../../shared/sprintengine/automation-intent'
import { selectTaskStatusSources } from './task-normalizer'
import type {
  SwitchboardReadResult,
  SwitchboardRunnerExecution,
  SwitchboardRunnerResult,
  SwitchboardTaskRecord,
  WatchtowerRun,
  WatchtowerRunListResult,
} from '../../../shared/switchboard'
import {
  getSwitchboardRunnerState,
  listWatchtowerRuns,
  readAllSwitchboardTasks,
} from '../../switchboard-files'
import {
  mobileControlProtocolVersion,
  mobileControlWorkspaceSnapshotVersion,
} from '../../../shared/mobile-control/protocol'
// Wire schema is owned by src/shared/mobile-control/protocol.ts. Import the
// snapshot type tree from there (aliased to this module's established local
// names) and re-export it, rather than re-declaring it and risking drift from
// the validator (validateMobileControlSnapshot) that consumes the same schema.
import type {
  MobileControlBacklogWorkspaceSnapshot,
  MobileControlCommandType,
  MobileControlSnapshot,
  MobileControlSprintEngineSnapshot as MobileSprintEngineSnapshot,
  MobileControlAutomationMode,
  MobileControlSprintEngineVcsState,
  MobileControlSprintEngineRepo,
  MobileControlSprintEngineStartedFrom,
  MobileControlTaskSnapshot as MobileSprintEngineTaskSnapshot,
  MobileControlArtifactSnapshot as MobileSprintEngineArtifactSnapshot,
  MobileControlWorkspaceSnapshot as MobileWorkspaceSnapshot,
  MobileControlTaskCommentSummary as MobileSprintEngineCommentSummary,
  MobileControlRecordedArtifactSummary as MobileSprintEngineRecordedArtifactSummary,
  MobileControlTaskBacklogRef,
  MobileControlTaskNeedsInput,
  MobileControlTaskEvidence,
  MobileControlTaskFeedback,
  MobileControlTaskReviewSignals,
  MobileControlTaskRelease,
  MobileControlNeedsInputKind,
  MobileControlTaskCommentType as MobileTaskCommentType,
  MobileControlSwitchboardTaskSummary as MobileSwitchboardTaskSummary,
  MobileControlSwitchboardCommentSummary as MobileSwitchboardCommentSummary,
  MobileControlSwitchboardEvidenceSummary as MobileSwitchboardEvidenceSummary,
  MobileControlSwitchboardLogSummary as MobileSwitchboardLogSummary,
  MobileControlWatchtowerRunSummary as MobileWatchtowerRunSummary,
  MobileControlWatchtowerGeneratedInboxSummary as MobileWatchtowerGeneratedInboxSummary,
  MobileSnapshotCollection,
} from '../../../shared/mobile-control/protocol'
import { readMobileAutomationSnapshots } from './automations'
import { readMobileRoadmapRiders } from './roadmapRider'
import { readMobileBacklogWorkspaceSnapshot } from './backlog'
import { readWorkspaceRoleCatalog, type RoleCatalogReader } from './role-catalog'
import { deriveWorkspaceId } from './workspace-id'
import { containsLocalPath, deepRedactLocalPaths } from './relay-path-safety'

export type {
  MobileControlSnapshot,
  MobileSprintEngineSnapshot,
  MobileSprintEngineTaskSnapshot,
  MobileSprintEngineArtifactSnapshot,
  MobileWorkspaceSnapshot,
  MobileSprintEngineCommentSummary,
  MobileSprintEngineRecordedArtifactSummary,
}

const defaultPublishThrottleMs = 1000
const maxWorkspaceCollectionItems = 20
const maxNestedWorkspaceCollectionItems = 10
const mobileSnapshotCommandTypes = [
  'snapshot.request',
  'artifact.read',
  'sprintengine.create',
  'task.start',
  'artifact.approve',
  'artifact.requestChanges',
  'agent.followUp',
  'device.revoke',
  'backlog.update',
  'backlog.startSprintEngine',
  'backlog.create',
  'sprintengine.openPullRequest',
  'sprintengine.setAutomationMode',
  // Item 47. Advertised now that the desktop can actually execute it (the
  // automations-control handler in command.ts). `snapshot.commands` is `string[]`
  // on the wire by design, so a phone that predates this command simply does not
  // see it — the read side needs no client release.
  'automations.control',
] as const satisfies readonly MobileControlCommandType[]

// The advertised set is a SUBSET of the command union — a command the desktop cannot
// execute yet must not be advertised — so membership is tested against the wide union
// rather than the narrow tuple's own element type.
const mobileSnapshotCommandSet = new Set<MobileControlCommandType>(mobileSnapshotCommandTypes)

export const defaultMobileSnapshotCommands: readonly MobileControlCommandType[] = mobileSnapshotCommandTypes

type SprintEngineTaskStatus = 'todo' | 'ready' | 'in_progress' | 'review' | 'needs_input' | 'done' | 'canceled'
// Producer-side status unions derived from the imported wire schema so they
// cannot drift from protocol.ts.
type MobileTaskStatus = MobileSprintEngineTaskSnapshot['status']
type MobileArtifactStatus = MobileSprintEngineArtifactSnapshot['status']
type MobileWorkspaceStatus = MobileWorkspaceSnapshot['summary']['status']

export type MobileSprintEngineSnapshotRequest = {
  desktopSessionId: string
  statePaths: string[]
  workspaceRoots?: string[]
  commands?: MobileControlCommandType[]
  generatedAt?: string
  // Collection scoping (item 1600). Absent = the default set below; a caller that
  // names collections gets exactly those. Scoped to the read composition, not the
  // wire — `dispatchSnapshotRequest` maps the request `include` field to this.
  include?: MobileSnapshotCollection[]
}

// The unscoped default: every collection except the switchboard/watchtower
// projections (`desktopWorkspaces`), which nothing on the phone drives today, so they
// ship only when a caller asks for them explicitly (item 1600).
const defaultSnapshotCollections: ReadonlySet<MobileSnapshotCollection> = new Set([
  'sprintEngines',
  'backlog',
  'roleCatalogs',
  'automations',
])

type MobileSprintEngineSnapshotListener = (snapshot: MobileControlSnapshot) => void

// Replace embedded workspace roots in a kind-scoped workspaceId (e.g.
// `switchboard:/Users/...`) with the relay-safe token while preserving the kind
// prefix. Ids that carry no local path (a bare sprintEngineId) are already
// safe and left untouched.
function relaySafeWorkspaceId(workspaceId: string, token: string): string {
  if (!containsLocalPath(workspaceId)) return workspaceId
  const separator = workspaceId.indexOf(':')
  return separator === -1 ? token : `${workspaceId.slice(0, separator)}:${token}`
}

// Make an outbound snapshot relay-safe: the relay rejects any summary containing
// an absolute local path (multiauth src/relay/result-summary.ts). Round-trip
// critical workspace roots become resolvable tokens (deriveWorkspaceId);
// display-only path fields become the folder name or are dropped; any remaining
// absolute path anywhere in the payload is redacted as a defensive backstop.
// Applied only to the copy emitted to the phone — readSnapshot() keeps the real
// paths for server-side resolution (e.g. artifact.read).
export function sanitizeMobileSnapshotForRelay(snapshot: MobileControlSnapshot): MobileControlSnapshot {
  // The phone's join key across all three collections (MC-1583). Each collection
  // encodes `workspacePath` differently below — dropped, basename, token — because
  // each has a different round-trip need, so none of them can be the join key.
  // This is the same token for the same repo root in every collection.
  const sprintEngines = snapshot.sprintEngines.map((sprintEngine) => ({
    ...sprintEngine,
    projectKey: deriveWorkspaceId(sprintEngine.workspacePath),
    // Display-only on the phone: the board derives the name via lastPathSegment.
    workspacePath: basename(sprintEngine.workspacePath),
    // statePath is resolved server-side from sprintEngineId and never round-tripped
    // by the phone, but the mobile snapshot validator requires it to be a
    // non-empty string, so replace the absolute path with a relay-safe token
    // rather than blanking it. planPath is optional, so drop it.
    statePath: deriveWorkspaceId(sprintEngine.statePath),
    planPath: undefined,
  }))

  const workspaces = snapshot.workspaces?.map((workspace) => {
    const token = workspace.workspacePath ? deriveWorkspaceId(workspace.workspacePath) : undefined
    return {
      ...workspace,
      workspaceId: token ? relaySafeWorkspaceId(workspace.workspaceId, token) : workspace.workspaceId,
      projectKey: token,
      // Optional on the wire and display-only (the card already shows `name`).
      workspacePath: undefined,
      statePath: undefined,
    }
  })

  const backlog = snapshot.backlog?.map((workspace) => {
    const token = deriveWorkspaceId(workspace.workspacePath)
    return {
      ...workspace,
      // Round-trips back for backlog.create/.update/.startSprintEngine, so it has
      // to be a resolvable token rather than a display string. The phone shows
      // workspaceName, not this field.
      workspaceId: `backlog:${token}`,
      workspacePath: token,
      projectKey: token,
    }
  })

  return deepRedactLocalPaths({
    ...snapshot,
    sprintEngines,
    ...(workspaces ? { workspaces } : {}),
    ...(backlog ? { backlog } : {}),
  })
}

type MobileSprintEngineSnapshotServiceOptions = {
  publishThrottleMs?: number
  supportedCommands?: readonly MobileControlCommandType[]
  stateReaders?: Partial<DesktopWorkspaceStateReaders>
}

type RawSprintEngineState = {
  sprintengine?: Record<string, unknown>
  tasks?: unknown[]
  artifacts?: unknown[]
  runSummary?: unknown
  summary?: unknown
  planReview?: unknown
  planReviewState?: unknown
}

type NormalizedTask = {
  id: string
  title: string
  // Absent for a roleless task (MC-2057, run schema v5). Carried as `undefined`
  // rather than defaulted so the omission survives all the way onto the wire.
  role?: string
  status: SprintEngineTaskStatus
  boardColumn?: SprintEngineTaskStatus
  ownerAgentId: string | null
  /** The backlog item this task delivers (MC-2060), when it names one. */
  backlogRef?: MobileControlTaskBacklogRef
  dependsOn: string[]
  needsInput?: MobileControlTaskNeedsInput
  evidence?: MobileControlTaskEvidence
  feedback?: MobileControlTaskFeedback
  reviewSignals?: MobileControlTaskReviewSignals
  release?: MobileControlTaskRelease
  latestComments?: MobileSprintEngineCommentSummary[]
  latestOpenFeedback?: MobileSprintEngineCommentSummary[]
  recordedArtifacts?: MobileSprintEngineRecordedArtifactSummary[]
}

type DesktopWorkspaceStateReaders = {
  readSwitchboardTasks(input: { workspaceRoot: string }): Promise<SwitchboardReadResult>
  getSwitchboardRunnerState(input: string): Promise<SwitchboardRunnerResult>
  listWatchtowerRuns(workspaceRoot: string): Promise<WatchtowerRunListResult>
  readRoleCatalog: RoleCatalogReader
}

const defaultStateReaders: DesktopWorkspaceStateReaders = {
  readSwitchboardTasks: readAllSwitchboardTasks,
  getSwitchboardRunnerState,
  listWatchtowerRuns,
  readRoleCatalog: readWorkspaceRoleCatalog,
}

export class MobileSprintEngineSnapshotService {
  private readonly listeners = new Set<MobileSprintEngineSnapshotListener>()
  private readonly publishThrottleMs: number
  private lastPublishedAt = 0
  private pendingRequest: MobileSprintEngineSnapshotRequest | null = null
  private publishTimer: NodeJS.Timeout | null = null
  private readonly stateReaders: DesktopWorkspaceStateReaders
  private readonly supportedCommands: MobileControlCommandType[]

  constructor(options: MobileSprintEngineSnapshotServiceOptions = {}) {
    this.publishThrottleMs = Math.max(0, options.publishThrottleMs ?? defaultPublishThrottleMs)
    this.stateReaders = { ...defaultStateReaders, ...options.stateReaders }
    this.supportedCommands = normalizeMobileControlCommands(options.supportedCommands ?? defaultMobileSnapshotCommands)
  }

  subscribe(listener: MobileSprintEngineSnapshotListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async readSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot> {
    const generatedAt = request.generatedAt ?? new Date().toISOString()
    const collections = request.include ? new Set(request.include) : defaultSnapshotCollections
    const settledSprintEngines = collections.has('sprintEngines')
      ? await Promise.allSettled(request.statePaths.map((statePath) => readSprintEngineSnapshot(statePath)))
      : []
    const sprintEngines = settledSprintEngines.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
    const workspaceRoots = uniqueResolved([
      ...(request.workspaceRoots ?? []),
      ...sprintEngines.map((sprintEngine) => sprintEngine.workspacePath),
    ])
    const desktopWorkspaces = collections.has('desktopWorkspaces')
      ? await this.readDesktopWorkspaceSnapshots(workspaceRoots, generatedAt)
      : []
    const workspaces = [
      ...sprintEngines.map(toSprintEngineWorkspaceSnapshot),
      ...desktopWorkspaces,
    ]
    const backlog = collections.has('backlog')
      ? await readBacklogWorkspaceSnapshots(workspaceRoots, generatedAt, this.stateReaders.readRoleCatalog, collections.has('roleCatalogs'))
      : []
    // Item 47: the automations monitor. One projection per workspace root, joined to
    // the other collections on `projectKey` (stamped by the producer, from the same
    // deriveWorkspaceId the sanitize pass stamps sprint engines with).
    const automations = collections.has('automations')
      ? (await Promise.all(workspaceRoots.map((workspaceRoot) => readMobileAutomationSnapshots(workspaceRoot, generatedAt)))).flat()
      : []
    // Read-only roadmap progress riders (MC-1620). Additive and rides the existing
    // `sprintEngines` scope — no new relay scope, so an old phone that never reads
    // `roadmaps` is untouched (scopes freeze at pair time).
    const roadmaps = collections.has('sprintEngines')
      ? (await Promise.all(workspaceRoots.map((workspaceRoot) => readMobileRoadmapRiders(workspaceRoot).catch(() => [])))).flat()
      : []

    return {
      protocolVersion: mobileControlProtocolVersion,
      generatedAt,
      desktopSessionId: request.desktopSessionId,
      // Content-derived so the phone's If-None-Match (item 1599) matches on an
      // idle read. It folds NO per-read wall-clock: the top level dropped
      // `generatedAt`, and each workspace/backlog `updatedAt` — which falls back
      // to `generatedAt` for an empty or desktop workspace, and is `generatedAt`
      // outright for switchboard/watchtower — is stripped before hashing. Each
      // sprint engine contributes its own content-stable sub-version (already
      // folds tasks, artifacts, automation mode and state mtime, preserving the
      // MC-1567 invariant); backlog and automations are folded so a backlog-only
      // or automations-only change still bumps the version. Roadmap riders are
      // folded too: a lane's parked/running state comes from the orchestrator
      // sidecar and can move with NO backlog or sprint-engine delta (see the
      // parked-lane case in roadmapRider.test.ts), so without this the now-live
      // fast path would serve a phone stale roadmap progress. Riders carry only
      // derived progress (done/total/name/running/parked) — no wall-clock — so
      // they fold verbatim, no read-time strip needed.
      snapshotVersion: buildSnapshotVersion({
        sprintEngines: sprintEngines.map((sprintEngine) => sprintEngine.snapshotVersion),
        workspaces: workspaces.map(withoutReadTimeStamp),
        backlog: backlog.map(withoutReadTimeStamp),
        automations,
        roadmaps,
      }),
      commands: normalizeMobileControlCommands(request.commands ?? this.supportedCommands),
      sprintEngines,
      workspaces,
      ...(backlog.length > 0 ? { backlog } : {}),
      ...(automations.length > 0 ? { automations } : {}),
      ...(roadmaps.length > 0 ? { roadmaps } : {}),
    }
  }

  async publishSnapshot(request: MobileSprintEngineSnapshotRequest): Promise<MobileControlSnapshot | null> {
    const now = Date.now()
    const elapsedMs = now - this.lastPublishedAt
    if (elapsedMs >= this.publishThrottleMs) {
      this.clearPublishTimer()
      const snapshot = await this.readSnapshot(request)
      this.emit(snapshot)
      this.lastPublishedAt = Date.now()
      return snapshot
    }

    this.pendingRequest = request
    if (!this.publishTimer) {
      this.publishTimer = setTimeout(() => {
        void this.flushPendingSnapshot()
      }, this.publishThrottleMs - elapsedMs)
    }
    return null
  }

  async flushPendingSnapshot(): Promise<MobileControlSnapshot | null> {
    const request = this.pendingRequest
    if (!request) {
      this.clearPublishTimer()
      return null
    }

    this.pendingRequest = null
    this.clearPublishTimer()
    const snapshot = await this.readSnapshot(request)
    this.emit(snapshot)
    this.lastPublishedAt = Date.now()
    return snapshot
  }

  shutdown(): void {
    this.clearPublishTimer()
    this.pendingRequest = null
    this.listeners.clear()
  }

  private emit(snapshot: MobileControlSnapshot): void {
    const safe = sanitizeMobileSnapshotForRelay(snapshot)
    for (const listener of this.listeners) {
      listener(safe)
    }
  }

  private clearPublishTimer(): void {
    if (!this.publishTimer) return
    clearTimeout(this.publishTimer)
    this.publishTimer = null
  }

  private async readDesktopWorkspaceSnapshots(workspaceRoots: string[], generatedAt: string): Promise<MobileWorkspaceSnapshot[]> {
    const settled = await Promise.allSettled(workspaceRoots.map(async (workspaceRoot) => {
      const [switchboard, watchtower] = await Promise.all([
        readSwitchboardWorkspaceSnapshot(workspaceRoot, generatedAt, this.stateReaders),
        readWatchtowerWorkspaceSnapshot(workspaceRoot, generatedAt, this.stateReaders),
      ])
      return [switchboard, watchtower].filter((workspace): workspace is MobileWorkspaceSnapshot => Boolean(workspace))
    }))

    return settled.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
  }
}

// The role catalog rides the backlog workspace because that is the record the
// phone's two launch surfaces pick a `workspacePath` from (MC-1543). It is read
// per workspace and never blocks the backlog.
//
// ABSENT AND EMPTY ARE DIFFERENT FACTS, and the phone acts on the difference:
//
// - `roles` absent  → the registry could not be read, the catalog was shed by the
//                     size ladder, or the desktop predates the field. The phone
//                     does not know, and falls back to its bundled list.
// - `roles: []`     → the registry was read and this workspace genuinely has no
//                     roles. Since MC-1587 un-shipped the bundled role pack that
//                     is an ordinary state, not a fault. The phone must NOT fall
//                     back here: those ten ids would become the run's
//                     `configuredRoles` and nothing could staff them.
//
// This used to read `roles && roles.length > 0`, which collapsed the second case
// into the first and made the phone offer invented roles precisely when the
// desktop had told it there were none.
async function readBacklogWorkspaceSnapshots(
  workspaceRoots: string[],
  generatedAt: string,
  readRoleCatalog: RoleCatalogReader,
  includeRoleCatalogs: boolean
): Promise<MobileControlBacklogWorkspaceSnapshot[]> {
  const settled = await Promise.allSettled(
    workspaceRoots.map(async (workspaceRoot) => {
      const workspace = await readMobileBacklogWorkspaceSnapshot(workspaceRoot, generatedAt)
      if (!workspace) return null
      if (!includeRoleCatalogs) return workspace
      const roles = await readRoleCatalog(workspaceRoot).catch(() => undefined)
      return roles ? { ...workspace, roles } : workspace
    })
  )
  return settled
    .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
    .sort((left, right) => left.workspaceName.localeCompare(right.workspaceName))
}

export async function readSprintEngineSnapshot(statePathInput: string): Promise<MobileSprintEngineSnapshot> {
  const statePath = resolve(statePathInput)
  if (basename(statePath) !== 'run.yaml') {
    throw new Error('Sprint snapshot path must point to a run.yaml file.')
  }

  const teamDirectory = dirname(statePath)
  const projectionSnapshot = await readSprintEngineProjectionSnapshot(statePath, teamDirectory)
  if (projectionSnapshot) return projectionSnapshot
  const intentMode = await readAutomationIntentMode(teamDirectory)

  const [content, stateStats] = await Promise.all([
    readFile(statePath, 'utf8'),
    stat(statePath),
  ])
  const parsed = JSON.parse(content) as RawSprintEngineState
  const sprintEngineRootDirectory = dirname(teamDirectory)
  const workspacePath = dirname(dirname(sprintEngineRootDirectory))
  const sprintEngineId = basename(teamDirectory)
  const sprintengine = parsed.sprintengine && typeof parsed.sprintengine === 'object' ? parsed.sprintengine : {}
  const updatedAt = isoStringOrNull(sprintengine.updatedAt) ?? stateStats.mtime.toISOString()
  const tasks = normalizeTasks(parsed.tasks)
  const taskSnapshots = tasks.map((task) => toTaskSnapshot(task, tasks))
  const artifacts = normalizeArtifacts(parsed.artifacts)
  const board = countBoard(taskSnapshots)
  const snapshotVersion = buildSnapshotVersion({
    updatedAt,
    tasks: taskSnapshots,
    artifacts,
    // MC-1567: a mode-only change must produce a new snapshotVersion so
    // phone-side dedup can't miss the flip and the stale-snapshot guard can
    // detect a competing mode change.
    automationMode: intentMode ?? null,
  })

  return {
    sprintEngineId,
    name: stringOrFallback(sprintengine.name, sprintEngineId),
    workspacePath,
    statePath,
    planPath: join(teamDirectory, 'plan.md'),
    snapshotVersion,
    updatedAt,
    board,
    tasks: taskSnapshots,
    artifacts,
    // No roster on the pre-projection raw path: the run.yaml `agents` map was
    // deleted when leases replaced the roster (MC-1591), and the roster map is
    // now derived only from the projection's workers view. A store this old is
    // rejected by the schema guard anyway; this branch survives for shape safety.
    ...(recordSummary(parsed.runSummary ?? parsed.summary) ? { runSummary: recordSummary(parsed.runSummary ?? parsed.summary) } : {}),
    ...(recordSummary(parsed.planReview ?? parsed.planReviewState) ? { planReview: recordSummary(parsed.planReview ?? parsed.planReviewState) } : {}),
    ...(intentMode ? { automationMode: intentMode } : {}),
  }
}

async function readSprintEngineProjectionSnapshot(
  statePath: string,
  teamDirectory: string
): Promise<MobileSprintEngineSnapshot | null> {
  const projectionPath = join(teamDirectory, 'projection.json')
  let content: string
  let projectionMtime: string
  try {
    const [raw, stats] = await Promise.all([
      readFile(projectionPath, 'utf8'),
      stat(projectionPath),
    ])
    content = raw
    projectionMtime = stats.mtime.toISOString()
  } catch {
    return null
  }
  const projection = JSON.parse(content) as Record<string, unknown>
  const run = recordObject(projection.run) ?? {}
  const sprintEngineRootDirectory = dirname(teamDirectory)
  const workspacePath = dirname(dirname(sprintEngineRootDirectory))
  const sprintEngineId = stringOrNull(run.id) ?? basename(teamDirectory)
  // Fall back to the projection file's mtime, never a per-read wall-clock: this
  // `updatedAt` folds into the engine sub-version and thus the top-level
  // snapshotVersion, so `new Date()` here would rev the version on every read
  // fleet-wide and defeat the item-1599 unchanged fast path. mtime only moves
  // when the projection is actually rewritten.
  const updatedAt = isoStringOrNull(projection.updatedAt) ?? isoStringOrNull(run.updatedAt) ?? projectionMtime
  const tasks = normalizeTasks(projection.tasks)
  const taskSnapshots = tasks.map((task) => toTaskSnapshot(task, tasks))
  const artifacts = normalizeArtifacts(projection.artifacts)
  const board = countBoard(taskSnapshots)
  const locks = recordObject(projection.locks)
  const activity = Array.isArray(projection.activity) ? projection.activity : []
  const counts = recordObject(projection.counts)
  const intentMode = await readAutomationIntentMode(teamDirectory)
  const automationMode = intentMode
    ?? buildAutomationMode(run.automation ?? projection.automation, run.runner)
  const snapshotVersion = buildSnapshotVersion({
    updatedAt,
    source: run.source ?? projection.source,
    vcs: run.vcs,
    tasks: taskSnapshots,
    artifacts,
    locks,
    // MC-1567: a mode-only change must produce a new snapshotVersion so
    // phone-side dedup can't miss the flip and the stale-snapshot guard can
    // detect a competing mode change.
    automationMode: automationMode ?? null,
  })

  const startedFrom = buildStartedFrom(run.source ?? projection.source)
  const vcs = buildVcsState(run.vcs)

  return {
    sprintEngineId,
    name: stringOrFallback(run.name, sprintEngineId),
    workspacePath,
    statePath,
    planPath: stringOrNull(projection.planPath) ?? join(teamDirectory, 'plan.md'),
    snapshotVersion,
    updatedAt,
    board,
    tasks: taskSnapshots,
    artifacts,
    ...(normalizeRoster(projection.workers) ? { roster: normalizeRoster(projection.workers) } : {}),
    ...(recordSummary(projection.runSummary) ? { runSummary: recordSummary(projection.runSummary) } : {}),
    ...(automationMode ? { automationMode } : {}),
    ...(startedFrom ? { startedFrom } : {}),
    ...(vcs ? { vcs } : {}),
    ...(locks ? { locks: { warnings: Array.isArray(locks.warnings) ? locks.warnings : [], locks: Array.isArray(locks.locks) ? locks.locks : [] } } : {}),
    ...(activity.length > 0 ? { activity: { count: activity.length, latest: activity.at(-1) } } : {}),
    ...(counts ? { counts: { ready: numberOrUndefined(counts.ready), needsInput: numberOrUndefined(counts.needsInput) } } : {}),
  }
}

// --- MC-1498 provenance + vcs builders (projection run.source / run.vcs) -------

const BACKLOG_PATH = /^backlog[\\/]/i
const BACKLOG_EPICS_PATH = /^backlog[\\/]epics[\\/]/i

const STARTED_FROM_KIND_LABELS: Record<string, string> = {
  epic: 'Epic',
  product_plan: 'Product plan',
  markdown: 'Markdown',
  html: 'HTML',
  text: 'Text',
  backlog_item: 'Backlog item',
}

/**
 * The run's launch provenance from `run.source` (the projected launch seed). The
 * desktop Inbox additionally nests `sourceBundle` supporting files, but the mobile
 * projection carries only the primary seed today — so this ships the primary row,
 * which is what the phone's provenance chip needs. Additive: absent when the run
 * records no source.
 */
function buildStartedFrom(sourceValue: unknown): MobileControlSprintEngineStartedFrom | undefined {
  const source = recordObject(sourceValue)
  const path = source ? stringOrNull(source.path) : null
  if (!source || !path) {
    return undefined
  }

  const isEpic = BACKLOG_EPICS_PATH.test(path)
  const isBacklog = BACKLOG_PATH.test(path)
  const fileName = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
  const kind = stringOrNull(source.kind)
  const kindLabel = (kind && STARTED_FROM_KIND_LABELS[kind]) ?? (isEpic ? 'Epic' : isBacklog ? 'Backlog item' : 'Seed document')
  const capturedAt = isoStringOrNull(source.capturedAt)

  return {
    epic: isEpic,
    subtitle: isEpic ? 'epic' : isBacklog ? 'backlog item' : 'seed document',
    rows: [
      {
        path,
        fileName,
        kindLabel,
        role: 'primary',
        isPrimary: true,
        ...(capturedAt ? { capturedAt } : {}),
        ...(isBacklog ? { backlogPath: path } : {}),
      },
    ],
  }
}

const automationModes = new Set<MobileControlAutomationMode>(['manual', 'run_agents', 'run_agents_and_approve_artifacts'])

/**
 * The authoritative automation mode intent (MC-1567): the main-owned
 * `automation.json` sidecar beside run.yaml, written by every mode writer
 * through `sprintengine-automation-service.ts`. Exact — including the
 * `run_agents_and_approve_artifacts` variant the cliWatchPolling heuristic
 * cannot express. Absent (undefined) until the run's first write/hydration, in
 * which case the legacy best-effort fallbacks below still apply.
 */
async function readAutomationIntentMode(teamDirectory: string): Promise<MobileControlAutomationMode | undefined> {
  let raw: string
  try {
    raw = await readFile(join(teamDirectory, SPRINT_ENGINE_AUTOMATION_INTENT_FILE), 'utf8')
  } catch {
    return undefined
  }
  try {
    const record = parseSprintEngineAutomationIntentRecord(JSON.parse(raw))
    return record?.desiredMode
  } catch {
    return undefined
  }
}

/**
 * Legacy best-effort automation mode (MC-1497, pre-MC-1567 runs with no
 * `automation.json` yet). Prefers an explicit `desiredMode` if the projection
 * carries one; otherwise derives from the runner's `cliWatchPolling`
 * (disabled → manual, enabled → run_agents). The
 * `run_agents_and_approve_artifacts` variant cannot be distinguished from
 * `cliWatchPolling` alone. Absent when nothing is known.
 */
function buildAutomationMode(automationValue: unknown, runnerValue: unknown): MobileControlAutomationMode | undefined {
  const automation = recordObject(automationValue)
  const desired = automation ? stringOrNull(automation.desiredMode) ?? stringOrNull(automation.mode) : null
  if (desired && automationModes.has(desired as MobileControlAutomationMode)) {
    return desired as MobileControlAutomationMode
  }

  const runner = recordObject(runnerValue)
  const cliWatchPolling = runner ? stringOrNull(runner.cliWatchPolling) : null
  if (cliWatchPolling === 'disabled') return 'manual'
  if (cliWatchPolling === 'enabled') return 'run_agents'
  return undefined
}

/**
 * One declared project from `run.vcs.repos`, in the phone's vocabulary (`branch`,
 * not `branchName` — the same rename the block below applies to the primary repo).
 * An entry the phone cannot name or place would render as a phantom project row,
 * so it is dropped; the engine refuses to start a run whose entries lack these
 * fields (`_normalized_repo_entry`, sprintengine_core/tool/shell.py).
 */
function buildRepoState(repoValue: unknown): MobileControlSprintEngineRepo | undefined {
  const repo = recordObject(repoValue)
  if (!repo) return undefined

  const id = stringOrNull(repo.id)
  const root = stringOrNull(repo.root)
  const branch = stringOrNull(repo.branchName)
  if (!id || !root || !branch) return undefined

  const status = stringOrNull(repo.status)
  return { id, root, branch, ...(status ? { status } : {}) }
}

/**
 * Worktree / PR state from the projected `run.vcs` block (mirrors
 * `SprintEngineVcs`). Absent for non-worktree runs (`run.vcs` null). Read
 * defensively so a shape change never breaks the snapshot.
 */
function buildVcsState(vcsValue: unknown): MobileControlSprintEngineVcsState | undefined {
  const vcs = recordObject(vcsValue)
  if (!vcs) {
    return undefined
  }

  const branch = stringOrNull(vcs.branchName) ?? stringOrNull(vcs.branch)
  const pullRequestUrl = stringOrNull(vcs.pullRequestUrl)
  const pullRequestStatus = stringOrNull(vcs.pullRequestState) ?? stringOrNull(vcs.status)
  const pullRequestError = stringOrNull(vcs.pullRequestError)
  // MC-1613: the run's projects ride ADDITIVELY beside the fields below, which keep
  // describing the primary project. A phone that does not read the list renders a
  // two-project run exactly as it renders a one-project run, and no relay scope
  // changes — scopes freeze at pair time, so a new one would break paired phones.
  // A single-repo run's list would only repeat the primary block, so it is omitted
  // and its snapshot stays byte-identical to a pre-multi-repo one. The list is the
  // only place a sibling project's branch and worktree state reach the phone.
  const repos = (Array.isArray(vcs.repos) ? vcs.repos : [])
    .map(buildRepoState)
    .filter((repo): repo is MobileControlSprintEngineRepo => Boolean(repo))

  return {
    worktree: vcs.mode === 'run_worktree' || Boolean(stringOrNull(vcs.worktreePath)),
    ...(branch ? { branch } : {}),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    ...(pullRequestStatus ? { pullRequestStatus } : {}),
    ...(pullRequestError ? { pullRequestError } : {}),
    ...(repos.length > 1 ? { repos } : {}),
  }
}

function normalizeTasks(value: unknown): NormalizedTask[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((task, index) => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return []
    const record = task as Record<string, unknown>
    const id = stringOrFallback(record.id, `task-${index + 1}`)
    // Shared precedence with the command-readiness reader: the semantic status is
    // `stateStatus ?? status` (projection records mirror the board column into
    // `status`), the lane is `boardColumn`. The board-aware union below is kept.
    const statusSources = selectTaskStatusSources(record)
    return [{
      id,
      title: stringOrFallback(record.title, id),
      // MC-2057 made a task's role optional and deleted `general`. This used to
      // read `stringOrFallback(record.role, 'developer')`, which forged a role for
      // every roleless task — including the coordinator seat's — and the phone
      // rendered the forgery as fact. Emit the absence instead; the wire field is
      // optional (see MobileControlTaskSnapshot.role).
      role: stringOrUndefined(record.role),
      status: normalizeTaskStatus(statusSources.status),
      boardColumn: normalizeOptionalTaskStatus(statusSources.boardColumn),
      ownerAgentId: typeof record.ownerAgentId === 'string' && record.ownerAgentId.trim()
        ? record.ownerAgentId
        : null,
      ...(normalizeTaskBacklogRef(record.backlogRef) ? { backlogRef: normalizeTaskBacklogRef(record.backlogRef)! } : {}),
      dependsOn: stringArray(record.dependsOn),
      needsInput: normalizeNeedsInput(record.needsInput),
      evidence: normalizeEvidence(record.evidence),
      feedback: normalizeTaskFeedback(record.feedback),
      reviewSignals: normalizeReviewSignals(record),
      release: normalizeRelease(record.release ?? record.taskRelease),
      latestComments: normalizeMobileComments(record.latestComments),
      latestOpenFeedback: normalizeMobileComments(record.latestOpenFeedback),
      recordedArtifacts: normalizeMobileRecordedArtifacts(record.recordedArtifacts),
    }]
  })
}

function toSprintEngineWorkspaceSnapshot(sprintEngine: MobileSprintEngineSnapshot): MobileWorkspaceSnapshot {
  return {
    workspaceId: sprintEngine.sprintEngineId,
    kind: 'sprintengine',
    name: sprintEngine.name,
    workspacePath: sprintEngine.workspacePath,
    statePath: sprintEngine.statePath,
    updatedAt: sprintEngine.updatedAt,
    capabilities: ['summary.read', 'detail.read', 'logs.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: sprintEngineWorkspaceStatus(sprintEngine),
      headline: `${sprintEngine.board.ready} ready, ${sprintEngine.board.needsInput} needs input`,
      counts: {
        todo: sprintEngine.board.todo,
        ready: sprintEngine.board.ready,
        inProgress: sprintEngine.board.inProgress,
        review: sprintEngine.board.review,
        needsInput: sprintEngine.board.needsInput,
        done: sprintEngine.board.done,
      },
    },
    detail: {
      kind: 'sprintengine',
      data: {
        sprintEngineId: sprintEngine.sprintEngineId,
        snapshotVersion: sprintEngine.snapshotVersion,
        board: sprintEngine.board,
        ...(sprintEngine.roster ? { roster: sprintEngine.roster } : {}),
        ...(sprintEngine.runSummary ? { runSummary: sprintEngine.runSummary } : {}),
        ...(sprintEngine.planReview ? { planReview: sprintEngine.planReview } : {}),
      },
    },
  }
}

function sprintEngineWorkspaceStatus(sprintEngine: MobileSprintEngineSnapshot): MobileWorkspaceStatus {
  // A canceled run must not read as `complete` (MC-1604: cancellation is a
  // distinct terminal state and done-task residue is not completion). The v2
  // wire's coarse status union has no `canceled` value and the wire stays v2
  // by decision (MC-1594) — the run-level truth rides `runSummary.status`, so
  // the card-level summary degrades to `unknown` rather than lying.
  const runStatus = (sprintEngine.runSummary as Record<string, unknown> | undefined)?.status
  if (runStatus === 'canceled') return 'unknown'
  if (sprintEngine.board.needsInput > 0) return 'needs_input'
  // A task in its `review` phase is still active work owned by its implementer
  // (MC-1542 single-owner tasks), so it counts as running alongside in-progress.
  if (
    sprintEngine.board.inProgress > 0
    || sprintEngine.board.review > 0
  ) return 'running'
  if (sprintEngine.board.ready > 0 || sprintEngine.board.todo > 0) return 'idle'
  if (sprintEngine.board.done > 0) return 'complete'
  return 'unknown'
}

function normalizeArtifacts(value: unknown): MobileSprintEngineArtifactSnapshot[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((artifact, index) => {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) return []
    const record = artifact as Record<string, unknown>
    const artifactId = stringOrNull(record.id)
    const status = normalizeArtifactStatus(record.status)
    if (!artifactId || !status) return []

    return [{
      artifactId,
      title: stringOrFallback(record.title, artifactId || `Artifact ${index + 1}`),
      kind: stringOrFallback(record.kind, 'unknown'),
      status,
      ...(typeof record.taskId === 'string' && record.taskId.trim() ? { taskId: record.taskId } : {}),
      ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path } : {}),
    }]
  })
}

function toTaskSnapshot(task: NormalizedTask, tasks: NormalizedTask[]): MobileSprintEngineTaskSnapshot {
  const status = getMobileTaskStatus(task, tasks)
  return {
    taskId: task.id,
    title: task.title,
    // Spread-conditional like every other optional field here: a roleless task
    // omits the key outright rather than carrying `role: undefined`, so the
    // absence is the same shape whether it crosses JSON or is read in-process.
    ...(task.role ? { role: task.role } : {}),
    status,
    ...(task.ownerAgentId ? { ownerAgentId: task.ownerAgentId } : {}),
    ...(task.backlogRef ? { backlogRef: task.backlogRef } : {}),
    dependsOn: task.dependsOn,
    ...(task.needsInput ? { needsInput: task.needsInput } : {}),
    ...(task.evidence ? { evidence: task.evidence } : {}),
    ...(task.feedback ? { feedback: task.feedback } : {}),
    ...(task.reviewSignals ? { reviewSignals: task.reviewSignals } : {}),
    ...(task.release ? { release: task.release } : {}),
    ...(task.latestComments ? { latestComments: task.latestComments } : {}),
    ...(task.latestOpenFeedback ? { latestOpenFeedback: task.latestOpenFeedback } : {}),
    ...(task.recordedArtifacts ? { recordedArtifacts: task.recordedArtifacts } : {}),
  }
}

function getMobileTaskStatus(task: NormalizedTask, tasks: NormalizedTask[]): MobileTaskStatus {
  // The `review` board column is authoritative when present, so mobile clients
  // render it as its own lane (MC-1542: the task's owner is reviewing its diff).
  if (task.boardColumn === 'review') {
    return task.boardColumn
  }
  if (
    task.status === 'ready'
    || task.status === 'done'
    || task.status === 'in_progress'
    || task.status === 'review'
    || task.status === 'needs_input'
    || task.status === 'canceled'
  ) {
    return task.status
  }

  const dependenciesDone = task.dependsOn.every((dependencyId) =>
    tasks.some((candidate) => candidate.id === dependencyId && candidate.status === 'done')
  )
  return dependenciesDone ? 'ready' : 'todo'
}

function countBoard(tasks: MobileSprintEngineTaskSnapshot[]): MobileSprintEngineSnapshot['board'] {
  const board: MobileSprintEngineSnapshot['board'] = {
    todo: 0,
    ready: 0,
    inProgress: 0,
    review: 0,
    needsInput: 0,
    done: 0,
  }

  for (const task of tasks) {
    switch (task.status) {
      case 'ready':
        board.ready += 1
        break
      case 'in_progress':
        board.inProgress += 1
        break
      case 'review':
        board.review += 1
        break
      case 'needs_input':
        board.needsInput += 1
        break
      case 'done':
        board.done += 1
        break
      case 'todo':
        board.todo += 1
        break
    }
  }

  return board
}

function normalizeMobileControlCommands(commands: readonly MobileControlCommandType[]): MobileControlCommandType[] {
  const supported = new Set<MobileControlCommandType>()
  for (const command of commands) {
    if (mobileSnapshotCommandSet.has(command)) {
      supported.add(command)
    }
  }
  return [...supported]
}

async function readSwitchboardWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
  readers: Pick<DesktopWorkspaceStateReaders, 'readSwitchboardTasks' | 'getSwitchboardRunnerState'>
): Promise<MobileWorkspaceSnapshot | null> {
  const tasksResult = await readers.readSwitchboardTasks({ workspaceRoot })
  if (!tasksResult.ok) return null

  const runnerResult = await readers.getSwitchboardRunnerState(workspaceRoot).catch((): SwitchboardRunnerResult => ({
    ok: false,
    message: 'Switchboard runner state is unavailable.',
  }))
  const laneCounts = countSwitchboardLanes(tasksResult.tasks)
  const inboxCount = laneCounts.inbox ?? 0
  const activeExecutionCount = runnerResult.ok ? runnerResult.activeExecutions.length : 0
  const sortedTasks = sortSwitchboardRecords(tasksResult.tasks)
  const taskSummaries = sortedTasks
    .filter((record) => record.location.folderStatus !== 'inbox')
    .slice(0, maxWorkspaceCollectionItems)
    .map(toSwitchboardTaskSummary)
  const inboxItems = sortedTasks
    .filter((record) => record.location.folderStatus === 'inbox')
    .slice(0, maxWorkspaceCollectionItems)
    .map(toSwitchboardTaskSummary)
  const comments = sortedTasks.flatMap(toSwitchboardCommentSummaries).slice(0, maxWorkspaceCollectionItems)
  const evidence = sortedTasks.flatMap(toSwitchboardEvidenceSummary).slice(0, maxWorkspaceCollectionItems)
  const logs = [
    ...sortedTasks.flatMap(toSwitchboardLogSummaries),
    ...(runnerResult.ok ? runnerResult.activeExecutions.map(toActiveSwitchboardExecutionLogSummary) : []),
  ].slice(0, maxWorkspaceCollectionItems)
  if (tasksResult.tasks.length === 0 && tasksResult.problems.length === 0 && activeExecutionCount === 0) {
    return null
  }
  const updatedAt = latestIso([
    generatedAt,
    ...tasksResult.tasks.map((record) => record.task.updatedAt),
    ...(runnerResult.ok && runnerResult.updatedAt ? [runnerResult.updatedAt] : []),
  ])

  return {
    workspaceId: `switchboard:${workspaceRoot}`,
    kind: 'switchboard',
    name: 'Switchboard',
    workspacePath: workspaceRoot,
    statePath: tasksResult.switchboardRoot,
    updatedAt,
    capabilities: ['summary.read', 'detail.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: switchboardWorkspaceStatus(activeExecutionCount, tasksResult.problems.length),
      headline: `${inboxCount} inbox, ${activeExecutionCount} active`,
      counts: {
        ...laneCounts,
        activeExecutions: activeExecutionCount,
        problems: tasksResult.problems.length,
      },
    },
    detail: {
      kind: 'switchboard',
      data: {
        inboxCount,
        laneCounts,
        activeExecutionCount,
        tasks: taskSummaries,
        inboxItems,
        comments,
        evidence,
        logs,
      },
    },
  }
}

async function readWatchtowerWorkspaceSnapshot(
  workspaceRoot: string,
  generatedAt: string,
  readers: Pick<DesktopWorkspaceStateReaders, 'listWatchtowerRuns'>
): Promise<MobileWorkspaceSnapshot | null> {
  const runsResult = await readers.listWatchtowerRuns(workspaceRoot)
  if (!runsResult.ok || runsResult.runs.length === 0) return null

  const sortedRuns = [...runsResult.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const latestRun = sortedRuns[0]
  const activeRunCount = runsResult.runs.filter((run) => run.status === 'pending' || run.status === 'running').length
  const generatedInboxCount = runsResult.runs.reduce((count, run) => count + run.counts.ingested, 0)
  const runs = sortedRuns.slice(0, maxWorkspaceCollectionItems).map(toWatchtowerRunSummary)
  const generatedInboxItems = sortedRuns
    .flatMap((run) => run.agents.flatMap((agent) => (agent.taskIds ?? []).map((taskId): MobileWatchtowerGeneratedInboxSummary => ({
      runId: run.runId,
      taskId,
      source: 'watchtower',
    }))))
    .slice(0, maxWorkspaceCollectionItems)

  return {
    workspaceId: `watchtower:${workspaceRoot}`,
    kind: 'watchtower',
    name: 'Watchtower',
    workspacePath: workspaceRoot,
    updatedAt: latestIso([generatedAt, ...runsResult.runs.map((run) => run.completedAt ?? run.createdAt)]),
    capabilities: ['summary.read', 'detail.read'],
    detailVersion: mobileControlWorkspaceSnapshotVersion,
    summary: {
      status: watchtowerWorkspaceStatus(runsResult.runs),
      headline: `${activeRunCount} active, ${generatedInboxCount} generated inbox items`,
      counts: {
        activeRuns: activeRunCount,
        generatedInboxItems: generatedInboxCount,
        problems: runsResult.problems?.length ?? 0,
      },
    },
    detail: {
      kind: 'watchtower',
      data: {
        activeRunCount,
        latestRunStatus: latestRun.status,
        generatedInboxCount,
        runs,
        generatedInboxItems,
      },
    },
  }
}

function sortSwitchboardRecords(records: SwitchboardTaskRecord[]): SwitchboardTaskRecord[] {
  return [...records].sort((a, b) => Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt))
}

function toSwitchboardTaskSummary(record: SwitchboardTaskRecord): MobileSwitchboardTaskSummary {
  return {
    taskId: record.task.id,
    identifier: record.task.identifier,
    title: record.task.title,
    status: record.task.state,
    lane: record.location.folderStatus,
    updatedAt: record.task.updatedAt,
    source: {
      type: record.task.source.type,
      ...(record.task.source.externalId ? { externalId: record.task.source.externalId } : {}),
      ...(record.task.source.externalKey ? { externalKey: record.task.source.externalKey } : {}),
      ...(record.task.source.externalUrl ? { externalUrl: record.task.source.externalUrl } : {}),
    },
    ...(record.task.priority !== undefined ? { priority: record.task.priority } : {}),
    ...(record.task.claim?.owner ? { claimedBy: record.task.claim.owner } : {}),
  }
}

function toSwitchboardCommentSummaries(record: SwitchboardTaskRecord): MobileSwitchboardCommentSummary[] {
  return [...record.task.comments]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, maxNestedWorkspaceCollectionItems)
    .map((comment) => ({
      taskId: record.task.id,
      commentId: comment.id,
      kind: comment.kind,
      body: comment.body,
      createdAt: comment.createdAt,
      ...(comment.author.name !== undefined ? { authorName: comment.author.name } : {}),
      ...(comment.confidencePct !== undefined ? { confidencePct: comment.confidencePct } : {}),
    }))
}

function toSwitchboardEvidenceSummary(record: SwitchboardTaskRecord): MobileSwitchboardEvidenceSummary[] {
  const evidence = record.task.evidence
  if (
    !evidence.summary
    && evidence.artifacts.length === 0
    && evidence.commandsRun.length === 0
    && evidence.touchedFiles.length === 0
  ) {
    return []
  }
  return [{
    taskId: record.task.id,
    ...(evidence.summary ? { summary: evidence.summary } : {}),
    artifactCount: evidence.artifacts.length,
    commandCount: evidence.commandsRun.length,
    touchedFileCount: evidence.touchedFiles.length,
    updatedAt: record.task.updatedAt,
  }]
}

function toSwitchboardLogSummaries(record: SwitchboardTaskRecord): MobileSwitchboardLogSummary[] {
  return [...record.task.execution.attempts]
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, maxNestedWorkspaceCollectionItems)
    .map((attempt) => ({
      taskId: record.task.id,
      executionId: attempt.id,
      agentId: attempt.agentId ?? null,
      status: attempt.completedAt ? 'completed' : 'running',
      startedAt: attempt.startedAt,
      completedAt: attempt.completedAt ?? null,
      summary: attempt.summary ?? null,
    }))
}

function toActiveSwitchboardExecutionLogSummary(execution: SwitchboardRunnerExecution): MobileSwitchboardLogSummary {
  return {
    ...(execution.kind === 'switchboard_task' ? { taskId: execution.taskId } : {}),
    executionId: execution.executionId,
    status: execution.status ?? 'active',
    agentId: execution.role,
    startedAt: execution.startedAt,
    summary: execution.kind,
  }
}

function toWatchtowerRunSummary(run: WatchtowerRun): MobileWatchtowerRunSummary {
  return {
    runId: run.runId,
    status: run.status,
    preset: run.preset,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    validCount: run.counts.valid,
    invalidCount: run.counts.invalid,
    generatedInboxCount: run.counts.ingested,
    agentCount: run.agents.length,
  }
}

function countSwitchboardLanes(records: SwitchboardTaskRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    const lane = record.location.folderStatus
    counts[lane] = (counts[lane] ?? 0) + 1
  }
  return counts
}

function switchboardWorkspaceStatus(activeExecutionCount: number, problemCount: number): MobileWorkspaceStatus {
  if (problemCount > 0) return 'error'
  if (activeExecutionCount > 0) return 'running'
  return 'idle'
}

function watchtowerWorkspaceStatus(runs: WatchtowerRun[]): MobileWorkspaceStatus {
  if (runs.some((run) => run.status === 'failed')) return 'error'
  if (runs.some((run) => run.status === 'running' || run.status === 'pending')) return 'running'
  if (runs.length > 0) return 'complete'
  return 'idle'
}

function normalizeNeedsInput(value: unknown): NormalizedTask['needsInput'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  // kind is narrowed to the protocol's needs-input vocabulary so the emitted
  // snapshot passes validateMobileControlSnapshot (which rejects unknown kinds);
  // an unrecognized raw kind is dropped rather than passed through.
  const normalized: MobileControlTaskNeedsInput = {
    kind: normalizeNeedsInputKind(record.kind),
    reason: stringOrNull(record.reason) ?? undefined,
    question: stringOrNull(record.question) ?? undefined,
    suggestedResolution: stringOrNull(record.suggestedResolution) ?? undefined,
    artifactId: stringOrNull(record.artifactId) ?? undefined,
  }
  return Object.values(normalized).some(Boolean) ? normalized : undefined
}

function normalizeNeedsInputKind(value: unknown): MobileControlNeedsInputKind | undefined {
  return value === 'architect' || value === 'user' || value === 'owner' || value === 'external_validation'
    ? value
    : undefined
}

function normalizeEvidence(value: unknown): NormalizedTask['evidence'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const summary = stringOrNull(record.summary) ?? undefined
  const touchedFileCount = arrayLength(record.touchedFiles)
  const commandCount = arrayLength(record.commandsRan)
  const resultCount = arrayLength(record.results)
  if (!summary && touchedFileCount === 0 && commandCount === 0 && resultCount === 0) return undefined
  return { summary, touchedFileCount, commandCount, resultCount }
}

function normalizeTaskFeedback(value: unknown): NormalizedTask['feedback'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const confidencePct = numberOrUndefined(record.confidencePct)
  const hallucinationRiskPct = numberOrUndefined(record.hallucinationRiskPct)
  return confidencePct === undefined && hallucinationRiskPct === undefined
    ? undefined
    : { confidencePct, hallucinationRiskPct }
}

function normalizeReviewSignals(record: Record<string, unknown>): NormalizedTask['reviewSignals'] | undefined {
  const findings = arrayLength(record.findings)
  const issues = arrayLength(record.issues)
  const verdict = stringOrNull(record.verdict) ?? stringOrNull(record.reviewVerdict) ?? undefined
  if (findings === 0 && issues === 0 && !verdict) return undefined
  return { findingCount: findings, issueCount: issues, verdict }
}

function normalizeRelease(value: unknown): NormalizedTask['release'] | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const release = {
    requestedBy: stringOrNull(record.requestedBy) ?? stringOrNull(record.actor) ?? undefined,
    reason: stringOrNull(record.reason) ?? undefined,
  }
  return Object.values(release).some(Boolean) ? release : undefined
}

// The wire `roster` map ({[id]:{role,status,currentTaskId}}, MC-1594) is derived
// from the projection's canonical workers view (`projection.workers` — active
// leases + live sessions, MC-1591). The workers record is a superset carrying
// the same runtime-agent fields, so this same parser reads it and keeps only the
// three the v2 phone renders. Idle seats never appear (there are none under
// pooling), which is truthful; a v2 phone keeps rendering the same shape.
function normalizeRoster(value: unknown): MobileSprintEngineSnapshot['roster'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const roster: NonNullable<MobileSprintEngineSnapshot['roster']> = {}
  for (const [agentId, rawAgent] of Object.entries(value)) {
    const agent = recordObject(rawAgent)
    if (!agent) continue
    roster[agentId] = {
      role: stringOrNull(agent.role) ?? undefined,
      status: stringOrNull(agent.status) ?? undefined,
      currentTaskId: stringOrNull(agent.currentTaskId),
    }
  }
  return Object.keys(roster).length > 0 ? roster : undefined
}

function recordSummary(value: unknown): Record<string, string | number | boolean | null> | undefined {
  const record = recordObject(value)
  if (!record) return undefined
  const summary: Record<string, string | number | boolean | null> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean' || entry === null) {
      summary[key] = entry
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined
}

function normalizeTaskStatus(value: unknown): SprintEngineTaskStatus {
  if (
    value === 'ready'
    || value === 'in_progress'
    || value === 'review'
    || value === 'needs_input'
    || value === 'done'
    || value === 'canceled'
  ) return value
  return 'todo'
}

function normalizeOptionalTaskStatus(value: unknown): SprintEngineTaskStatus | undefined {
  if (typeof value !== 'string') return undefined
  if (
    value === 'ready'
    || value === 'in_progress'
    || value === 'review'
    || value === 'needs_input'
    || value === 'done'
    || value === 'canceled'
    || value === 'todo'
  ) return value
  return undefined
}

function normalizeMobileCommentType(value: unknown): MobileTaskCommentType | undefined {
  return value === 'implementation_summary'
    || value === 'implementation_response'
    || value === 'review_feedback'
    || value === 'test_feedback'
    || value === 'product_feedback'
    || value === 'architect_feedback'
    || value === 'needs_input'
    || value === 'user_note'
    || value === 'system_note'
    ? value
    : undefined
}

function truncateBody(value: string, max = 600): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`
}

function normalizeMobileComment(raw: unknown): MobileSprintEngineCommentSummary | null {
  const record = recordObject(raw)
  if (!record) return null
  const body = stringOrNull(record.body)?.trim()
  if (!body) return null
  const id = stringOrNull(record.id) ?? `comment-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    actor: stringOrNull(record.actor) ?? stringOrNull(record.authorAgentId) ?? 'unknown',
    body: truncateBody(body),
    ...(normalizeMobileCommentType(record.type) ? { type: normalizeMobileCommentType(record.type)! } : {}),
    ...(stringOrNull(record.authorRole) ? { authorRole: stringOrNull(record.authorRole)! } : {}),
    ...(stringOrNull(record.createdAt) ? { createdAt: stringOrNull(record.createdAt)! } : {}),
  }
}

function normalizeMobileComments(value: unknown, max = 5): MobileSprintEngineCommentSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.flatMap((raw) => {
    const comment = normalizeMobileComment(raw)
    return comment ? [comment] : []
  })
  return list.length > 0 ? list.slice(0, max) : undefined
}

function normalizeMobileRecordedArtifacts(value: unknown, max = 10): MobileSprintEngineRecordedArtifactSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.flatMap((raw): MobileSprintEngineRecordedArtifactSummary[] => {
    const record = recordObject(raw)
    if (!record) return []
    const id = stringOrNull(record.id)
    if (!id) return []
    return [{
      id,
      ...(stringOrNull(record.kind) ? { kind: stringOrNull(record.kind)! } : {}),
      ...(stringOrNull(record.title) ? { title: stringOrNull(record.title)! } : {}),
      ...(stringOrNull(record.path) ? { path: stringOrNull(record.path)! } : {}),
      ...(stringOrNull(record.createdAt) ? { createdAt: stringOrNull(record.createdAt)! } : {}),
    }]
  })
  return list.length > 0 ? list.slice(0, max) : undefined
}

function normalizeArtifactStatus(value: unknown): MobileArtifactStatus | null {
  if (
    value === 'draft'
    || value === 'ready_for_review'
    || value === 'approved'
    || value === 'changes_requested'
  ) {
    return value
  }
  return null
}

function buildSnapshotVersion(value: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 24)
  return `snap_${digest}`
}

// Strips the read-time `updatedAt` before a workspace or backlog snapshot feeds
// the top-level snapshotVersion. That field falls back to `generatedAt` when the
// snapshot has no content timestamp of its own (empty and desktop workspaces
// stamp `generatedAt` unconditionally), so folding it verbatim would put per-read
// wall-clock back into the hash and stop the item-1599 fast path from ever
// matching. The content that survives is exactly what a real change perturbs.
function withoutReadTimeStamp<T extends { updatedAt: string }>(value: T): Omit<T, 'updatedAt'> {
  const { updatedAt: _updatedAt, ...rest } = value
  return rest
}

function uniqueResolved(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim()).map((path) => resolve(path)))]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function stringOrFallback(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback
}

/**
 * For a wire field that is genuinely optional: a blank or missing value becomes
 * `undefined`, which object spread omits, rather than a forged stand-in. Use this
 * wherever absence is a fact the phone must be able to read (MC-2057).
 */
function stringOrUndefined(value: unknown): string | undefined {
  return stringOrNull(value) ?? undefined
}

/**
 * The engine's `backlogRef` reduced to the wire's shape (MC-2060).
 *
 * Renamed `projectRelativePath` -> `relativePath` so a reader joins it straight to
 * `MobileControlBacklogItemSnapshot.relativePath` without a second vocabulary —
 * the same trim-and-rename the flat `vcs` block already applies (`branchName` ->
 * `branch`).
 *
 * A ref with no usable path is DROPPED rather than sent with an empty string:
 * it points at nothing the phone can open, and a present-but-empty pointer would
 * draw an affordance that dead-ends.
 */
function normalizeTaskBacklogRef(value: unknown): MobileControlTaskBacklogRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const relativePath = stringOrUndefined(record.projectRelativePath)
  if (!relativePath) return undefined
  const displayKey = stringOrUndefined(record.displayKey)
  return { relativePath, ...(displayKey ? { displayKey } : {}) }
}

function isoStringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return Number.isFinite(Date.parse(value)) ? value : null
}

function latestIso(values: Array<string | null | undefined>): string {
  const timestamps = values
    .flatMap((value) => value && Number.isFinite(Date.parse(value)) ? [value] : [])
    .sort((a, b) => Date.parse(b) - Date.parse(a))
  return timestamps[0] ?? new Date(0).toISOString()
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
