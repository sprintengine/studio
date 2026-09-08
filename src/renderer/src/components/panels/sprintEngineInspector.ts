// Sprint Engine inspector data helpers — pure formatters, tone resolvers,
// and inbox-ordering logic. Split out of SprintEngineBoardPanel.tsx so the
// orchestrator stays focused on state coordination and the inspector
// rendering carries its own data shaping in a separately testable module.
//
// What lives here:
//   - SOURCE_HANDOFF_ARTIFACT_ID — sentinel ID for the architect handover
//     artifact that always sorts to the top of the inbox.
//   - MobileArtifactDecision type + accessors (resolve approve / request-
//     changes signals from mobile actors).
//   - Artifact summary / timestamp / tone / status-label helpers.
//   - Sprint Engine inbox row tone + supporting-line resolvers.
//   - Inspector-shared types: selection, runtime-agent view, artifact &
//     task-ready action states (consumed by both orchestrator and inspector).
//   - Runtime-status and task-source/sync label formatters.
//   - Task-detail read model (item 2029): the three execution facts, the three
//     readouts (elapsed + sparkline, diff ratio, tokens) and the one merged
//     timeline the pane renders.

import type {
  SprintEngineArtifact,
  SprintEngineEvent,
  SprintEngineRoleId,
  SprintEngineTask,
  SprintEngineTaskActivityEntry,
} from '../../types/workspace'
import {
  getSprintEngineArtifactDependencyBlockers,
  sprintEngineArtifactKindLabel,
  type SprintEngineAgentRosterItem,
} from '../../utils/sprintengine'
import { formatTimestamp } from '../../utils/time'
import type { LifecycleState } from '../ui'

export { formatTimestamp }

export type RuntimeAgentView = {
  agentId: string
  label: string
  /** Absent on a roleless run's agents (MC-2057). */
  role?: SprintEngineRoleId
  status: string
  currentTaskId: string | null
}

// The in-place document preview payload built by `openArtifact` (see
// useSprintEngineBoardArtifactActions). `path` is the resolved absolute path
// used for IO (read/watch/pop-out); `relativePath` is the artifact's own
// recorded path used for display and preview-kind detection.
export type SprintEnginePreviewedArtifact = {
  id: string
  path: string
  relativePath: string
  name: string
  content: string
}

export type SprintEngineInspectorSelection =
  | { kind: 'task'; task: SprintEngineTask }
  | { kind: 'agent'; agent: SprintEngineAgentRosterItem }
  | { kind: 'artifact'; artifact: SprintEngineArtifact }
  | { kind: 'artifact-preview'; artifact: SprintEnginePreviewedArtifact }

type ArtifactActionKind = 'open' | 'approve' | 'requestChanges'

export type ArtifactActionState = {
  kind: ArtifactActionKind
  status: 'pending' | 'success' | 'error'
  /**
   * The plain sentence. On a failure this is the error card's `title` — what
   * happened, in the user's words — never a raw ENOENT/IPC string.
   */
  message: string
  /** What it means / the one next step. Failures only. */
  hint?: string
  /**
   * The raw technical string (absolute path, IPC error body). Rendered only
   * behind InlineNotice's "Show details" disclosure — never inline, per the
   * shared error-card contract InlineNotice documents.
   */
  detail?: string
}

// Per-task transient state for resolving a `needs_input` blocker from the
// inspector composer (send-and-resume / resolve-and-complete). Keyed by taskId,
// it mirrors the artifact action-state machine but carries no `kind` because a
// task input has a single resolution path.
export type TaskInputActionState = {
  status: 'pending' | 'success' | 'error'
  message: string
}

// Per-task transient state for the inspector comment composer (add a comment,
// or comment + send back for rework). Keyed by taskId; same shape as the
// needs-input action state.
export type TaskCommentActionState = {
  status: 'pending' | 'success' | 'error'
  message: string
}

export function runtimeStatusLabel(status: string): string {
  switch (status) {
    case 'needs_input':
      return 'Needs Input'
    case 'running':
      return 'Running'
    case 'planning':
      return 'Planning'
    case 'complete':
      return 'Complete'
    case 'done':
      return 'Done'
    case 'exited':
      return 'Exited'
    case 'error':
      return 'Error'
    // `retired` means the terminal is parked — "not running now, revived when
    // work returns" — so it reads as the honest "Paused" rather than "Idle"
    // (ready and waiting). A departed agent is now plain `idle` (liveness is
    // derived, not stored) and renders through the default Idle presentation.
    case 'retired':
      return 'Paused'
    default:
      return 'Idle'
  }
}

