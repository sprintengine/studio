import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { createConversationSkillsResolver } from './conversation-skills'
import { ConversationRuntime } from './conversation-runtime'
import { createMockConversationProvider } from './providers/mock-conversation-provider'
import type { ConversationMessage } from './providers/conversation-provider-adapter'

test('context skills inject instructions into model context but persist only identities', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-skills-'))
  let messages: ConversationMessage[] | undefined
  const mock = createMockConversationProvider({ skills: 'context' })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sendTurn(input) {
          messages = input.messages
          return mock.sendTurn(input)
        },
      },
    ],
    getProviderById: () => undefined,
  })
  try {
    const source = join(workspaceRoot, '.agents', 'skills', 'example')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'SKILL.md'), '# Example\nUnique instruction text.')
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const session = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(session.ok)
    await runtime.sendTurn({
      sessionId: session.session.sessionId,
      message: '/tools',
      skills: [{ id: 'example', sourcePath: source }],
    })
    assert.equal(messages?.[0].role, 'system')
    assert.ok(messages?.[0].content.includes('Unique instruction text.'))
    const transcript = await runtime.readTranscript(key)
    assert.ok(transcript.ok)
    assert.equal(JSON.stringify(transcript.events).includes('Unique instruction text.'), false)
    assert.deepEqual(transcript.events.find((event) => event.type === 'user_message')?.payload?.skills, ['example'])
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('skill budgets name the rejected skill and native skills use the workspace installer', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-skills-'))
  try {
    const resolve = createConversationSkillsResolver({
      installer: {
        async attach({ skillId }) {
          const target = join(workspaceRoot, '.claude', 'skills', skillId)
          await mkdir(target, { recursive: true })
          await writeFile(join(target, 'SKILL.md'), 'Native skill')
          return { ok: true, skillId, targets: [] }
        },
      },
    })
    assert.deepEqual(await resolve({ workspaceRoot, mode: 'native', skills: [{ id: 'example' }] }), {
      ids: ['example'],
    })
    const source = join(workspaceRoot, '.claude', 'skills', 'example', 'SKILL.md')
    await writeFile(source, 'x'.repeat(25 * 1024))
    await assert.rejects(
      resolve({ workspaceRoot, mode: 'context', skills: [{ id: 'example', sourcePath: source }] }),
      /example.*24 KB/,
    )
    await writeFile(source, 'x'.repeat(23 * 1024))
    for (const id of ['first', 'second', 'third']) {
      const folder = join(workspaceRoot, '.agents', 'skills', id)
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, 'SKILL.md'), 'x'.repeat(23 * 1024))
    }
    await assert.rejects(
      resolve({
        workspaceRoot,
        mode: 'context',
        skills: ['first', 'second', 'third'].map((id) => ({ id })),
      }),
      /third.*64 KB/,
    )
    await assert.rejects(resolve({ workspaceRoot, mode: 'none', skills: [{ id: 'example' }] }), /does not support/)
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
