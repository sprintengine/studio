import type { TerminalSessionSnapshot } from '../../../shared/electron-api'

export type TerminalSessionsApi = {
  terminalList(): Promise<TerminalSessionSnapshot[]>
  onTerminalSessionsChanged(cb: (sessions: TerminalSessionSnapshot[]) => void): () => void
}

export type TerminalSessionsStore = ReturnType<typeof createTerminalSessionsStore>

function getActivitySignature(activity: TerminalSessionSnapshot['activity']) {
  switch (activity.kind) {
    case 'working':
    case 'idle':
      return [activity.kind, activity.since]
    case 'exited':
      return [activity.kind, activity.at, activity.exitCode]
    case 'failed':
      return [activity.kind, activity.at, activity.exitCode, activity.message ?? '']
  }
}

// The ledger reduced to what changes when it changes: how many files, the two
// running totals, how many edits made them, the newest edit time, and which
// file is at the head of the list.
//
// The edit COUNT is load-bearing, not decoration. An edit that adds and removes
// nothing is the reporter's honest answer for a tool whose result shape it
// cannot count (a NotebookEdit, a MultiEdit from a CLI that reports no patch),
// and the timestamp is a max over out-of-order hook frames, so neither the
// totals nor the time need move when such an edit lands. `edits` always does.
//
// The head path is the whole of the ordering: the ledger is rendered
// newest-first, and the only reordering a fold can produce is promoting one
// file to the front.
//
// The paths themselves are deliberately NOT hashed — five hundred of them is
// tens of kilobytes of string per session, and this runs for every session on
// every broadcast. `contextUsage` is deliberately absent: it is null until the
// status-line forwarder lands, and when it arrives it should be keyed on the
// rounded percentage only — its `at` moves on every sample, which is exactly
// the lastOutputAt-class noise this signature exists to drop.
function getFileChangesSignature(fileChanges: TerminalSessionSnapshot['fileChanges']) {
  let additions = 0
  let deletions = 0
  let edits = 0
  let lastEditedAt = 0
  for (const change of fileChanges ?? []) {
    // `|| 0` so a malformed entry compares as itself rather than collapsing to
    // the NaN every other malformed entry serializes to.
    additions += change.additions || 0
    deletions += change.deletions || 0
    edits += change.edits || 0
    if (change.lastEditedAt > lastEditedAt) lastEditedAt = change.lastEditedAt
  }
  return [fileChanges?.length ?? 0, additions, deletions, edits, lastEditedAt, fileChanges?.[0]?.path ?? '']
}

// Signature of the session fields a consumer actually renders. Deliberately
// excludes high-frequency noise (notably lastOutputAt), so a broadcast that only
// bumps output timing is treated as unchanged.
export function getTerminalSessionsSignature(sessions: TerminalSessionSnapshot[]): string {
  const rows = [...sessions]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
    .map((session) => [
      session.sessionId,
      session.processAlive,
      getActivitySignature(session.activity),
      session.kind,
      session.workspaceId ?? '',
      session.agentId ?? '',
      session.terminalId ?? '',
      session.cli ?? '',
      session.cwd ?? '',
      session.sprintEngineStatePath ?? '',
      session.executionMode ?? '',
      session.worktreeId ?? '',
      session.worktreePath ?? '',
      session.agentSession?.sessionId ?? '',
      session.agentSession?.executionId ?? '',
      session.exitedAt ?? null,
      // User lock: flips alone (no co-varying field like suspend's
      // processAlive), so it must be in the signature or toggling the lock
      // never re-renders the control.
      session.reapExempt,
      // The only authoritative-phase distinction the bridged `activity` cannot
      // express: awaiting_input reads as idle, yet needs attention. Including the
      // raw phase instead would defeat this signature's purpose — thinking ↔
      // tool_use flips on every tool call are high-frequency noise, like
      // lastOutputAt above. Widen this when more phase detail is actually rendered.
      session.agentState?.phase === 'awaiting_input',
      // The tab hover preview and the auto-title both render this, so a new
      // prompt has to survive the dedupe. Keyed on the timestamp rather than the
      // text: it changes on every submit, including a prompt re-sent verbatim.
      session.lastPrompt?.at ?? null,
      // Observed checkout (MC-2440): the tab glyph and identity card render
      // where the session's hooks last saw it, so a cwd move or git's answer
      // for it must survive the dedupe. `at` is deliberately omitted — it only
      // changes alongside `cwd`.
      session.observedCheckout?.cwd ?? '',
      session.observedCheckout?.resolved ?? false,
      session.observedCheckout?.gitRoot ?? '',
      session.observedCheckout?.branch ?? '',
      session.observedCheckout?.isLinkedWorktree ?? false,
      session.observedCheckout?.missing ?? false,
      // The per-session file ledger and the subagent count: both are numbers a
      // row renders, and both move without any phase moving, so a session that
      // only edited a file would otherwise never re-render. Unlike the
      // thinking ↔ tool_use churn excluded above, these change once per edit
      // and once per subagent — a rate a paint can carry.
      getFileChangesSignature(session.fileChanges),
      session.activeSubagents ?? 0,
    ])
  return JSON.stringify(rows)
}

const EMPTY_TERMINAL_SESSIONS_SIGNATURE = getTerminalSessionsSignature([])

function defaultTerminalSessionsApi(): TerminalSessionsApi {
  return window.api
}

