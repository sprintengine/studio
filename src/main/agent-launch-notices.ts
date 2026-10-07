import type { AgentPhase } from '../shared/electron-api'
import type { AgentPhaseEvent, AgentSessionExitEvent } from '../shared/agent-runtime'
import type { ConversationEvent } from '../shared/conversation-runtime'
import type { McpConnectionContext } from '../shared/modules/mcp-tools'
import { STUDIO_PRODUCT_NAME } from '../shared/product-identity'
import type { AgentControlPlane, ControlPlaneSendOptions, ControlPlaneSession } from './agent-control-plane'

/**
 * Launch notices — an agent that started another agent hears back from it.
 *
 * Before this, an agent that called `agent.launch` or `conversation.create`
 * could only learn what its child did by polling `agent.status`, which costs a
 * tool call per look and tells it nothing between looks. Here main remembers
 * who launched whom, watches the child's phase, and when the child's turn ends
 * or it stops to ask for something, types one short notice into the parent's
 * session: who, what happened, and where to read more. The child's output is
 * never inlined beyond a chat's last few words — the notice is a pointer, not
 * a transcript.
 *
 * Delivery is the part that has to be careful:
 *
 * - **Never mid-turn.** A notice goes to a parent only while it sits idle. A
 *   parent that is working, or itself waiting on the person, keeps its notices
 *   until its turn ends; they are never steered into the running turn, never
 *   pasted over an approval prompt. The idle check is repeated inside the
 *   control plane's per-session queue, immediately before the text is typed,
 *   so a turn that starts between the check and the paste is not interrupted.
 * - **One message per wake.** Everything that happened while the parent was
 *   busy is folded into one notice, and each child counts once: its latest
 *   news replaces what was waiting for it. One turn end is one notice; a
 *   question the child has since been answered on is withdrawn.
 * - **Gone is gone.** A parent whose session has exited or closed is dropped
 *   with everything queued for it, silently: there is nobody to tell.
 *
 * Links and queues live in memory. A launched agent dies with the app (its
 * terminal does, and a chat's turn does), so a link that outlived a restart
 * would point at nothing.
 *
 * The notice is typed as a turn, so a chat's transcript shows it where the
 * person's messages go: the conversation protocol has no origin for a message
 * other than the person. It opens with the product's name in brackets and
 * closes saying who sent it, so neither the parent nor the person reading
 * along takes it for something the person typed.
 */

/** Who launched which agent, as the gateway call that launched it knew them. */
export type LaunchedAgentLink = {
  /** The calling session, as its gateway connection names it. */
  parent: { workspaceId: string; agentId: string }
  child: {
    workspaceId: string
    agentId: string
    /** The child's session: a terminal session id, or a chat's conversation session id. */
    sessionId: string
    transport: 'terminal' | 'conversation'
    name?: string
  }
}

/**
 * The agent a gateway call came from, when it is one of this app's: only such
 * an agent has a session to be told in. A paired device or a script on the
 * socket is not one, and launches nothing it will hear back from.
 */
export function launchingAgentOf(
  context: Pick<McpConnectionContext, 'metadata'> | undefined,
): LaunchedAgentLink['parent'] | null {
  const caller = context?.metadata
  if (caller?.kind !== 'studio-agent' || !caller.workspaceId || !caller.agentId) return null
  return { workspaceId: caller.workspaceId, agentId: caller.agentId }
}

export type AgentLaunchNoticesDeps = {
  plane: Pick<AgentControlPlane, 'listSessions' | 'send'>
  /**
   * The last thing a chat child said, read when its turn ends. A chat has no
   * read tool the parent could call, so a few of its words ride the notice.
   * Absent, the notice goes without them.
   */
  readChatReply?: (sessionId: string) => string | undefined
  /** Run `job` after `ms`; returns the cancel. Injected so tests drive the clock. */
  schedule?: (job: () => void, ms: number) => () => void
  log?: (message: string) => void
}

