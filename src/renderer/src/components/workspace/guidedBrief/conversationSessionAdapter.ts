// Conversation-transport twin of sessionAdapter: runs a Design Wizard
// specialist as a Claude-backed conversation session (Claude Agent SDK, via
// the shared ConversationRuntime) instead of a PTY. Interview questions
// arrive as structured AskUserQuestion cards (no stdout scraping, no
// keystroke answers); stage-ready markers are detected in the clean
// content_delta stream, which carries no ANSI codes or prompt chrome.
//
// The returned session satisfies the same GuidedBriefSpecialistSession shape
// the PTY adapter produces, so the wizard's hooks and stage machine are
// transport-agnostic.

import type {
  ConversationCliRuntimeOverrides,
  ConversationEvent,
  ConversationListSessionsInput,
  ConversationListSessionsResult,
  ConversationPermissionPreset,
  ConversationRespondToRequestInput,
  ConversationSendTurnInput,
  ConversationSessionActionResult,
  ConversationStartSessionInput,
  ConversationStartSessionResult,
  ConversationStopSessionInput,
  ConversationTranscriptInput,
  ConversationTranscriptResult,
} from '../../../../../shared/conversation-runtime'
import type {
  GuidedInterviewDecision,
  GuidedInterviewQuestion,
} from './interviewProtocol'
import {
  guidedBriefSpecialistAgentId,
  guidedBriefUsesDesignSkill,
  markerDetectionForInput,
  markerForInput,
  promptForInput,
  type StartGuidedBriefSpecialistSessionInput,
  type StartGuidedBriefSpecialistSessionOptions,
  type StartGuidedBriefSpecialistSessionResult,
} from './sessionAdapter'

export type GuidedBriefConversationApi = {
  conversationSessionStart: (input: ConversationStartSessionInput) => Promise<ConversationStartSessionResult>
  conversationSessionSendTurn: (input: ConversationSendTurnInput) => Promise<ConversationSessionActionResult>
  conversationSessionRespondToRequest: (
    input: ConversationRespondToRequestInput
  ) => Promise<ConversationSessionActionResult>
  conversationSessionStop: (input: ConversationStopSessionInput) => Promise<ConversationSessionActionResult>
  conversationSessionsList: (input?: ConversationListSessionsInput) => Promise<ConversationListSessionsResult>
  conversationTranscript: (input: ConversationTranscriptInput) => Promise<ConversationTranscriptResult>
  onConversationEvent: (cb: (event: ConversationEvent) => void) => () => void
}

// Every non-interactive tool the specialist needs runs without an approval
// card (the wizard is an unattended flow the user watches); AskUserQuestion is
// deliberately NOT allowlisted so it reaches the question-card interception.
// The preset the wizard runs on when the caller names none. NOT the same choice
// the PTY twin makes (`bypass_all`): bypassing permissions would also silence
// AskUserQuestion, and the structured interview IS the wizard. 'default' plus
// the allowlist below is the equivalent — every working tool is pre-approved,
// and only the question tool stops for the user. A caller that has a real user
// choice passes `permissionPreset` and this is not consulted.
export const GUIDED_BRIEF_DEFAULT_PERMISSION_PRESET: ConversationPermissionPreset = 'default'

export const GUIDED_BRIEF_ALLOWED_TOOLS = [
  'Task',
  'Bash',
  'BashOutput',
  'KillShell',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Skill',
]

// Stable per-role conversation agent id: the transcript (and its resume
// cursor) live under this id, so re-entering a stage resumes the same CLI
// session after a reload or restart. Delegates to the shared derivation so
// both transports address one identity per specialist.
export function guidedBriefConversationAgentId(input: StartGuidedBriefSpecialistSessionInput): string {
  return guidedBriefSpecialistAgentId(input)
}

type PendingInterview = {
  requestId: string
  // One card per question, answered sequentially; the respond is sent only
  // when every question has an answer (AskUserQuestion calls may bundle up
  // to four questions even though the prompt asks for one per call).
  questions: GuidedInterviewQuestion[]
  answers: Record<string, string>
  index: number
}