export function formatTaskSourceLabel(task: SprintEngineTask): string {
  if (!task.source) return 'Local'
  if (task.source.type === 'github') {
    return task.source.externalId ? `GitHub #${task.source.externalId}` : 'GitHub'
  }
  return task.source.type.charAt(0).toUpperCase() + task.source.type.slice(1)
}

export function formatArtifactSummary(artifacts: SprintEngineArtifact[]): string {
  const pendingCount = artifacts.filter((artifact) =>
    artifact.status !== 'approved'
    && artifact.status !== 'superseded'
    // Recorded evidence is filed, not awaiting a decision — never "pending".
    && artifact.status !== 'recorded'
  ).length
  const approvedCount = artifacts.filter((artifact) => artifact.status === 'approved').length

  if (pendingCount > 0 && approvedCount > 0) {
    return `${pendingCount} pending, ${approvedCount} approved`
  }
  if (pendingCount > 0) {
    return `${pendingCount} pending ${pendingCount === 1 ? 'artifact' : 'artifacts'}`
  }
  return `${approvedCount} approved ${approvedCount === 1 ? 'artifact' : 'artifacts'}`
}

export function artifactTimestampMs(artifact: SprintEngineArtifact): number {
  const timestamp = artifact.updatedAt ?? artifact.createdAt
  if (!timestamp) return 0
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : 0
}

export const SOURCE_HANDOFF_ARTIFACT_ID = 'source-handoff'

/**
 * Has this artifact's document actually been written?
 *
 * An artifact record and the file it names are minted at different moments: the
 * engine registers the plan/requirements approval gate at run creation, and an
 * agent registers its own artifact with `artifact.add` — both before anything is
 * on disk. `fingerprint` is the sha256 of the file at registration, so a `draft`
 * with no fingerprint is a promise of a document, not a document. Every later
 * status is written-file-backed: `artifact.ready` resolves the path with
 * `require_file=True` and re-stamps the fingerprint, so only `draft` can be empty.
 *
 * Surfaces that list a person's readable outputs use this to show documents that
 * exist rather than placeholders that error when opened.
 */
export function sprintEngineArtifactHasDocument(artifact: SprintEngineArtifact): boolean {
  if (!artifact.path.trim()) return false
  if (artifact.status !== 'draft') return true
  return Boolean(artifact.fingerprint)
}

/**
 * The artifacts of a task that are real documents, newest first. Drops the
 * not-yet-written draft placeholders (see `sprintEngineArtifactHasDocument`),
 * which is what the task detail's Artifacts section lists — the timeline keeps
 * the full set so the registration event itself is never erased.
 */
export function getSprintEngineDocumentedArtifacts(
  artifacts: SprintEngineArtifact[],
): SprintEngineArtifact[] {
  return artifacts.filter(sprintEngineArtifactHasDocument)
}

// Artifact statuses that represent a pending human decision. These are the
// only statuses the Inbox tab badge counts: a fresh sprint whose sole artifact
// is a draft plan placeholder is an expected state, not a queue demanding
// attention, so its badge reads 0.
const INBOX_ACTIONABLE_STATUSES: ReadonlySet<SprintEngineArtifact['status']> = new Set([
  'ready_for_review',
  'changes_requested',
])

function sortInboxArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  return [...artifacts].sort((a, b) => {
    const aIsHandoff = a.id === SOURCE_HANDOFF_ARTIFACT_ID
    const bIsHandoff = b.id === SOURCE_HANDOFF_ARTIFACT_ID
    if (aIsHandoff !== bIsHandoff) return aIsHandoff ? -1 : 1
    const timestampDelta = artifactTimestampMs(b) - artifactTimestampMs(a)
    if (timestampDelta !== 0) return timestampDelta
    return a.title.localeCompare(b.title)
  })
}

