import type { AgentPhaseEvent } from '../../shared/agent-runtime'
import type { AgentLaunchRequest } from '../../shared/agent-launch'
import type { TerminalSessionSnapshot } from '../../shared/ipc/terminal'
import { bracketedTerminalPaste } from '../../shared/terminal-paste'
import { relocateAnchor, resolveTourSteps, type TourFileSnapshot } from '../../shared/tours/tour-anchor'
import { tourAskSeed, tourAskText } from '../../shared/tours/tour-ask'
import {
  duplicateIdErrors,
  TOUR_APPEND,
  TOUR_MAX_STEPS,
  type TourCreateInput,
  type TourUpdateInput,
} from '../../shared/tours/tour-input'
import {
  TOUR_SCHEMA_VERSION,
  type LiveTour,
  type LiveTourStep,
  type Tour,
  type TourAsk,
  type TourAuthor,
  type TourChangedEvent,
  type TourGotoAnswer,
  type TourGotoRequest,
  type TourPlayback,
  type TourResult,
  type TourRevealRequest,
  type TourRevisions,
  type TourStep,
  type TourStepInput,
  type TourSummary,
} from '../../shared/tours/tour-types'
import { deferredPromptSubmitDelayMs, sanitizeTypedPrompt } from '../deferred-prompt-delivery'
import type { TourChangedFile } from './tour-git'
import type { TourStore } from './tour-store'

// The diff-tour service: the one owner of every tour, whoever is touching it.
//
// An agent writes a tour through the gateway (`tour.*`); the owner plays it in
// the Diff viewer, which reads it and reports back what it is showing; an
// owner's question goes to the author's terminal. All three meet here, so the
// rules each of them depends on live in one place:
//
// - **Nothing is accepted half-resolved.** Every anchor is resolved against
//   the files before a tour exists; a tour with one bad step is refused with
//   the complete list of what is wrong.
// - **Nothing takes focus.** Creating a tour docks a Diff tab without selecting
//   it and, when no window of the app is focused, raises ONE ordinary attention
//   event. Nothing plays until the owner presses Start, and `tour.goto` moves
//   the owner's view only when they turned Follow on.
// - **A question waits for its agent.** It is typed in when the author has
//   finished its turn, never into a CLI that is mid-turn or sitting on a
//   permission prompt, where an Enter could answer something else.

/** How long a docking window has to say it took the tab. */
const REVEAL_WAIT_MS = 1_500
/** How long a viewer has to answer a `tour.goto`. */
const GOTO_WAIT_MS = 800
/** Asks kept per tour: enough to show the recent thread, not a transcript. */
const MAX_ASKS = 30

export const TOUR_CHANNELS = {
  changed: 'tours:changed',
  revealRequest: 'tours:reveal-request',
  gotoRequest: 'tours:goto-request',
} as const

export type TourGitPort = {
  resolveRepoRoot(cwd: string): Promise<string | null>
  resolveCommit(repoRoot: string, rev: string): Promise<string | null>
  resolveHead(repoRoot: string): Promise<string>
  listTourFiles(
    repoRoot: string,
    revisions: TourRevisions,
  ): Promise<{ ok: true; files: TourChangedFile[] } | { ok: false; message: string }>
  readTourFile(repoRoot: string, revisions: TourRevisions, file: TourChangedFile): Promise<TourFileSnapshot>
}

