import assert from 'node:assert/strict'

import type { ConversationEvent, ConversationStartSessionInput } from '../../../../../shared/conversation-runtime'
import {
  GUIDED_BRIEF_ALLOWED_TOOLS,
  guidedBriefConversationAgentId,
  startGuidedBriefConversationSession,
  type GuidedBriefConversationApi,
} from './conversationSessionAdapter'
import {
  designSystemArtifactsValid,
  frontendDesignArtifactsValid,
  isAgentQuiet,
  isStageReady,
  stageChipState,
  type StageLiveStatus,
} from './stageReadiness'
import type { GuidedInterviewState } from './interviewProtocol'

async function main(): Promise<void> {
  testAllowedToolsExcludeInteractiveTools()
  await testFreshStartSendsPromptAndDetectsMarker()
  await testQuestionCardMappingAndStructuredAnswer()
  await testMultiQuestionCallsAnswerSequentiallyThenRespondOnce()
  await testNonQuestionApprovalsAutoRespond()
  await testLiveSessionIsAdoptedInsteadOfDuplicated()
  await testResumeSendsContinuationInsteadOfPrompt()
  testStageReadinessTruthTable()

  console.log('conversationSessionAdapter tests passed')
}

// MC-1503: readiness = validated artifacts AND a quiet agent, with the marker
// demoted to a re-validation trigger (never an input). This covers the
// live-status × artifact-state truth table the stage machine consumes.
function testStageReadinessTruthTable(): void {
  // Liveness → quiet. idle/absent (session ended) are quiet; a working agent or
  // one holding a pending question/approval, or a failed agent, are not.
  const quietByStatus: Record<StageLiveStatus, boolean> = {
    idle: true,
    absent: true,
    working: false,
    'needs-input': false,
    failed: false,
  }
  for (const [status, expected] of Object.entries(quietByStatus) as [StageLiveStatus, boolean][]) {
    assert.equal(isAgentQuiet(status), expected, `isAgentQuiet(${status})`)
  }

  // frontend-design contract: a page AND a non-empty UI direction. A page alone
  // no longer counts (intended change from the old mockupsAvailable rule).
  assert.equal(frontendDesignArtifactsValid({ pageCount: 1, uiDirectionNonEmpty: true }), true)
  assert.equal(frontendDesignArtifactsValid({ pageCount: 2, uiDirectionNonEmpty: false }), false, 'page alone ⇒ not valid')
  assert.equal(frontendDesignArtifactsValid({ pageCount: 0, uiDirectionNonEmpty: true }), false, 'direction alone ⇒ not valid')
  assert.equal(frontendDesignArtifactsValid({ pageCount: 0, uiDirectionNonEmpty: false }), false)

  // design-system contract: manifest parses AND lint clean. A marker over a
  // broken bundle (lint fails) or a deleted manifest never validates.
  assert.equal(designSystemArtifactsValid({ manifestParses: true, lintClean: true }), true)
  assert.equal(designSystemArtifactsValid({ manifestParses: true, lintClean: false }), false, 'lint findings ⇒ not valid')
  assert.equal(designSystemArtifactsValid({ manifestParses: false, lintClean: false }), false, 'missing/broken manifest ⇒ not valid')

  // Stage flip combines the two. Ready only on validated artifacts AND quiet.
  assert.equal(isStageReady({ artifactsValid: true, agentQuiet: true }), true)
  assert.equal(isStageReady({ artifactsValid: true, agentQuiet: false }), false, 'valid but mid-write ⇒ not ready')
  assert.equal(isStageReady({ artifactsValid: false, agentQuiet: true }), false, 'quiet but no artifacts ⇒ not ready')

  // AC1 end-to-end shape: a lint-clean bundle + quiet agent flips; the same
  // bundle with lint findings does NOT, even though the agent is quiet (the
  // marker-with-invalid-bundle case) and a mid-write quiet-false never flips.
  const dsReady = (input: { manifestParses: boolean; lintClean: boolean }, status: StageLiveStatus): boolean =>
    isStageReady({ artifactsValid: designSystemArtifactsValid(input), agentQuiet: isAgentQuiet(status) })
  assert.equal(dsReady({ manifestParses: true, lintClean: true }, 'idle'), true)
  assert.equal(dsReady({ manifestParses: true, lintClean: false }, 'idle'), false, 'marker over broken bundle ⇒ not ready')
  assert.equal(dsReady({ manifestParses: false, lintClean: false }, 'idle'), false, 'deleted manifest ⇒ not ready')
  assert.equal(dsReady({ manifestParses: true, lintClean: true }, 'working'), false, 'lint-clean but still writing ⇒ not ready')
  assert.equal(dsReady({ manifestParses: true, lintClean: true }, 'needs-input'), false, 'pending question ⇒ not ready')

  // AC3 end-to-end shape for frontend-design: page + direction while quiet ⇒
  // ready; a page alone while quiet ⇒ not ready.
  const feReady = (input: { pageCount: number; uiDirectionNonEmpty: boolean }, status: StageLiveStatus): boolean =>
    isStageReady({ artifactsValid: frontendDesignArtifactsValid(input), agentQuiet: isAgentQuiet(status) })
  assert.equal(feReady({ pageCount: 1, uiDirectionNonEmpty: true }, 'idle'), true)
  assert.equal(feReady({ pageCount: 1, uiDirectionNonEmpty: false }, 'idle'), false, 'page alone ⇒ not ready')

  // Header chip state: ready wins over live status; otherwise 1:1 with the live
  // status, idle/absent folding into the resting idle chip.
  assert.equal(stageChipState('working', true), 'ready', 'ready flip wins')
  assert.equal(stageChipState('working', false), 'working')
  assert.equal(stageChipState('needs-input', false), 'needs-input')
  assert.equal(stageChipState('failed', false), 'failed')
  assert.equal(stageChipState('idle', false), 'idle')
  assert.equal(stageChipState('absent', false), 'idle')
}

