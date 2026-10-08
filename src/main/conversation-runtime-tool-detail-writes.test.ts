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