export type TourServiceDeps = {
  store: TourStore
  git: TourGitPort
  now(): number
  newId(): string
  /** The workspace's folder, from the registry. */
  resolveWorkspaceRoot(workspaceId: string): string | null
  /** The agent's own checkout (a worktree agent reads a different tree from its workspace). */
  resolveAgentCheckout(agentId: string): string | null
  /** The repo-relative paths the agent's changelist owns in `repoRoot`, or null when it has none. */
  readChangelistPaths(repoRoot: string, agentId: string): Promise<string[] | null>
  /** Workspace windows only: where a Diff tab can be docked. */
  broadcastToWorkspaceWindows(channel: string, payload: unknown): void
  /** Every window that can show a diff: workspace windows and the diff window. */
  broadcastToViewers(channel: string, payload: unknown): void
  /** Whether any window of the app has focus right now. */
  isAppFocused(): boolean
  /** One ordinary attention event (flash / bounce / badge) — never focus. */
  requestAttention(key: string): void
  listTerminals(): TerminalSessionSnapshot[]
  writeTerminal(sessionId: string, data: string): void
  launchAgent?(request: AgentLaunchRequest): Promise<{ ok: true; agentId: string } | { ok: false; message: string }>
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type TourCaller = {
  workspaceId: string
  agentId?: string
  agentName?: string
  cliId?: string
}

export type TourCreateOutcome =
  { ok: true; tour: Tour; revealed: boolean } | { ok: false; code: string; errors: string[] }

export type TourStatus = {
  tourId: string
  title: string
  state: 'ready' | 'playing' | 'closed'
  current: string | null
  index: number | null
  of: number
  visited: string[]
  moved: string[]
  gone: string[]
  follow: boolean
  asks: Array<Pick<TourAsk, 'id' | 'stepId' | 'state' | 'text'>>
}

type Pending<T> = { settle: (value: T) => void; timer: unknown }

export type TourService = ReturnType<typeof createTourService>

export function createTourService(deps: TourServiceDeps) {
  const tours = new Map<string, Tour>()
  const revealWaiters = new Map<string, Pending<boolean>>()
  const gotoWaiters = new Map<string, { answers: TourGotoAnswer[]; settle: (answer: TourGotoAnswer | null) => void }>()

  function changed(tour: Tour): void {
    const event: TourChangedEvent = { workspaceId: tour.workspaceId, tourId: tour.id }
    deps.broadcastToViewers(TOUR_CHANNELS.changed, event)
  }

  async function persist(tour: Tour): Promise<void> {
    tour.updatedAt = deps.now()
    tours.set(tour.id, tour)
    await deps.store.save(tour)
    changed(tour)
  }

  async function find(workspaceId: string, tourId: string): Promise<Tour | null> {
    const cached = tours.get(tourId)
    if (cached) return cached.workspaceId === workspaceId ? cached : null
    const loaded = await deps.store.load(workspaceId, tourId)
    if (!loaded) return null
    // Questions still waiting from before a restart: their agent is gone, or
    // no longer the process we were waiting on. Settled, not left spinning.
    for (const entry of loaded.asks) {
      if (entry.state === 'queued' || entry.state === 'sent') {
        entry.state = 'failed'
        entry.error = 'The app restarted before this was answered.'
      }
    }
    tours.set(loaded.id, loaded)
    return loaded
  }

  // ── Reading the changes ────────────────────────────────────────────────

  async function repoFor(caller: TourCaller): Promise<string | null> {
    const checkout = caller.agentId ? deps.resolveAgentCheckout(caller.agentId) : null
    const start = checkout ?? deps.resolveWorkspaceRoot(caller.workspaceId)
    if (!start) return null
    return deps.git.resolveRepoRoot(start)
  }

  /** The files the tour covers, narrowed to a changelist when that is what it is about. */
  async function filesOf(
    tour: Pick<Tour, 'repoRoot' | 'revisions' | 'changes' | 'author'>,
  ): Promise<{ ok: true; files: TourChangedFile[] } | { ok: false; message: string }> {
    const listed = await deps.git.listTourFiles(tour.repoRoot, tour.revisions)
    if (!listed.ok) return listed
    if (tour.changes.kind !== 'changelist') return listed
    const agentId = tour.author.agentId
    if (!agentId) return { ok: true, files: [] }
    const owned = new Set(await deps.readChangelistPaths(tour.repoRoot, agentId))
    return { ok: true, files: listed.files.filter((file) => owned.has(file.path) || owned.has(file.oldPath ?? '')) }
  }

  async function snapshotsFor(
    tour: Pick<Tour, 'repoRoot' | 'revisions'>,
    files: TourChangedFile[],
    paths: Set<string>,
  ): Promise<TourFileSnapshot[]> {
    const wanted = files.filter((file) => paths.has(file.path))
    const read = await Promise.all(wanted.map((file) => deps.git.readTourFile(tour.repoRoot, tour.revisions, file)))
    // Files no step names still count for the "changed files" list in an error,
    // as bare entries: their content is never read.
    const stubs = files
      .filter((file) => !paths.has(file.path))
      .map<TourFileSnapshot>((file) => ({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        unreadable: null,
        oldText: null,
        newText: null,
        hunks: [],
      }))
    return [...read, ...stubs]
  }

  async function resolveSteps(
    tour: Pick<Tour, 'repoRoot' | 'revisions' | 'changes' | 'author'>,
    inputs: TourStepInput[],
  ): Promise<{ ok: true; steps: TourStep[] } | { ok: false; code: string; errors: string[] }> {
    const files = await filesOf(tour)
    if (!files.ok) return { ok: false, code: 'git_failed', errors: [files.message] }
    if (files.files.length === 0) {
      const errors =
        tour.changes.kind === 'changelist'
          ? [
              tour.author.agentId
                ? 'Your changelist has no uncommitted files. Use changes {kind: "worktree"} for everything uncommitted, or {kind: "range", base, head} for commits.'
                : 'A changelist tour needs the calling agent; this connection names none. Use changes {kind: "worktree"} or a range.',
            ]
          : ['There are no changes to walk through here.']
      return { ok: false, code: 'no_changes', errors }
    }
    const snapshots = await snapshotsFor(tour, files.files, new Set(inputs.map((step) => step.path)))
    const resolved = resolveTourSteps(inputs, snapshots)
    return resolved.ok ? resolved : { ok: false, code: 'invalid_steps', errors: resolved.errors }
  }

  // ── The gateway's verbs ────────────────────────────────────────────────

  /**
   * `priorErrors` are the shape problems the caller already found; the steps
   * that passed the shape check are still resolved, so one refusal lists
   * everything wrong with the tour.
   */
  async function create(
    input: TourCreateInput,
    caller: TourCaller,
    priorErrors: readonly string[] = [],
  ): Promise<TourCreateOutcome> {
    const repoRoot = await repoFor(caller)
    if (!repoRoot) {
      return { ok: false, code: 'not_a_repository', errors: ['This workspace is not a git repository.'] }
    }
    const author: TourAuthor = {
      agentId: caller.agentId ?? null,
      agentName: caller.agentName ?? null,
      cliId: caller.cliId ?? null,
    }
    let revisions: TourRevisions
    if (input.changes.kind === 'range') {
      const [base, head] = await Promise.all([
        deps.git.resolveCommit(repoRoot, input.changes.base),
        deps.git.resolveCommit(repoRoot, input.changes.head),
      ])
      const errors: string[] = []
      if (!base) errors.push(`changes.base: "${input.changes.base}" is not a commit in this repository.`)
      if (!head) errors.push(`changes.head: "${input.changes.head}" is not a commit in this repository.`)
      if (!base || !head) return { ok: false, code: 'unknown_revision', errors: [...priorErrors, ...errors] }
      revisions = { base, head }
    } else {
      revisions = { base: await deps.git.resolveHead(repoRoot), head: 'worktree' }
    }
    const changes =
      input.changes.kind === 'range'
        ? { kind: 'range' as const, base: revisions.base, head: revisions.head as string }
        : input.changes

    const resolved = await resolveSteps({ repoRoot, revisions, changes, author }, input.steps)
    if (!resolved.ok) return { ...resolved, errors: [...priorErrors, ...resolved.errors] }
    if (priorErrors.length > 0) return { ok: false, code: 'invalid_tour', errors: [...priorErrors] }

    const now = deps.now()
    const tour: Tour = {
      schemaVersion: TOUR_SCHEMA_VERSION,
      id: deps.newId(),
      workspaceId: caller.workspaceId,
      repoRoot,
      title: input.title,
      ...(input.overview ? { overview: input.overview } : {}),
      changes,
      revisions,
      author,
      createdAt: now,
      updatedAt: now,
      closed: false,
      steps: resolved.steps,
      playback: { started: false, currentStepId: null, visited: [], follow: false },
      pointer: null,
      asks: [],
    }
    await persist(tour)
    const revealed = await reveal(tour)
    // One ordinary attention event, and only when nobody is looking. A focused
    // window already shows the tab's "tour ready" dot.
    if (!deps.isAppFocused()) deps.requestAttention(`tour:${tour.id}`)
    return { ok: true, tour, revealed }
  }

  function reveal(tour: Tour): Promise<boolean> {
    const requestId = deps.newId()
    return new Promise<boolean>((resolve) => {
      const timer = deps.setTimeout(() => {
        revealWaiters.delete(requestId)
        resolve(false)
      }, REVEAL_WAIT_MS)
      revealWaiters.set(requestId, {
        timer,
        settle: (value) => {
          deps.clearTimeout(timer)
          revealWaiters.delete(requestId)
          resolve(value)
        },
      })
      const request: TourRevealRequest = {
        requestId,
        workspaceId: tour.workspaceId,
        tourId: tour.id,
        repoRoot: tour.repoRoot,
      }
      deps.broadcastToWorkspaceWindows(TOUR_CHANNELS.revealRequest, request)
    })
  }

  function acknowledgeReveal(requestId: string): void {
    revealWaiters.get(requestId)?.settle(true)
  }

  /**
   * A tour is changed only by the agent that wrote it (or the one a question
   * was handed to). A connection naming no agent — a person's own script on
   * the socket — is not refused: there is no author to impersonate.
   */
  function notAuthor(tour: Tour, callerAgentId: string | undefined): string | null {
    if (!callerAgentId || !tour.author.agentId || callerAgentId === tour.author.agentId) return null
    return 'Only the agent that wrote this tour can change it or point at its steps.'
  }

  async function update(
    input: TourUpdateInput,
    caller: TourCaller,
  ): Promise<{ ok: true; tour: Tour } | { ok: false; code: string; errors: string[] }> {
    const tour = await find(caller.workspaceId, input.tourId)
    if (!tour) return { ok: false, code: 'not_found', errors: [`No tour "${input.tourId}" in this workspace.`] }
    if (tour.closed) return { ok: false, code: 'closed', errors: ['That tour was closed; create a new one.'] }
    const refusal = notAuthor(tour, caller.agentId)
    if (refusal) return { ok: false, code: 'forbidden', errors: [refusal] }

    const errors: string[] = []
    let steps = [...tour.steps]
    const ids = (): string[] => steps.map((step) => step.id)
    for (const id of input.remove ?? []) {
      if (!ids().includes(id)) errors.push(`remove: no step "${id}".`)
    }
    steps = steps.filter((step) => !(input.remove ?? []).includes(step.id))
    for (const replacement of input.replace ?? []) {
      if (!ids().includes(replacement.id)) errors.push(`replace: no step "${replacement.id}" to replace.`)
    }
    const after = input.insertAfter?.after
    if (after && after !== TOUR_APPEND && !ids().includes(after)) errors.push(`insertAfter.after: no step "${after}".`)

    const incoming = [...(input.replace ?? []), ...(input.insertAfter?.steps ?? [])]
    const finalIds = [
      ...ids().filter((id) => !(input.replace ?? []).some((step) => step.id === id)),
      ...incoming.map((step) => step.id),
    ]
    errors.push(...duplicateIdErrors(finalIds))
    if (finalIds.length > TOUR_MAX_STEPS) errors.push(`A tour holds at most ${TOUR_MAX_STEPS} steps.`)
    if (finalIds.length === 0) errors.push('That would leave the tour with no steps; close it instead.')

    let resolvedById = new Map<string, TourStep>()
    if (incoming.length > 0) {
      const resolved = await resolveSteps(tour, incoming)
      if (!resolved.ok) errors.push(...resolved.errors)
      else resolvedById = new Map(resolved.steps.map((step) => [step.id, step]))
    }
    if (errors.length > 0) return { ok: false, code: 'invalid_update', errors }

    steps = steps.map((step) => resolvedById.get(step.id) ?? step)
    if (input.insertAfter) {
      const inserted = input.insertAfter.steps.map((step) => resolvedById.get(step.id)!)
      const at =
        after === null ? 0 : after === TOUR_APPEND || after === undefined ? steps.length : ids().indexOf(after) + 1
      steps.splice(at, 0, ...inserted)
    }
    tour.steps = steps
    if (input.title) tour.title = input.title
    if (input.overview !== undefined) tour.overview = input.overview
    const kept = new Set(ids())
    tour.playback.visited = tour.playback.visited.filter((id) => kept.has(id))
    if (tour.playback.currentStepId && !kept.has(tour.playback.currentStepId)) tour.playback.currentStepId = null
    if (tour.pointer && !kept.has(tour.pointer.stepId)) tour.pointer = null
    await persist(tour)
    return { ok: true, tour }
  }

  async function goto(
    workspaceId: string,
    tourId: string,
    stepId: string,
    callerAgentId?: string,
  ): Promise<{ ok: true; moved: boolean; reason: string } | { ok: false; code: string; message: string }> {
    const tour = await find(workspaceId, tourId)
    if (!tour) return { ok: false, code: 'not_found', message: `No tour "${tourId}" in this workspace.` }
    if (tour.closed) return { ok: false, code: 'closed', message: 'That tour was closed.' }
    const refusal = notAuthor(tour, callerAgentId)
    if (refusal) return { ok: false, code: 'forbidden', message: refusal }
    if (!tour.steps.some((step) => step.id === stepId)) {
      return {
        ok: false,
        code: 'unknown_step',
        message: `No step "${stepId}". Steps: ${tour.steps.map((s) => s.id).join(', ')}.`,
      }
    }
    tour.pointer = { stepId, at: deps.now() }
    await persist(tour)
    const requestId = deps.newId()
    const answer = await new Promise<TourGotoAnswer | null>((resolve) => {
      const entry = {
        answers: [] as TourGotoAnswer[],
        settle: (value: TourGotoAnswer | null) => {
          gotoWaiters.delete(requestId)
          resolve(value)
        },
      }
      gotoWaiters.set(requestId, entry)
      deps.setTimeout(() => {
        if (gotoWaiters.get(requestId) === entry) entry.settle(entry.answers[0] ?? null)
      }, GOTO_WAIT_MS)
      const request: TourGotoRequest = { requestId, workspaceId, tourId, stepId }
      deps.broadcastToViewers(TOUR_CHANNELS.gotoRequest, request)
    })
    if (!answer) return { ok: true, moved: false, reason: 'no_viewer' }
    return { ok: true, moved: answer.moved, reason: answer.reason }
  }

  function answerGoto(answer: TourGotoAnswer): void {
    const entry = gotoWaiters.get(answer.requestId)
    if (!entry) return
    // A viewer that moved is the answer; one that did not is kept in case no
    // other viewer does better before the wait ends.
    if (answer.moved) entry.settle(answer)
    else entry.answers.push(answer)
  }

  async function status(
    workspaceId: string,
    tourId: string,
  ): Promise<{ ok: true; status: TourStatus } | { ok: false; code: string; message: string }> {
    const live = await read(workspaceId, tourId)
    if (!live.ok) return { ok: false, code: 'not_found', message: live.message }
    return { ok: true, status: statusOf(live.value) }
  }

  async function close(workspaceId: string, tourId: string, callerAgentId?: string): Promise<TourResult<Tour>> {
    const tour = await find(workspaceId, tourId)
    if (!tour) return { ok: false, message: `No tour "${tourId}" in this workspace.` }
    const refusal = notAuthor(tour, callerAgentId)
    if (refusal) return { ok: false, message: refusal }
    if (!tour.closed) {
      tour.closed = true
      for (const ask of tour.asks) if (ask.state === 'queued') ask.state = 'cancelled'
      await persist(tour)
    }
    return { ok: true, value: tour }
  }

  // ── The viewer's side ──────────────────────────────────────────────────

  /**
   * The tour with every step placed on the files as they are now. A committed
   * range cannot move, so its steps are placed where they were written; a
   * working-tree tour re-reads each named file and re-finds its lines.
   */
  async function read(workspaceId: string, tourId: string): Promise<TourResult<LiveTour>> {
    const tour = await find(workspaceId, tourId)
    if (!tour) return { ok: false, message: `No tour "${tourId}" in this workspace.` }
    if (tour.revisions.head !== 'worktree') {
      return {
        ok: true,
        value: {
          ...tour,
          steps: tour.steps.map((step) => ({
            ...step,
            status: 'ok',
            startLine: step.anchor.startLine,
            endLine: step.anchor.endLine,
          })),
        },
      }
    }
    const files = await filesOf(tour)
    const listed = files.ok ? files.files : []
    const byPath = new Map(listed.map((file) => [file.path, file]))
    const paths = new Set(tour.steps.map((step) => step.anchor.path).filter((path) => byPath.has(path)))
    const snapshots = await Promise.all(
      [...paths].map((path) => deps.git.readTourFile(tour.repoRoot, tour.revisions, byPath.get(path)!)),
    )
    const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.path, snapshot]))
    const steps: LiveTourStep[] = tour.steps.map((step) => {
      const placed = relocateAnchor(step.anchor, snapshotByPath.get(step.anchor.path) ?? null)
      return {
        ...step,
        // A file that is still in the diff but changed status (a new file now
        // deleted) is the viewer's to draw from the live snapshot.
        fileStatus: snapshotByPath.get(step.anchor.path)?.status ?? step.fileStatus,
        status: placed.status,
        startLine: placed.startLine,
        endLine: placed.endLine,
      }
    })
    return { ok: true, value: { ...tour, steps } }
  }

  async function list(workspaceId: string): Promise<TourSummary[]> {
    const stored = await deps.store.list(workspaceId)
    return stored.map((tour) => {
      const current = tours.get(tour.id) ?? tour
      return {
        id: current.id,
        title: current.title,
        stepCount: current.steps.length,
        authorName: current.author.agentName,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        started: current.playback.started,
        closed: current.closed,
      }
    })
  }

  async function reportPlayback(workspaceId: string, tourId: string, playback: TourPlayback): Promise<void> {
    const tour = await find(workspaceId, tourId)
    if (!tour) return
    const ids = new Set(tour.steps.map((step) => step.id))
    const next: TourPlayback = {
      started: playback.started || tour.playback.started,
      currentStepId: playback.currentStepId && ids.has(playback.currentStepId) ? playback.currentStepId : null,
      visited: [...new Set([...tour.playback.visited, ...playback.visited])].filter((id) => ids.has(id)),
      follow: playback.follow,
    }
    if (JSON.stringify(next) === JSON.stringify(tour.playback)) return
    tour.playback = next
    await persist(tour)
  }

  // ── Talking back ───────────────────────────────────────────────────────

  function authorSession(tour: Tour): TerminalSessionSnapshot | null {
    const agentId = tour.author.agentId
    if (!agentId) return null
    return (
      deps
        .listTerminals()
        .find((session) => session.kind === 'agent' && session.agentId === agentId && session.processAlive) ?? null
    )
  }

  /**
   * Whether the author is sitting at its prompt. `idle` is a finished turn —
   * the composer is waiting for the next message. `awaiting_input` is NOT:
   * it is a permission or a question the CLI is blocked on, and an Enter typed
   * there answers it. A CLI with no lifecycle hooks is read from its output
   * activity instead.
   */
  function isReady(session: TerminalSessionSnapshot): boolean {
    const phase = session.agentState?.phase
    if (phase) return phase === 'idle'
    return session.activity.kind === 'idle'
  }

  /**
   * Whether a question to this agent is already typed in and being answered,
   * in ANY of its tours. One at a time per agent: the phase the snapshot
   * carries is only refreshed by the next hook event, so a second question
   * sent on the strength of the same `idle` would land mid-turn.
   */
  function hasSentAsk(agentId: string): boolean {
    for (const tour of tours.values()) {
      if (tour.author.agentId === agentId && tour.asks.some((entry) => entry.state === 'sent')) return true
    }
    return false
  }

  function send(session: TerminalSessionSnapshot, text: string): void {
    // The owner's text, typed into a terminal: no escape sequence survives it,
    // so nothing in the question can end the bracketed paste early.
    const clean = sanitizeTypedPrompt(text.replace(/\x1b/g, ''))
    deps.writeTerminal(session.sessionId, bracketedTerminalPaste(clean))
    // The Enter is its own write: inside the bracketed block it would be text.
    deps.setTimeout(() => deps.writeTerminal(session.sessionId, '\r'), deferredPromptSubmitDelayMs(clean))
  }

  async function ask(
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ): Promise<TourResult<TourAsk> & { authorGone?: boolean }> {
    const live = await read(workspaceId, tourId)
    if (!live.ok) return live
    const tour = tours.get(tourId)!
    const index = live.value.steps.findIndex((step) => step.id === stepId)
    if (index < 0 || !question.trim()) return { ok: false, message: 'Nothing to ask.' }
    const session = authorSession(tour)
    if (!session)
      return { ok: false, message: 'The agent that wrote this tour is no longer running.', authorGone: true }
    const text = tourAskText({ tour, step: live.value.steps[index], index, of: live.value.steps.length, question })
    const entry: TourAsk = { id: deps.newId(), stepId, text, state: 'queued', at: deps.now() }
    if (isReady(session) && !hasSentAsk(session.agentId ?? '')) {
      send(session, text)
      entry.state = 'sent'
    }
    tour.asks = [...tour.asks, entry].slice(-MAX_ASKS)
    await persist(tour)
    return { ok: true, value: entry }
  }

  async function cancelAsk(workspaceId: string, tourId: string, askId: string): Promise<void> {
    const tour = await find(workspaceId, tourId)
    const entry = tour?.asks.find((candidate) => candidate.id === askId)
    if (!tour || !entry || entry.state !== 'queued') return
    entry.state = 'cancelled'
    await persist(tour)
  }

  /** For a tour whose author has gone: a new agent, told where to look. */
  async function askNewAgent(
    workspaceId: string,
    tourId: string,
    stepId: string,
    question: string,
  ): Promise<TourResult<{ agentId: string }>> {
    if (!deps.launchAgent) return { ok: false, message: 'Agents cannot be launched from here.' }
    const live = await read(workspaceId, tourId)
    if (!live.ok) return live
    const step = live.value.steps.find((candidate) => candidate.id === stepId)
    if (!step) return { ok: false, message: 'That step is no longer in the tour.' }
    const launched = await deps.launchAgent({
      workspaceId,
      ...(live.value.author.cliId ? { cli: live.value.author.cliId } : {}),
      prompt: tourAskSeed({ tour: live.value, step, question }),
      cwd: live.value.repoRoot,
    })
    if (!launched.ok) return { ok: false, message: launched.message }
    const tour = tours.get(tourId)!
    // The new agent answers from now on: it has the tour's id and reads it.
    // Its first message IS the question, so the ask is on record as sent, and
    // its first turn end marks it answered like any other.
    tour.author = { ...tour.author, agentId: launched.agentId, agentName: null }
    tour.asks = [
      ...tour.asks,
      { id: deps.newId(), stepId, text: question.trim(), state: 'sent' as const, at: deps.now() },
    ].slice(-MAX_ASKS)
    await persist(tour)
    return { ok: true, value: { agentId: launched.agentId } }
  }

  /** The author's phase moved: flush a queued question, or mark a sent one answered. */
  function onAgentPhase(event: AgentPhaseEvent): void {
    for (const tour of tours.values()) {
      if (tour.author.agentId !== event.agentId || tour.closed) continue
      const waiting = tour.asks.filter((entry) => entry.state === 'queued' || entry.state === 'sent')
      if (waiting.length === 0) continue
      let dirty = false
      if (event.phase === 'exited' || event.phase === 'failed') {
        for (const entry of waiting) {
          const wasSent = entry.state === 'sent'
          entry.state = 'failed'
          entry.error = wasSent ? 'The agent exited while answering.' : 'The agent exited before it could be asked.'
        }
        dirty = true
      } else if (event.phase === 'idle') {
        for (const entry of waiting) {
          if (entry.state === 'sent' && event.turnEnd) {
            entry.state = 'answered'
            dirty = true
          }
        }
        const next = tour.asks.find((entry) => entry.state === 'queued')
        const session = next && !hasSentAsk(event.agentId) ? authorSession(tour) : null
        if (next && session) {
          send(session, next.text)
          next.state = 'sent'
          dirty = true
        }
      }
      // A phase event is not a request anyone is waiting on; a failed write is
      // retried by the next change, and must not surface as an unhandled rejection.
      if (dirty) void persist(tour).catch(() => undefined)
    }
  }

  return {
    create,
    update,
    goto,
    status,
    close,
    read,
    list,
    reportPlayback,
    ask,
    cancelAsk,
    askNewAgent,
    acknowledgeReveal,
    answerGoto,
    onAgentPhase,
  }
}

export function statusOf(tour: LiveTour): TourStatus {
  const current = tour.playback.currentStepId
  const index = current ? tour.steps.findIndex((step) => step.id === current) : -1
  return {
    tourId: tour.id,
    title: tour.title,
    state: tour.closed ? 'closed' : tour.playback.started ? 'playing' : 'ready',
    current,
    index: index >= 0 ? index + 1 : null,
    of: tour.steps.length,
    visited: tour.playback.visited,
    moved: tour.steps.filter((step) => step.status === 'moved').map((step) => step.id),
    gone: tour.steps.filter((step) => step.status === 'gone').map((step) => step.id),
    follow: tour.playback.follow,
    asks: tour.asks.slice(-5).map(({ id, stepId, state, text }) => ({ id, stepId, state, text })),
  }
}
