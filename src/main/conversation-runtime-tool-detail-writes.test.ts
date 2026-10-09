import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, vi } from 'vitest'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationToolDetail } from '../shared/conversation-runtime'

const detailWrites = vi.hoisted(() => [] as { path: string; output: unknown }[])

vi.mock('./conversation-tool-details', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversation-tool-details')>()
  return {
    ...actual,
    writeToolDetail: async (workspaceRoot: string, filePath: string, value: ConversationToolDetail) => {
      detailWrites.push({ path: filePath, output: value.output })
      await actual.writeToolDetail(workspaceRoot, filePath, value)
    },
  }
})

const PARTIALS = 200

test('a running tool re-sent whole on every update is written a couple of times, ending on the final output', async () => {
  detailWrites.length = 0
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-tool-detail-writes-'))
  const mock = createMockConversationProvider()
  const lines = Array.from({ length: PARTIALS }, (_, index) => `line ${index} `.repeat(40))
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          const base = { sessionId: input.sessionId, workspaceId: input.workspaceId, agentId: input.agentId }
          const event = (type: 'turn_started' | 'tool_started' | 'tool_output', payload: Record<string, unknown>) => ({
            ...base,
            id: '',
            providerId: input.providerId,
            modelId: input.modelId,
            type,
            createdAt: 0,
            payload: { turnId: input.turnId, ...payload },
          })
          return [
            event('turn_started', {}),
            event('tool_started', { toolUseId: 'run', name: 'Bash', kind: 'command', input: { command: 'npm test' } }),
            // The whole output so far, as a list of text blocks, every time.
            ...lines.map((_, index) =>
              event('tool_output', { toolUseId: 'run', output: lines.slice(0, index + 1), partial: true }),
            ),
            event('tool_output', { toolUseId: 'run', output: lines, status: 'success' }),
          ]
        },
      },
    ],
    getProviderById: () => undefined,
  })
  try {
    const started = await runtime.startSession({
      workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      providerId: 'mock-provider',
      modelId: 'mock-model',
    })
    assert.ok(started.ok)
    const sessionId = started.session.sessionId
    assert.equal((await runtime.sendTurn({ sessionId, message: 'test' })).ok, true)
    const read = () =>
      runtime.getToolDetail({ workspaceRoot, workspaceId: 'workspace', agentId: 'agent', toolUseId: 'run' })
    const turnRunning = () => {
      const listed = runtime.listSessions({ workspaceId: 'workspace' })
      return !listed.ok || listed.sessions[0]?.status === 'active'
    }
    for (let i = 0; i < 500 && (turnRunning() || detailWrites.length === 0); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const detail = await read()
    assert.ok(detail.ok)
    assert.deepEqual(detail.detail.output, lines, 'the file ends on the final output')
    assert.deepEqual(detail.detail.input, { command: 'npm test' })
    // The start, one or two catch-up writes for the running output, the end.
    assert.ok(detailWrites.length <= 5, `${detailWrites.length} detail writes for ${PARTIALS} updates`)
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

/**
 * A runtime whose one turn starts a tool, sends two versions of its output,
 * and then holds until `release` is called. Its window is long, so a detail
 * on disk with the newest output got there through a flush, not the clock.
 */
async function heldToolTurn() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-tool-detail-window-'))
  const mock = createMockConversationProvider()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  let sawSecond!: () => void
  const second = new Promise<void>((resolve) => (sawSecond = resolve))
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        async *sendTurn(input) {
          const base = { sessionId: input.sessionId, workspaceId: input.workspaceId, agentId: input.agentId }
          const event = (type: 'turn_started' | 'tool_started' | 'tool_output', payload: Record<string, unknown>) => ({
            ...base,
            id: '',
            providerId: input.providerId,
            modelId: input.modelId,
            type,
            createdAt: 0,
            payload: { turnId: input.turnId, ...payload },
          })
          yield event('turn_started', {})
          yield event('tool_started', {
            toolUseId: 'run',
            name: 'Bash',
            kind: 'command',
            input: { command: 'npm test' },
          })
          yield event('tool_output', { toolUseId: 'run', output: 'first version', partial: true })
          yield event('tool_output', { toolUseId: 'run', output: 'second version', partial: true })
          await held
          yield event('tool_output', { toolUseId: 'run', output: 'final version', status: 'success' })
        },
      },
    ],
    getProviderById: () => undefined,
    toolPreviewIntervalMs: 0,
    toolDetailWriteWindowMs: 60_000,
  })
  runtime.onEvent((event) => {
    if (event.type === 'tool_output' && event.payload?.output === 'second version') sawSecond()
  })
  const started = await runtime.startSession({
    workspaceRoot,
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'mock-provider',
    modelId: 'mock-model',
  })
  assert.ok(started.ok)
  // Not awaited: the send may answer only once the held turn has run.
  const sent = runtime.sendTurn({ sessionId: started.session.sessionId, message: 'test' })
  await second
  return { workspaceRoot, runtime, release, sent }
}

test('a detail read while a tool streams has its newest output, though its write is still in its window', async () => {
  detailWrites.length = 0
  const f = await heldToolTurn()
  try {
    const detail = await f.runtime.getToolDetail({
      workspaceRoot: f.workspaceRoot,
      workspaceId: 'workspace',
      agentId: 'agent',
      toolUseId: 'run',
    })
    assert.ok(detail.ok)
    assert.equal(detail.detail.output, 'second version')
    assert.equal(detailWrites.filter((write) => write.output === 'first version').length, 0, 'the two collapsed')
  } finally {
    f.release()
    await f.runtime.shutdown()
    await rm(f.workspaceRoot, { recursive: true, force: true })
  }
})

test('a shutdown mid-stream writes the output still waiting out its window', async () => {
  detailWrites.length = 0
  const f = await heldToolTurn()
  try {
    assert.equal(
      detailWrites.some((write) => write.output === 'second version'),
      false,
      'held by the window until now',
    )
    await f.runtime.shutdown()
    assert.equal(detailWrites.at(-1)?.output, 'second version')
  } finally {
    f.release()
    await rm(f.workspaceRoot, { recursive: true, force: true })
  }
})