export function getSprintEngineInboxArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  // The Inbox list is the actionable/review queue. Two statuses are held out:
  //   - `draft` — work-in-progress (e.g. the seed plan placeholder written
  //     before the architect fills it in), reachable via the board's Read-plan
  //     action, not a review item;
  //   - `recorded` — filed evidence records, which surface in the separate
  //     read-only Evidence grouping instead (getSprintEngineEvidenceArtifacts).
  // The source handoff is always kept, whatever its status.
  return sortInboxArtifacts(
    artifacts.filter(
      (artifact) =>
        artifact.id === SOURCE_HANDOFF_ARTIFACT_ID
        || (artifact.status !== 'draft' && artifact.status !== 'recorded'),
    ),
  )
}

// Recorded evidence records, split out of the actionable queue into their own
// read-only Evidence grouping. The source handoff is never evidence — it leads
// the review queue — so it is excluded even if it ever carried a recorded status.
export function getSprintEngineEvidenceArtifacts(artifacts: SprintEngineArtifact[]): SprintEngineArtifact[] {
  return sortInboxArtifacts(
    artifacts.filter(
      (artifact) => artifact.id !== SOURCE_HANDOFF_ARTIFACT_ID && artifact.status === 'recorded',
    ),
  )
}

// Inbox tab badge count: only artifacts awaiting a human decision
// (ready_for_review + changes_requested). Approved/draft artifacts stay
// visible in the list but do not inflate the badge, so the count reflects
// outstanding review work rather than total list length.
export function getSprintEngineInboxBadgeCount(artifacts: SprintEngineArtifact[]): number {
  return getSprintEngineInboxArtifacts(artifacts).filter((artifact) =>
    INBOX_ACTIONABLE_STATUSES.has(artifact.status),
  ).length
}

export type MobileArtifactDecision = {
  action: string
  actor: string
  timestamp: string | null
  note?: string
}

export function getMobileArtifactDecision(artifact: SprintEngineArtifact): MobileArtifactDecision | null {
  const mobileHistory = [...artifact.reviewHistory]
    .reverse()
    .find((entry) => isMobileActor(entry.actor))

  if (mobileHistory) {
    return {
      action: mobileHistory.action,
      actor: mobileHistory.actor,
      timestamp: mobileHistory.timestamp,
      note: mobileHistory.note,
    }
  }

  if (artifact.approvedBy && isMobileActor(artifact.approvedBy)) {
    return {
      action: 'approved',
      actor: artifact.approvedBy,
      timestamp: artifact.approvedAt ?? null,
    }
  }

  if (artifact.changesRequestedBy && isMobileActor(artifact.changesRequestedBy)) {
    return {
      action: 'changes_requested',
      actor: artifact.changesRequestedBy,
      timestamp: artifact.changesRequestedAt ?? null,
    }
  }

  return null
}

export function formatMobileArtifactDecision(decision: MobileArtifactDecision): string {
  const parts = [
    `Mobile ${mobileActionLabel(decision.action)} by ${formatMobileActor(decision.actor)}`,
    decision.timestamp ? formatTimestamp(decision.timestamp) : null,
    decision.note,
  ].filter(Boolean)

  return parts.join(' - ')
}

function isMobileActor(actor: string): boolean {
  return actor.trim().toLowerCase().startsWith('mobile:')
}

function formatMobileActor(actor: string): string {
  return actor.replace(/^mobile:/i, '').replace(/[_-]+/g, ' ') || 'mobile device'
}

function mobileActionLabel(action: string): string {
  switch (action) {
    case 'approve':
    case 'approved':
      return 'approved'
    case 'request_changes':
    case 'requestChanges':
    case 'changes_requested':
      return 'requested changes'
    default:
      return action.replace(/[_-]+/g, ' ')
  }
}

export function formatArtifactBlockerSummary(
  blockers: ReturnType<typeof getSprintEngineArtifactDependencyBlockers>,
): string {
  const artifactCount = blockers.reduce((total, blocker) => total + blocker.artifacts.length, 0)
  const taskIds = blockers.map((blocker) => blocker.taskId).join(', ')
  return `${artifactCount} ${artifactCount === 1 ? 'artifact' : 'artifacts'} from ${taskIds}`
}