type FakeApi = {
  api: GuidedBriefConversationApi
  pushEvent: (event: Partial<ConversationEvent> & { type: ConversationEvent['type'] }) => void
  startInputs: ConversationStartSessionInput[]
  sentMessages: string[]
  responses: Array<{ requestId: string; approved: boolean; answers?: Record<string, string> }>
  transcriptEvents: ConversationEvent[]
}

let eventSequence = 0

function createFakeApi(): FakeApi {
  const listeners = new Set<(event: ConversationEvent) => void>()
  const startInputs: ConversationStartSessionInput[] = []
  const sentMessages: string[] = []
  const responses: Array<{ requestId: string; approved: boolean; answers?: Record<string, string> }> = []
  const transcriptEvents: ConversationEvent[] = []
  const fake: FakeApi = {
    startInputs,
    sentMessages,
    responses,
    transcriptEvents,
    pushEvent: (event) => {
      const full: ConversationEvent = {
        id: `evt-${++eventSequence}`,
        sessionId: 'conv_1',
        workspaceId: 'ws-1',
        agentId: 'guided-brief-strategist',
        providerId: 'claude-agent',
        modelId: 'sonnet',
        createdAt: eventSequence,
        ...event,
      }
      for (const listener of listeners) listener(full)
    },
    api: {
      conversationSessionStart: async (input) => {
        startInputs.push(input)
        return {
          ok: true,
          session: {
            sessionId: 'conv_1',
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            providerId: input.providerId,
            modelId: input.modelId,
            status: 'ready',
            createdAt: 1,
            updatedAt: 1,
          },
        }
      },
      conversationSessionSendTurn: async (input) => {
        sentMessages.push(input.message)
        return {
          ok: true,
          session: {
            sessionId: input.sessionId,
            workspaceId: 'ws-1',
            agentId: 'guided-brief-strategist',
            providerId: 'claude-agent',
            modelId: 'sonnet',
            status: 'active',
            createdAt: 1,
            updatedAt: 2,
          },
        }
      },
      conversationSessionRespondToRequest: async (input) => {
        responses.push({ requestId: input.requestId, approved: input.approved, answers: input.answers })
        return {
          ok: true,
          session: {
            sessionId: input.sessionId,
            workspaceId: 'ws-1',
            agentId: 'guided-brief-strategist',
            providerId: 'claude-agent',
            modelId: 'sonnet',
            status: 'active',
            createdAt: 1,
            updatedAt: 3,
          },
        }
      },
      conversationSessionStop: async (input) => ({
        ok: true,
        session: {
          sessionId: input.sessionId,
          workspaceId: 'ws-1',
          agentId: 'guided-brief-strategist',
          providerId: 'claude-agent',
          modelId: 'sonnet',
          status: 'stopped',
          createdAt: 1,
          updatedAt: 4,
        },
      }),
      conversationSessionsList: async () => ({ ok: true, sessions: [] }),
      conversationTranscript: async () => ({ ok: true, events: transcriptEvents }),
      onConversationEvent: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
  return fake
}

const STRATEGIST_INPUT = {
  kind: 'strategist' as const,
  workspaceRoot: '/tmp/workspace',
  workspaceId: 'ws-1',
  cli: 'claude-code' as const,
}

function testAllowedToolsExcludeInteractiveTools(): void {
  assert.equal(GUIDED_BRIEF_ALLOWED_TOOLS.includes('AskUserQuestion'), false)
  assert.equal(GUIDED_BRIEF_ALLOWED_TOOLS.includes('ExitPlanMode'), false)
  assert.equal(GUIDED_BRIEF_ALLOWED_TOOLS.includes('Write'), true)
  assert.equal(guidedBriefConversationAgentId({ kind: 'strategist', workspaceRoot: '/x' }), 'guided-brief-strategist')
  assert.equal(
    guidedBriefConversationAgentId({
      kind: 'designer',
      workspaceRoot: '/x',
      designSystem: { bundleDirectoryPath: 'design-system', ideaSeedPath: 'seed.md' },
    }),
    'guided-brief-design-system',
  )
}

async function testFreshStartSendsPromptAndDetectsMarker(): Promise<void> {
  const fake = createFakeApi()
  const markers: string[] = []
  const lifecycles: string[] = []
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
    onMarker: (marker) => markers.push(marker),
    onLifecycle: (state) => lifecycles.push(state),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.session.transport, 'conversation')
  assert.equal(result.session.sessionId, 'conv_1')

  // Session start rides the claude-agent provider with wizard tool allowances.
  assert.equal(fake.startInputs[0]?.providerId, 'claude-agent')
  assert.equal(fake.startInputs[0]?.agentId, 'guided-brief-strategist')
  assert.equal(fake.startInputs[0]?.permissionPreset, 'default')
  assert.deepEqual(fake.startInputs[0]?.allowedTools, GUIDED_BRIEF_ALLOWED_TOOLS)

  // The initial turn carries the AskUserQuestion-protocol prompt.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.sentMessages.length, 1)
  assert.match(fake.sentMessages[0] ?? '', /AskUserQuestion/)
  assert.doesNotMatch(fake.sentMessages[0] ?? '', /GUIDED_QUESTION_BEGIN/)

  // Marker arrives in the clean delta stream, split across chunks.
  fake.pushEvent({ type: 'content_delta', payload: { turnId: 't1', text: 'Brief written.\nBRIEF_' } })
  assert.deepEqual(markers, [])
  fake.pushEvent({ type: 'content_delta', payload: { turnId: 't1', text: 'READY\n' } })
  assert.deepEqual(markers, ['BRIEF_READY'])
  assert.equal(lifecycles.includes('ready'), true)
}

async function testQuestionCardMappingAndStructuredAnswer(): Promise<void> {
  const fake = createFakeApi()
  const interviews: GuidedInterviewState[] = []
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
    onInterview: (state) => interviews.push(state),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  fake.pushEvent({
    type: 'approval_requested',
    payload: {
      turnId: 't1',
      requestId: 'req-1',
      kind: 'question',
      summary: 'Which platform first?',
      questions: [
        {
          question: 'Which platform first?',
          header: 'Platform',
          multiSelect: false,
          allowFreeText: true,
          options: [
            { label: 'Web (Recommended)', description: 'Fastest to ship' },
            { label: 'iOS', description: 'App Store reach' },
          ],
        },
      ],
    },
  })
  const pending = interviews.at(-1)
  assert.equal(pending?.currentQuestion?.question, 'Which platform first?')
  assert.equal(pending?.currentQuestion?.options[0]?.key, 'Web (Recommended)')
  assert.equal(pending?.currentQuestion?.options[0]?.recommended, true)
  assert.equal(pending?.currentQuestion?.allowOther, true)

  // Structured answer goes through respond-to-request with the answers map.
  const answered = await result.session.answer?.('Web (Recommended)')
  assert.equal(answered, true)
  assert.deepEqual(fake.responses[0], {
    requestId: 'req-1',
    approved: true,
    answers: { 'Which platform first?': 'Web (Recommended)' },
  })

  // Resolution records the decision and clears the card.
  fake.pushEvent({
    type: 'approval_resolved',
    payload: { turnId: 't1', requestId: 'req-1', approved: true, answers: { 'Which platform first?': 'Web (Recommended)' } },
  })
  const resolved = interviews.at(-1)
  assert.equal(resolved?.currentQuestion, null)
  assert.deepEqual(resolved?.decisions, [
    { id: 'req-1:0', question: 'Which platform first?', label: 'Web (Recommended)' },
  ])

  // No pending question → answer is a no-op returning false.
  assert.equal(await result.session.answer?.('again'), false)
}

async function testMultiQuestionCallsAnswerSequentiallyThenRespondOnce(): Promise<void> {
  const fake = createFakeApi()
  const interviews: GuidedInterviewState[] = []
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
    onInterview: (state) => interviews.push(state),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return

  fake.pushEvent({
    type: 'approval_requested',
    payload: {
      turnId: 't1',
      requestId: 'req-multi',
      kind: 'question',
      summary: 'Two things',
      questions: [
        { question: 'Q1?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
        { question: 'Q2?', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] },
      ],
    },
  })
  assert.equal(interviews.at(-1)?.currentQuestion?.question, 'Q1?')

  // First answer advances the card without sending the respond yet.
  assert.equal(await result.session.answer?.('A'), true)
  assert.equal(fake.responses.length, 0, 'respond held until every question is answered')
  assert.equal(interviews.at(-1)?.currentQuestion?.question, 'Q2?')
  assert.notEqual(interviews.at(-1)?.currentQuestion?.id, 'req-multi:0', 'card resets per question')

  // Final answer sends the complete answers map in one respond.
  assert.equal(await result.session.answer?.('D'), true)
  assert.deepEqual(fake.responses[0], {
    requestId: 'req-multi',
    approved: true,
    answers: { 'Q1?': 'A', 'Q2?': 'D' },
  })
}

async function testNonQuestionApprovalsAutoRespond(): Promise<void> {
  const fake = createFakeApi()
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
  })
  assert.equal(result.ok, true)

  // Generic tool approvals are denied (no approval UI in the wizard pane);
  // plan approvals are waved through so the specialist keeps working.
  fake.pushEvent({
    type: 'approval_requested',
    payload: { turnId: 't1', requestId: 'req-tool', kind: 'tool', summary: 'mcp__thing__call' },
  })
  fake.pushEvent({
    type: 'approval_requested',
    payload: { turnId: 't1', requestId: 'req-plan', kind: 'plan', summary: 'The agent proposed a plan.', plan: '## p' },
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(
    fake.responses.map((entry) => ({ requestId: entry.requestId, approved: entry.approved })),
    [
      { requestId: 'req-tool', approved: false },
      { requestId: 'req-plan', approved: true },
    ],
  )
}

async function testLiveSessionIsAdoptedInsteadOfDuplicated(): Promise<void> {
  const fake = createFakeApi()
  fake.api.conversationSessionsList = async () => ({
    ok: true,
    sessions: [
      {
        sessionId: 'conv_live',
        workspaceId: 'ws-1',
        agentId: 'guided-brief-strategist',
        providerId: 'claude-agent',
        modelId: 'sonnet',
        status: 'awaiting_approval',
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  })
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(result.session.sessionId, 'conv_live', 'live session adopted')
  assert.equal(fake.startInputs.length, 0, 'no second session started')
  assert.equal(fake.sentMessages.length, 0, 'no duplicate kick-off turn into a live session')
}

async function testResumeSendsContinuationInsteadOfPrompt(): Promise<void> {
  const fake = createFakeApi()
  fake.transcriptEvents.push(
    {
      id: 'old-1',
      sessionId: 'conv_old',
      workspaceId: 'ws-1',
      agentId: 'guided-brief-strategist',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      type: 'user_message',
      createdAt: 1,
      payload: { turnId: 'old-t1', text: 'original prompt' },
    },
    {
      id: 'old-2',
      sessionId: 'conv_old',
      workspaceId: 'ws-1',
      agentId: 'guided-brief-strategist',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      type: 'content_delta',
      createdAt: 2,
      payload: { turnId: 'old-t1', text: 'Working on the brief…' },
    },
  )
  const result = await startGuidedBriefConversationSession(STRATEGIST_INPUT, {
    conversationApi: fake.api,
  })
  assert.equal(result.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(fake.sentMessages.length, 1)
  assert.match(fake.sentMessages[0] ?? '', /Continue from where you left off/)
  assert.doesNotMatch(fake.sentMessages[0] ?? '', /souls get product/)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