type ConversationSessionRuntimeState = {
  outputTail: string
  markerEmitted: boolean
  decisions: GuidedInterviewDecision[]
  currentQuestion: GuidedInterviewQuestion | null
  pendingRequest: PendingInterview | null
  // Non-question approvals (generic tool / plan) seen before the session id is
  // known (transcript replay), auto-responded once it is.
  pendingAutoResponds: Array<{ requestId: string; approve: boolean }>
  hadUserTurn: boolean
}

export async function startGuidedBriefConversationSession(
  input: StartGuidedBriefSpecialistSessionInput & { workspaceId: string; providerModelId?: string },
  options: Omit<StartGuidedBriefSpecialistSessionOptions, 'terminalApi'> & {
    conversationApi: GuidedBriefConversationApi
    // Tool-permission preset for the specialist's session. Omitted falls back to
    // GUIDED_BRIEF_DEFAULT_PERMISSION_PRESET — the wizard's own choice, not a
    // silent hardcode at the start call.
    permissionPreset?: ConversationPermissionPreset
  }
): Promise<StartGuidedBriefSpecialistSessionResult> {
  const api = options.conversationApi
  const agentId = guidedBriefConversationAgentId(input)
  const marker = markerForInput(input)
  const usesDesignSkill = guidedBriefUsesDesignSkill(input, 'conversation')
  const prompt = promptForInput(input, marker, 'ask-user-question', usesDesignSkill)
  const markerDetection = markerDetectionForInput(input, marker)
  const state: ConversationSessionRuntimeState = {
    outputTail: '',
    markerEmitted: false,
    decisions: [],
    currentQuestion: null,
    pendingRequest: null,
    pendingAutoResponds: [],
    hadUserTurn: false,
  }
  // Set once the session is started (or an existing live session adopted);
  // live auto-responds need it.
  let conversationSessionId: string | null = null
  const autoRespond = (requestId: string, approve: boolean): void => {
    if (!conversationSessionId) {
      state.pendingAutoResponds.push({ requestId, approve })
      return
    }
    void api
      .conversationSessionRespondToRequest({ sessionId: conversationSessionId, requestId, approved: approve })
      .catch(() => undefined)
  }
  const seenEventIds = new Set<string>()
  const disposers: Array<() => void> = []
  const dispose = (): void => {
    while (disposers.length > 0) disposers.pop()?.()
  }

  const emitInterview = (): void => {
    options.onInterview?.({
      currentQuestion: state.currentQuestion,
      decisions: [...state.decisions],
      malformedCount: 0,
    })
  }

  const handleEvent = (event: ConversationEvent): void => {
    if (event.workspaceId !== input.workspaceId || event.agentId !== agentId) return
    if (seenEventIds.has(event.id)) return
    seenEventIds.add(event.id)

    switch (event.type) {
      case 'user_message': {
        state.hadUserTurn = true
        break
      }
      case 'content_delta': {
        const text = typeof event.payload?.text === 'string' ? event.payload.text : ''
        if (!text) break
        state.outputTail = `${state.outputTail}${text}`.slice(-(marker.length + 4096))
        options.onOutput?.({ stream: 'stdout', chunk: text, at: event.createdAt || Date.now() })
        if (!state.markerEmitted && containsMarkerLine(state.outputTail, marker)) {
          state.markerEmitted = true
          options.onLifecycle?.('ready')
          options.onMarker?.(marker)
        }
        break
      }
      case 'approval_requested': {
        const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
        if (!requestId) break
        if (event.payload?.kind !== 'question') {
          // The wizard pane has no generic approval UI; leaving these pending
          // would block the child forever. Plans are safe to wave through
          // (exiting plan mode just resumes work); anything else is denied so
          // the specialist routes around it with allowlisted tools.
          autoRespond(requestId, event.payload?.kind === 'plan')
          break
        }
        const questions = readQuestions(event.payload, requestId)
        if (!questions) break
        state.pendingRequest = { requestId, questions, answers: {}, index: 0 }
        state.currentQuestion = questions[0] ?? null
        emitInterview()
        break
      }
      case 'approval_resolved': {
        const requestId = typeof event.payload?.requestId === 'string' ? event.payload.requestId : null
        if (!requestId || state.pendingRequest?.requestId !== requestId) break
        const answers = (event.payload?.answers ?? {}) as Record<string, unknown>
        for (const question of state.pendingRequest.questions) {
          const answer = answers[question.question]
          state.decisions.push({
            id: question.id,
            question: question.question,
            label: typeof answer === 'string' && answer ? answer : '(dismissed)',
          })
        }
        state.currentQuestion = null
        state.pendingRequest = null
        emitInterview()
        break
      }
      case 'turn_failed': {
        // A dead turn cannot keep a question pending (replayed transcripts
        // close killed turns this way too).
        if (state.pendingRequest) {
          state.currentQuestion = null
          state.pendingRequest = null
          emitInterview()
        }
        const reason = typeof event.payload?.reason === 'string' ? event.payload.reason : ''
        if (reason && reason !== 'interrupted') {
          const message = typeof event.payload?.message === 'string' ? event.payload.message : 'Specialist turn failed.'
          options.onError?.(message)
        }
        break
      }
      case 'session_closed': {
        options.onLifecycle?.(state.markerEmitted ? 'ready' : 'exited')
        break
      }
      default:
        break
    }
  }

  options.onLifecycle?.('starting')
  disposers.push(api.onConversationEvent(handleEvent))

  // Replay the persisted transcript first: a reload/restart mid-stage rebuilds
  // marker + decision state, and tells us whether this is a resume.
  try {
    const transcript = await api.conversationTranscript({
      workspaceRoot: input.workspaceRoot,
      workspaceId: input.workspaceId,
      agentId,
    })
    if (transcript.ok) {
      for (const event of transcript.events) handleEvent(event)
    }
  } catch {
    // Best-effort: a missing transcript just means a fresh session.
  }
  const resuming = state.hadUserTurn

  // A renderer reload/remount must reattach to a still-live session instead of
  // minting a second one (two children would drive the same CLI session and
  // the old one — possibly blocked on a permission — would leak until quit).
  let adoptedLiveSession = false
  try {
    const listed = await api.conversationSessionsList({ workspaceId: input.workspaceId, agentId })
    if (listed.ok) {
      const live = listed.sessions.find((session) => session.status !== 'stopped')
      if (live) {
        conversationSessionId = live.sessionId
        adoptedLiveSession = true
      }
    }
  } catch {
    // Best-effort: fall through to a fresh session.
  }

  if (!adoptedLiveSession) {
    // Install the design skill before the fresh session starts so Claude Code
    // discovers it in .claude/skills/ at startup. Best-effort: the activation
    // line is already in the prompt; a missing skill degrades craft, never
    // blocks the session. A resumed live session already has it from launch.
    if (usesDesignSkill && options.ensureDesignSkillInstalled) {
      await options.ensureDesignSkillInstalled().catch((error) => {
        console.warn('[guided-brief] frontend-design skill install failed', error)
      })
    }
    const started = await api
      .conversationSessionStart({
        workspaceRoot: input.workspaceRoot,
        workspaceId: input.workspaceId,
        agentId,
        providerId: 'claude-agent',
        modelId: input.providerModelId ?? input.cliModel ?? 'sonnet',
        cliRuntimes: options.cliRuntimes as ConversationCliRuntimeOverrides | undefined,
        permissionPreset: options.permissionPreset ?? GUIDED_BRIEF_DEFAULT_PERMISSION_PRESET,
        allowedTools: GUIDED_BRIEF_ALLOWED_TOOLS,
      })
      .catch((error): ConversationStartSessionResult => ({
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to start the specialist conversation session.',
      }))
    if (!started.ok) {
      dispose()
      options.onLifecycle?.('error')
      options.onError?.(started.message)
      return { ok: false, sessionId: agentId, message: started.message }
    }
    conversationSessionId = started.session.sessionId
  }
  // Non-question approvals seen during replay: only meaningful when the
  // session that raised them is still the live one we just adopted.
  const queuedAutoResponds = state.pendingAutoResponds.splice(0)
  if (adoptedLiveSession) {
    for (const queued of queuedAutoResponds) autoRespond(queued.requestId, queued.approve)
  }
  const activeConversationSessionId = conversationSessionId
  if (!activeConversationSessionId) {
    dispose()
    const message = 'Specialist conversation session did not produce a session id.'
    options.onLifecycle?.('error')
    options.onError?.(message)
    return { ok: false, sessionId: agentId, message }
  }

  const answer = async (text: string): Promise<boolean> => {
    const pending = state.pendingRequest
    if (!pending || !conversationSessionId) return false
    const current = pending.questions[pending.index]
    if (!current) return false
    pending.answers[current.question] = text
    // More questions in the same AskUserQuestion call: advance the card and
    // hold the respond until the whole answer map is complete.
    if (pending.index + 1 < pending.questions.length) {
      pending.index += 1
      state.currentQuestion = pending.questions[pending.index] ?? null
      emitInterview()
      return true
    }
    const result = await api
      .conversationSessionRespondToRequest({
        sessionId: conversationSessionId,
        requestId: pending.requestId,
        approved: true,
        answers: { ...pending.answers },
      })
      .catch(() => ({ ok: false as const, message: 'Could not send the answer.' }))
    return result.ok
  }

  // Kick off the stage turn. On resume the original prompt is already in the
  // CLI session's own history — re-sending it would restart the interview —
  // so nudge the agent to continue instead. Fire-and-forget: the send promise
  // resolves at end-of-turn, but events stream in live.
  if (!adoptedLiveSession) {
    const firstMessage = resuming
      ? 'The app restarted while you were working. Continue from where you left off: if an interview question was pending, re-ask it with the AskUserQuestion tool; if the artifact was ready, re-emit the readiness marker line.'
      : prompt
    void api
      .conversationSessionSendTurn({ sessionId: activeConversationSessionId, message: firstMessage })
      .then((result) => {
        if (!result.ok) {
          options.onLifecycle?.('error')
          options.onError?.(result.message)
        }
      })
      .catch((error) => {
        options.onLifecycle?.('error')
        options.onError?.(error instanceof Error ? error.message : 'Specialist conversation turn failed.')
      })
  }

  options.onLifecycle?.('running')
  return {
    ok: true,
    session: {
      sessionId: activeConversationSessionId,
      kind: input.kind,
      markerDetection,
      rawTerminal: {
        sessionId: activeConversationSessionId,
        cwd: input.workspaceRoot,
        label: 'Specialist conversation',
      },
      prompt,
      stop: async () => {
        await api.conversationSessionStop({ sessionId: activeConversationSessionId }).catch(() => undefined)
      },
      dispose,
      transport: 'conversation',
      answer,
    },
  }
}