// Status idiom: the shared shape-coded LifecycleGlyph, so artifact review
// stage reads by shape and matches the board columns — not a colour-only dot. The tinted status pill
// (`artifactStatusTone`) that the artifact list rows used to draw beside this
// was the same status said twice, with the product accent spent on
// `ready_for_review`; it was removed in the 2026-09-02 audit and every surface
// resolves status to a LifecycleState here.
export function sprintEngineInboxRowLifecycle(artifact: SprintEngineArtifact): LifecycleState {
  if (artifact.id === SOURCE_HANDOFF_ARTIFACT_ID) return 'ready'
  switch (artifact.status) {
    case 'approved':
      // Manual (or legacy/absent-mode) approvals get the filled green tick;
      // policy auto-approvals get the lighter outline tick.
      return artifact.approvalMode === 'policy' ? 'approved_auto' : 'done'
    case 'ready_for_review':
      return 'review'
    case 'changes_requested':
      return 'changes_requested'
    case 'recorded':
      return 'recorded'
    case 'superseded':
      return 'archived'
    case 'draft':
      // Drafts are filtered out of the Inbox list, so this is only reached
      // defensively — render a quiet not-started ring, never the live spinner
      // the old draft→in_progress mapping produced.
      return 'todo'
  }
}

export function sprintEngineInboxRowSupporting(
  artifact: SprintEngineArtifact,
  task: SprintEngineTask | undefined,
): string {
  if (artifact.id === SOURCE_HANDOFF_ARTIFACT_ID) return 'Architect handover'
  const kind = sprintEngineArtifactKindLabel(artifact.kind)
  const parts = [kind]
  if (artifact.taskId) parts.push(artifact.taskId)
  if (task?.title) parts.push(task.title)
  return parts.join(' · ')
}

export function sprintEngineInboxEmptyMessage(runPhase: string): string {
  if (runPhase === 'Running') {
    return 'Run in flight. Artifacts will land here as agents finish tasks.'
  }
  if (runPhase === 'Complete') {
    return 'Run complete. No artifacts were produced.'
  }
  if (runPhase === 'Tasked') {
    return 'Tasks queued. Handover and artifacts will appear once agents start.'
  }
  return 'Inbox empty. The handover and any artifacts agents produce will appear here.'
}

// ──────────────────────────────────────────────────────────────────────────
// Task detail read model (item 2029)
//
// The pane reads in four groups: who and what (a pointer at the backlog item),
// where it runs (three execution facts), how it is going (three readouts), what
// happened (one timeline). Everything below is pure so the shaping is
// node-testable without a renderer — the component only lays it out.
//
// Nothing here derives a new fact. The modules are the task's own `ownedPaths`,
// the diff totals are its recorded diff evidence, the elapsed window is its
// own start/completion stamps, and the timeline is a MERGE of records that
// already exist. Tokens come from the run's token ledger via the board, and an
// unmeasured source is reported as unmeasured — never as a zero.
// ──────────────────────────────────────────────────────────────────────────

/** One owned module, named the way a human refers to it. */
export type TaskModuleLabel = {
  /** Display name — the module's own directory name, widened with parent
   *  segments only as far as it takes to tell two modules apart. */
  name: string
  /** The declared project-relative path, kept for the row's title text. */
  path: string
}

function normalizeModulePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^\.\//, '').trim()
}

/**
 * `ownedPaths` rendered as module names (item 2019 made them directories, not
 * files). `src/renderer/src/components/panels` reads as `panels`.
 *
 * Two modules whose directory names collide (`.../board/panels` and
 * `.../inspector/panels`) are widened by one parent segment at a time until
 * they differ, so the row never shows the same word twice for two different
 * places. A path with no segments at all keeps its raw value rather than
 * rendering empty.
 */
export function taskModuleLabels(ownedPaths: ReadonlyArray<string>): TaskModuleLabel[] {
  const paths: string[] = []
  for (const raw of ownedPaths) {
    const path = normalizeModulePath(String(raw ?? ''))
    if (!path || paths.includes(path)) continue
    paths.push(path)
  }
  const segmentsByPath = paths.map((path) => path.split('/').filter(Boolean))
  const depth = paths.map(() => 1)
  // Widen colliding names until every label is unique (or a path runs out of
  // segments to widen with, which only happens for genuinely identical paths —
  // already deduped above).
  for (let pass = 0; pass < 8; pass += 1) {
    const labels = paths.map((path, index) => labelAt(path, segmentsByPath[index], depth[index]))
    const collisions = new Set(labels.filter((label, index) => labels.indexOf(label) !== index))
    if (collisions.size === 0) break
    let widened = false
    labels.forEach((label, index) => {
      if (!collisions.has(label)) return
      if (depth[index] >= segmentsByPath[index].length) return
      depth[index] += 1
      widened = true
    })
    if (!widened) break
  }
  return paths.map((path, index) => ({
    name: labelAt(path, segmentsByPath[index], depth[index]),
    path,
  }))
}