export type AgentLaunchNotices = {
  /**
   * Remember that `parent` launched `child`. False when the parent is not a
   * live session this app can type into (a caller outside the app, or a chat
   * served by a Studio server in another process): it will not be told, and
   * should poll.
   */
  link(link: LaunchedAgentLink): boolean
  onAgentPhase(event: AgentPhaseEvent): void
  onAgentSessionExit(event: AgentSessionExitEvent): void
  onConversationEvent(event: ConversationEvent): void
  /** How many children are linked. Exposed for tests. */
  linkCount(): number
  /** How many notices are queued for a parent. Exposed for tests. */
  pendingCount(parent: { workspaceId: string; agentId: string }): number
}

export type LaunchNoticeKind = 'finished' | 'failed' | 'waiting' | 'stopped'

export type LaunchNotice = {
  kind: LaunchNoticeKind
  child: LaunchedAgentLink['child']
  /** A chat child's last words, when its turn ended. */
  reply?: string
}

type ChildLink = {
  identity: LaunchedAgentLink['child']
  parentKey: string
  /** The news already reported since the child last went to work, so a repeated event is not news. */
  reported: LaunchNoticeKind | null
}

type ParentState = {
  key: string
  workspaceId: string
  agentId: string
  pending: Map<string, LaunchNotice>
  delivering: boolean
  cancelRetry: (() => void) | null
}

/**
 * After a parent's turn ends, how long to keep looking for it to read idle.
 * A chat's turn-end event is published before its session lets go of the
 * turn, so the first look can still read busy.
 */
const SETTLE_RETRY_DELAYS_MS = [100, 400, 1_000, 2_500, 5_000] as const
/** How soon to try again when someone is typing into the parent's terminal. */
const USER_TYPING_RETRY_MS = 2_000
/** A launched agent dies with the app; this only bounds a pathological session. */
const MAX_LINKS = 256
/** Enough of a name to recognise; the rest of a long one is noise. */
const MAX_NAME_CHARS = 60
/** An id is minted by the app and short; this only keeps a strange one from running on. */
const MAX_ID_CHARS = 120
/** The tail of a chat child's reply the notice carries. */
const MAX_REPLY_CHARS = 280

const WORKING_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>(['starting', 'thinking', 'tool_use'])
/** Failures that mean the parent is not there to tell. */
const GONE_REASONS = new Set(['not_alive', 'not_found'])
/** Failures that mean "not now": the notices wait for the next chance. */
const LATER_REASONS = new Set(['busy', 'user_typing', 'unsupported'])

/**
 * The terminal send: gated on the person not typing (`waitForReady` with no
 * wait — a refusal comes back at once), and on the agent being idle at the
 * moment of the paste. The plane's own gate also takes `awaiting_input` as
 * ready, which is right for a prompt someone queued but wrong here: the parent
 * would be answering an approval with a notice.
 */
function terminalSendOptions(isIdle: () => boolean): ControlPlaneSendOptions {
  return {
    waitForReady: true,
    readyTimeoutMs: 0,
    precondition: () => (isIdle() ? null : 'The launching agent started a turn; the notice waits for it to end.'),
  }
}