// The content_delta stream is plain text (no ANSI, no prompt chrome), so the
// marker check is a bare line match.
function containsMarkerLine(output: string, marker: string): boolean {
  return output.split(/\r?\n/).some((line) => line.trim() === marker)
}

function readQuestions(payload: Record<string, unknown>, requestId: string): GuidedInterviewQuestion[] | null {
  const rawQuestions = payload.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null
  const questions: GuidedInterviewQuestion[] = []
  for (const [index, raw] of rawQuestions.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const record = raw as Record<string, unknown>
    if (typeof record.question !== 'string' || !record.question.trim()) continue
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (!option || typeof option !== 'object' || Array.isArray(option)) return null
            const optionRecord = option as Record<string, unknown>
            if (typeof optionRecord.label !== 'string' || !optionRecord.label.trim()) return null
            return {
              // The label doubles as the answer key: conversation answers are
              // structured (question → label), not keystrokes.
              key: optionRecord.label,
              label: optionRecord.label,
              detail: typeof optionRecord.description === 'string' ? optionRecord.description : '',
              ...(optionRecord.label.includes('(Recommended)') ? { recommended: true } : {}),
            }
          })
          .filter((option): option is NonNullable<typeof option> => option !== null)
      : []
    if (options.length === 0) continue
    questions.push({
      // Distinct per-question ids so the card resets between questions of the
      // same AskUserQuestion call.
      id: `${requestId}:${index}`,
      question: record.question,
      options,
      allowOther: true,
    })
  }
  return questions.length > 0 ? questions : null
}