function labelAt(path: string, segments: string[], depth: number): string {
  if (segments.length === 0) return path
  return segments.slice(Math.max(0, segments.length - depth)).join('/')
}

/**
 * How long the task has been in hand: from its claim to its completion, or to
 * `nowMs` while it is still open. Null when it has never started — an unstarted
 * task has no elapsed time, and rendering `0s` would claim it does.
 */
export function taskElapsedMs(
  task: Pick<SprintEngineTask, 'startedAt' | 'completedAt'>,
  nowMs: number,
): number | null {
  const started = parseTimestampMs(task.startedAt)
  if (started === null) return null
  const completed = parseTimestampMs(task.completedAt)
  const end = completed !== null && completed >= started ? completed : nowMs
  return Math.max(0, end - started)
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `1h 02m`, `12m`, `48s`, `3d 04h`. Two units at most — the readout is a glance. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${String(hours % 24).padStart(2, '0')}h`
}

/** Recorded diff evidence, summed. Null when the task has captured none. */
export type TaskDiffTotals = { additions: number; deletions: number; files: number }

export function taskDiffTotals(task: Pick<SprintEngineTask, 'evidence'>): TaskDiffTotals | null {
  const diffs = task.evidence?.diffs ?? []
  if (diffs.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const diff of diffs) {
    additions += Number.isFinite(diff.additions) ? diff.additions : 0
    deletions += Number.isFinite(diff.deletions) ? diff.deletions : 0
  }
  return { additions, deletions, files: diffs.length }
}

/** One sparkline bar: a normalized 0–1 height, and whether it holds the most
 *  recent activity (the one bar drawn in full accent). */
export type ActivitySparkBar = { height: number; recent: boolean }

/**
 * Activity over the task's own elapsed window, bucketed. Self-scaling: heights
 * are relative to the busiest bucket, so the shape reads without an axis.
 *
 * Empty when there is nothing to shape — fewer than two stamps, or a window
 * with no width. The readout then renders the elapsed figure alone rather than
 * a flat line implying measured quiet.
 */
export function taskActivitySparkline(
  timestamps: ReadonlyArray<string>,
  window: { startMs: number; endMs: number },
  bucketCount = 8,
): ActivitySparkBar[] {
  const stamps = timestamps
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => value !== null)
    .filter((value) => value >= window.startMs && value <= window.endMs)
  const span = window.endMs - window.startMs
  if (stamps.length < 2 || span <= 0 || bucketCount < 1) return []
  const counts = new Array<number>(bucketCount).fill(0)
  let lastBucket = 0
  let lastStamp = -Infinity
  for (const stamp of stamps) {
    const index = Math.min(bucketCount - 1, Math.floor(((stamp - window.startMs) / span) * bucketCount))
    counts[index] += 1
    if (stamp > lastStamp) {
      lastStamp = stamp
      lastBucket = index
    }
  }
  const max = Math.max(...counts)
  if (max <= 0) return []
  return counts.map((count, index) => ({
    // A bucket with activity never renders as nothing: floor its height so one
    // event in a quiet stretch is still visible beside a busy one.
    height: count === 0 ? 0 : Math.max(0.18, count / max),
    recent: index === lastBucket,
  }))
}

// The run-level VCS milestones a task's own work reaches. Run events, not task
// activity — the engine records them once for the run — so they are attributed
// to a task rather than duplicated onto every task.
const TASK_COMMIT_EVENT_TYPE = 'task_changes_committed'
const PULL_REQUEST_EVENT_KIND: Record<string, 'pr_opened' | 'pr_merged'> = {
  run_pull_request_opened: 'pr_opened',
  run_pull_request_merged: 'pr_merged',
}

export type TaskTimelineItem =
  | { key: string; timestamp: string; kind: 'activity'; entry: SprintEngineTaskActivityEntry }
  | {
      key: string
      timestamp: string
      kind: 'vcs'
      vcs: 'committed' | 'pr_opened' | 'pr_merged'
      event: SprintEngineEvent
    }

function eventNamesTask(event: SprintEngineEvent, taskId: string): boolean {
  if (event.taskId) return event.taskId === taskId
  if (!taskId) return false
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(event.message ?? '')
}

/**
 * The one stream the task pane renders: every activity entry the task carries,
 * merged with the run's VCS milestones that this task's work actually reached,
 * newest first.
 *
 * Comments, status changes, work notes, claims, evidence and review passes are
 * already activity entries (the engine mirrors every typed comment into the
 * activity log at write time), so the merge adds exactly one source: run
 * events. A commit event belongs to the task it names. A pull-request event
 * belongs to a task only once that task has a commit in it — an earlier commit
 * event of its own — so a PR never appears on the timeline of a task whose work
 * is not in it.
 */
export function buildTaskTimeline(
  task: Pick<SprintEngineTask, 'id' | 'activity'>,
  events: ReadonlyArray<SprintEngineEvent>,
): TaskTimelineItem[] {
  const items: TaskTimelineItem[] = (task.activity ?? []).map((entry) => ({
    key: `activity:${entry.id}`,
    timestamp: entry.timestamp ?? '',
    kind: 'activity' as const,
    entry,
  }))

  let firstCommitAt: string | null = null
  const commits: TaskTimelineItem[] = []
  for (const event of events) {
    if (event.type !== TASK_COMMIT_EVENT_TYPE) continue
    if (!eventNamesTask(event, task.id)) continue
    const timestamp = event.timestamp ?? ''
    commits.push({ key: `event:${event.id}`, timestamp, kind: 'vcs' as const, vcs: 'committed' as const, event })
    // Only a real stamp can anchor the pull-request window. An undated commit
    // event would make `>= ''` true for every pull request in the run and pull
    // them all onto this task.
    if (timestamp && (firstCommitAt === null || timestamp < firstCommitAt)) firstCommitAt = timestamp
  }
  items.push(...commits)

  for (const event of events) {
    const vcs = PULL_REQUEST_EVENT_KIND[event.type]
    if (!vcs) continue
    const explicit = Boolean(event.taskId) && event.taskId === task.id
    const timestamp = event.timestamp ?? ''
    const carriesThisTask =
      explicit || (firstCommitAt !== null && timestamp !== '' && timestamp >= firstCommitAt)
    if (!carriesThisTask) continue
    items.push({ key: `event:${event.id}`, timestamp: event.timestamp ?? '', kind: 'vcs', vcs, event })
  }

  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
}

// Every entry kind reads by SHAPE (the shared LifecycleGlyph), never by a tone
// dot: a comment is the lightest dashed ring, a claim the ready ring, a status
// change the gauge its own status maps to, filed evidence the document mark, a
// review pass the half-filled gauge, and a commit or PR the branch fork.
const TIMELINE_STATUS_LIFECYCLE: Record<string, LifecycleState> = {
  todo: 'todo',
  ready: 'ready',
  in_progress: 'in_progress',
  review: 'review',
  testing: 'testing',
  product: 'product',
  changes_requested: 'changes_requested',
  needs_input: 'needs_input',
  done: 'done',
  canceled: 'archived',
}

export function timelineItemLifecycle(item: TaskTimelineItem): LifecycleState {
  if (item.kind === 'vcs') {
    return item.vcs === 'pr_merged' ? 'done_merged' : 'done_unmerged'
  }
  const entry = item.entry
  switch (entry.type) {
    case 'comment':
      return 'idea'
    case 'claim':
      return 'ready'
    case 'evidence':
      return 'recorded'
    case 'feedback':
      // A completed review pass: the outline ring + tick. Deliberately NOT the
      // half gauge — that is the state a task is IN once it publishes for
      // review, and the two land next to each other on every publish. The tick
      // says a pass was made and recorded; what it found renders as Open
      // findings and inside the entry, in its own warn treatment.
      return 'approved_auto'
    case 'needs_input':
      return 'needs_input'
    case 'artifact':
      if (entry.artifactStatus === 'approved') return 'done'
      if (entry.artifactStatus === 'changes_requested') return 'changes_requested'
      if (entry.artifactStatus === 'ready_for_review') return 'review'
      return 'recorded'
    case 'status_change':
      return TIMELINE_STATUS_LIFECYCLE[entry.status ?? ''] ?? 'todo'
    case 'system':
    default:
      return 'todo'
  }
}