export function createTerminalSessionsStore(apiProvider: () => TerminalSessionsApi = defaultTerminalSessionsApi) {
  let unsubscribeIpc: (() => void) | null = null
  let subscriberCount = 0
  let hasLiveSnapshot = false
  let liveSessions: TerminalSessionSnapshot[] = []
  let semanticSessions: TerminalSessionSnapshot[] = []
  let semanticSignature = EMPTY_TERMINAL_SESSIONS_SIGNATURE
  let connectionVersion = 0

  const liveListeners = new Set<() => void>()
  const semanticListeners = new Set<() => void>()
  const liveSnapshotListeners = new Set<(sessions: TerminalSessionSnapshot[]) => void>()

  const reportListenerError = (error: unknown) => {
    setTimeout(() => {
      throw error
    }, 0)
  }

  const notify = (listener: () => void) => {
    try {
      listener()
    } catch (error) {
      reportListenerError(error)
    }
  }

  const notifySnapshot = (
    listener: (sessions: TerminalSessionSnapshot[]) => void,
    sessions: TerminalSessionSnapshot[]
  ) => {
    try {
      listener(sessions)
    } catch (error) {
      reportListenerError(error)
    }
  }

  const apply = (sessions: TerminalSessionSnapshot[]) => {
    liveSessions = sessions
    hasLiveSnapshot = true
    for (const listener of liveListeners) notify(listener)
    for (const listener of liveSnapshotListeners) notifySnapshot(listener, sessions)

    const nextSignature = getTerminalSessionsSignature(sessions)
    if (nextSignature === semanticSignature) return
    semanticSignature = nextSignature
    semanticSessions = sessions
    for (const listener of semanticListeners) notify(listener)
  }

  const refresh = async (): Promise<TerminalSessionSnapshot[]> => {
    const version = connectionVersion
    const api = apiProvider() as Partial<TerminalSessionsApi> | undefined
    // Same partial-host tolerance as connect(): quiet emptiness, not a throw.
    if (typeof api?.terminalList !== 'function') return []
    const sessions = await api.terminalList()
    if (subscriberCount === 0 || version !== connectionVersion) return sessions
    apply(sessions)
    return sessions
  }

  const connect = () => {
    if (unsubscribeIpc) return
    // A host without the terminal bridge (a partial test harness, an aux
    // window with a narrower preload) gets an empty, quiet store rather than
    // a subscriber-time throw inside React's commit.
    const api = apiProvider() as Partial<TerminalSessionsApi> | undefined
    if (typeof api?.onTerminalSessionsChanged !== 'function' || typeof api.terminalList !== 'function') return
    connectionVersion += 1
    const version = connectionVersion
    unsubscribeIpc = api.onTerminalSessionsChanged(apply)
    void api.terminalList().then((sessions) => {
      if (subscriberCount === 0 || !unsubscribeIpc || version !== connectionVersion) return
      apply(sessions)
    }).catch(() => {})
  }

  const disconnectIfIdle = () => {
    if (subscriberCount > 0) return
    connectionVersion += 1
    unsubscribeIpc?.()
    unsubscribeIpc = null
    hasLiveSnapshot = false
    liveSessions = []
    semanticSessions = []
    semanticSignature = EMPTY_TERMINAL_SESSIONS_SIGNATURE
  }

  const subscribe = (listeners: Set<() => void>, listener: () => void): (() => void) => {
    let disposed = false
    const wrapped = () => listener()
    subscriberCount += 1
    listeners.add(wrapped)
    connect()
    return () => {
      if (disposed) return
      disposed = true
      listeners.delete(wrapped)
      subscriberCount = Math.max(0, subscriberCount - 1)
      disconnectIfIdle()
    }
  }

  const subscribeLiveSnapshot = (listener: (sessions: TerminalSessionSnapshot[]) => void): (() => void) => {
    let disposed = false
    const wrapped = (sessions: TerminalSessionSnapshot[]) => listener(sessions)
    const hadLiveSnapshot = hasLiveSnapshot
    subscriberCount += 1
    liveSnapshotListeners.add(wrapped)
    connect()
    if (hadLiveSnapshot) notifySnapshot(wrapped, liveSessions)
    return () => {
      if (disposed) return
      disposed = true
      liveSnapshotListeners.delete(wrapped)
      subscriberCount = Math.max(0, subscriberCount - 1)
      disconnectIfIdle()
    }
  }

  return {
    getLiveSnapshot: () => liveSessions,
    getSemanticSnapshot: () => semanticSessions,
    /** True once main has answered at least once — before that, "no sessions" is "not asked yet". */
    hasSnapshot: () => hasLiveSnapshot,
    refresh,
    subscribeLive: (listener: () => void) => subscribe(liveListeners, listener),
    subscribeLiveSnapshot,
    subscribeSemantic: (listener: () => void) => subscribe(semanticListeners, listener),
  }
}

const terminalSessionsStore = createTerminalSessionsStore()

export const getLiveTerminalSessionsSnapshot = terminalSessionsStore.getLiveSnapshot
export const getTerminalSessionsSnapshot = terminalSessionsStore.getSemanticSnapshot
export const hasTerminalSessionsSnapshot = terminalSessionsStore.hasSnapshot
export const refreshTerminalSessions = terminalSessionsStore.refresh
export const subscribeLiveTerminalSessions = terminalSessionsStore.subscribeLive
export const subscribeLiveTerminalSessionSnapshots = terminalSessionsStore.subscribeLiveSnapshot
export const subscribeTerminalSessions = terminalSessionsStore.subscribeSemantic