export function createAgentLaunchNotices(deps: AgentLaunchNoticesDeps): AgentLaunchNotices {
  const schedule =
    deps.schedule ??
    ((job: () => void, ms: number) => {
      const timer = setTimeout(job, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const children = new Map<string, ChildLink>()
  const parents = new Map<string, ParentState>()

  function link(input: LaunchedAgentLink): boolean {
    const parent = input.parent
    if (!parent.workspaceId || !parent.agentId || !input.child.sessionId) return false
    if (!resolveParentSession(parent)) return false
    const key = parentKey(parent)
    if (!parents.has(key)) {
      parents.set(key, {
        key,
        workspaceId: parent.workspaceId,
        agentId: parent.agentId,
        pending: new Map(),
        delivering: false,
        cancelRetry: null,
      })
    }
    children.set(input.child.sessionId, { identity: { ...input.child }, parentKey: key, reported: null })
    while (children.size > MAX_LINKS) unlinkChild(children.keys().next().value!)
    return true
  }

  // ── Child events ─────────────────────────────────────────────────────────

  function onAgentPhase(event: AgentPhaseEvent): void {
    const child = terminalChildOf(event)
    if (child) {
      if (WORKING_PHASES.has(event.phase)) childWentToWork(child)
      else if (event.phase === 'awaiting_input' && event.previousPhase !== 'awaiting_input') report(child, 'waiting')
      else if (event.turnEnd) report(child, event.turnFailure ? 'failed' : 'finished')
    }
    if (event.turnEnd || event.phase === 'idle') parentTurnEnded(event.workspaceId, event.agentId, event)
  }

  function onAgentSessionExit(event: AgentSessionExitEvent): void {
    const child = children.get(event.executionId)
    if (child) {
      report(child, 'stopped')
      unlinkChild(child.identity.sessionId, { keepParent: true })
    }
    // A parent whose terminal exited has nobody left to tell.
    if (event.workspaceId && event.agentId) {
      const parent = parents.get(parentKey({ workspaceId: event.workspaceId, agentId: event.agentId }))
      if (parent) dropParent(parent)
    }
  }

  function onConversationEvent(event: ConversationEvent): void {
    const child = conversationChildOf(event)
    if (child) {
      switch (event.type) {
        case 'user_message':
        case 'turn_started':
        case 'approval_resolved':
          childWentToWork(child)
          break
        case 'approval_requested':
          if (event.payload?.autoApproved !== true) report(child, 'waiting')
          break
        case 'turn_completed':
        case 'turn_failed':
          // A turn a steered message ended: the chat carries straight on.
          if (event.payload?.steered === true) break
          report(
            child,
            event.type === 'turn_failed' ? 'failed' : 'finished',
            deps.readChatReply?.(child.identity.sessionId),
          )
          break
        case 'session_closed':
          report(child, 'stopped')
          unlinkChild(child.identity.sessionId, { keepParent: true })
          break
      }
    }
    const ended = event.type === 'turn_failed' || (event.type === 'turn_completed' && event.payload?.steered !== true)
    if (ended) parentTurnEnded(event.workspaceId, event.agentId)
    if (event.type === 'session_closed') {
      const parent = parents.get(parentKey(event))
      if (parent) dropParent(parent)
    }
  }

  function terminalChildOf(event: AgentPhaseEvent): ChildLink | undefined {
    if (event.executionId) {
      const byExecution = children.get(event.executionId)
      if (byExecution) return byExecution
    }
    for (const child of children.values()) {
      const { transport, workspaceId, agentId } = child.identity
      if (transport !== 'terminal' || agentId !== event.agentId) continue
      if (workspaceId === event.workspaceId || workspaceId === event.launchWorkspaceId) return child
    }
    return undefined
  }

  function conversationChildOf(event: ConversationEvent): ChildLink | undefined {
    const bySession = children.get(event.sessionId)
    if (bySession) return bySession
    for (const child of children.values()) {
      const { transport, workspaceId, agentId } = child.identity
      if (transport === 'conversation' && workspaceId === event.workspaceId && agentId === event.agentId) return child
    }
    return undefined
  }

  function childWentToWork(child: ChildLink): void {
    child.reported = null
    // A question the child was answered on is no longer news.
    const parent = parents.get(child.parentKey)
    const sessionId = child.identity.sessionId
    if (parent?.pending.get(sessionId)?.kind === 'waiting') parent.pending.delete(sessionId)
  }

  function report(child: ChildLink, kind: LaunchNoticeKind, reply?: string): void {
    if (child.reported === kind) return
    child.reported = kind
    const parent = parents.get(child.parentKey)
    if (!parent) return
    parent.pending.set(child.identity.sessionId, { kind, child: child.identity, ...(reply?.trim() ? { reply } : {}) })
    void flush(parent, null)
  }

  // ── Parents ──────────────────────────────────────────────────────────────

  function parentTurnEnded(workspaceId: string | null, agentId: string, event?: AgentPhaseEvent): void {
    for (const parent of parents.values()) {
      if (parent.agentId !== agentId) continue
      if (parent.workspaceId !== workspaceId && parent.workspaceId !== event?.launchWorkspaceId) continue
      if (parent.pending.size > 0) void flush(parent, 0)
    }
  }

  function resolveParentSession(parent: { workspaceId: string; agentId: string }): ControlPlaneSession | undefined {
    const matches = deps.plane
      .listSessions()
      .filter(
        (session) =>
          session.alive &&
          session.agentId === parent.agentId &&
          (session.workspaceId === parent.workspaceId || session.launchWorkspaceId === parent.workspaceId),
      )
    // Two live sessions claiming one agent is a state the app does not mean
    // to be in; typing into either could be typing into the wrong one.
    return matches.length === 1 ? matches[0] : undefined
  }

  function isIdle(sessionId: string): boolean {
    return deps.plane.listSessions().find((session) => session.sessionId === sessionId)?.phase === 'idle'
  }

  /**
   * Deliver what is queued for `parent` if it is idle now. `settleAttempt` is
   * set when the parent's turn just ended: a parent that still reads busy is
   * looked at again a few times while its session lets go of the turn. Null
   * for a look on a child's news, which needs no follow-up — a busy parent
   * gets its notices when its own turn ends.
   */
  async function flush(parent: ParentState, settleAttempt: number | null): Promise<void> {
    parent.cancelRetry?.()
    parent.cancelRetry = null
    if (parent.delivering || parent.pending.size === 0) return
    const session = resolveParentSession(parent)
    if (!session) {
      dropParent(parent)
      return
    }
    if (session.phase !== 'idle') {
      retryAfterSettle(parent, settleAttempt)
      return
    }

    const batch = [...parent.pending.values()]
    parent.pending.clear()
    parent.delivering = true
    let failure: { reason: string; message: string } | null = null
    try {
      const sent = await deps.plane.send(
        { sessionId: session.sessionId },
        composeLaunchNotice(batch),
        session.transport === 'terminal' ? terminalSendOptions(() => isIdle(session.sessionId)) : {},
      )
      if (!sent.ok) failure = sent
    } catch (error) {
      failure = { reason: 'write_failed', message: error instanceof Error ? error.message : String(error) }
    } finally {
      parent.delivering = false
    }
    // Dropped while the send was out: whatever it said, there is nobody left.
    if (parents.get(parent.key) !== parent) return
    if (!failure) {
      forgetIfDone(parent)
      return
    }
    if (GONE_REASONS.has(failure.reason)) {
      dropParent(parent)
      return
    }
    if (!LATER_REASONS.has(failure.reason)) {
      deps.log?.(`A launch notice for ${parent.agentId} was not delivered: ${failure.message}`)
      forgetIfDone(parent)
      return
    }
    // Back in the queue behind anything newer that arrived during the send.
    for (const notice of batch)
      if (!parent.pending.has(notice.child.sessionId)) parent.pending.set(notice.child.sessionId, notice)
    if (failure.reason === 'user_typing') {
      parent.cancelRetry = schedule(() => void flush(parent, null), USER_TYPING_RETRY_MS)
    } else retryAfterSettle(parent, settleAttempt)
  }

  function retryAfterSettle(parent: ParentState, settleAttempt: number | null): void {
    if (settleAttempt === null || settleAttempt >= SETTLE_RETRY_DELAYS_MS.length) return
    parent.cancelRetry = schedule(() => void flush(parent, settleAttempt + 1), SETTLE_RETRY_DELAYS_MS[settleAttempt])
  }

  function forgetIfDone(parent: ParentState): void {
    if (parent.pending.size > 0) return
    for (const child of children.values()) if (child.parentKey === parent.key) return
    parent.cancelRetry?.()
    parents.delete(parent.key)
  }

  function dropParent(parent: ParentState): void {
    parent.cancelRetry?.()
    parents.delete(parent.key)
    for (const [sessionId, child] of children) if (child.parentKey === parent.key) children.delete(sessionId)
  }

  function unlinkChild(sessionId: string, options: { keepParent?: boolean } = {}): void {
    const child = children.get(sessionId)
    if (!child) return
    children.delete(sessionId)
    const parent = parents.get(child.parentKey)
    if (parent && !options.keepParent) forgetIfDone(parent)
  }

  return {
    link,
    onAgentPhase,
    onAgentSessionExit,
    onConversationEvent,
    linkCount: () => children.size,
    pendingCount: (parent) => parents.get(parentKey(parent))?.pending.size ?? 0,
  }
}

function parentKey(parent: { workspaceId: string | null; agentId: string }): string {
  return `${parent.workspaceId ?? ''}\0${parent.agentId}`
}

// ── The notice's words (exported for tests) ────────────────────────────────

/**
 * How a message Studio types into an agent's session opens and closes: the
 * conversation protocol has no origin for a message other than the person, so
 * the words say who sent it. Shared with the other notices Studio sends.
 */
export const STUDIO_NOTICE_PREFIX = `[${STUDIO_PRODUCT_NAME}]`
export const STUDIO_NOTICE_SIGNATURE = `(Sent by ${STUDIO_PRODUCT_NAME}, not typed by the person.)`
const NOTICE_PREFIX = STUDIO_NOTICE_PREFIX
const NOTICE_SIGNATURE = STUDIO_NOTICE_SIGNATURE

/** One message for everything a parent is told at once. */
export function composeLaunchNotice(notices: readonly LaunchNotice[]): string {
  if (notices.length === 1) {
    const [notice] = notices
    const what = noticeSentence(notice)
    return [
      `${NOTICE_PREFIX} ${noticeSubject(notice)}, which you launched, ${what}`,
      nextStep(notice),
      NOTICE_SIGNATURE,
    ]
      .filter(Boolean)
      .join(' ')
  }
  const lines = notices.map((notice) =>
    `- ${noticeSubject(notice)} ${noticeSentence(notice)} ${nextStep(notice) ?? ''}`.trimEnd(),
  )
  return [`${NOTICE_PREFIX} ${notices.length} agents you launched have news:`, ...lines, NOTICE_SIGNATURE].join('\n')
}

function noticeSubject(notice: LaunchNotice): string {
  const name = cleanLine(notice.child.name ?? '', MAX_NAME_CHARS)
  return `Agent ${name || cleanLine(notice.child.agentId, MAX_ID_CHARS)}`
}

function noticeSentence(notice: LaunchNotice): string {
  switch (notice.kind) {
    case 'finished':
      return 'finished its turn.'
    case 'failed':
      return 'ended its turn without finishing: it failed or was stopped.'
    case 'waiting':
      return 'is waiting for input: a question or an approval for the person.'
    case 'stopped':
      return 'stopped: its session ended.'
  }
}

/** Where to read more: `agent.status` for a terminal agent; a chat has no read tool, so its last words. */
function nextStep(notice: LaunchNotice): string | null {
  const ids = `workspaceId "${cleanLine(notice.child.workspaceId, MAX_ID_CHARS)}", agentId "${cleanLine(notice.child.agentId, MAX_ID_CHARS)}"`
  if (notice.child.transport === 'terminal') {
    if (notice.kind === 'stopped') return null
    return `Read where it stands with agent.status (${ids}).`
  }
  const reply = notice.reply ? cleanTail(notice.reply, MAX_REPLY_CHARS) : ''
  return reply ? `It last said: "${reply}" (${ids}).` : `(${ids})`
}

/**
 * One line of printable text. A name and a reply come from an agent and are
 * typed into another agent's prompt, so nothing in them may act as a key: no
 * escape sequence (which could close the bracketed paste), no newline (which
 * could submit early).
 */
function cleanLine(text: string, max: number): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

/** The end of a reply, where an agent puts its conclusion. */
function cleanTail(text: string, max: number): string {
  const flat = cleanLine(text, Number.MAX_SAFE_INTEGER).replace(/"/gu, "'")
  return flat.length > max ? `…${flat.slice(flat.length - (max - 1)).trimStart()}` : flat
}
