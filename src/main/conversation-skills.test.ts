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

test('a chat CLI is told to run skills by name, once, instead of being handed the SKILL.md', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-skills-'))
  const attached: string[] = []
  try {
    const resolve = createConversationSkillsResolver({
      installer: {
        async attach({ skillId }) {
          attached.push(skillId)
          for (const dir of ['.codex', '.grok', '.opencode']) {
            const target = join(workspaceRoot, dir, 'skills', skillId)
            await mkdir(target, { recursive: true })
            await writeFile(join(target, 'SKILL.md'), 'Long instructions that must not be sent.')
          }
          return { ok: true, skillId, targets: [] }
        },
      },
    })
    const skills = [{ id: 'review' }, { id: 'ship-it' }]
    assert.deepEqual(await resolve({ workspaceRoot, mode: 'context', cli: 'codex', skills }), {
      ids: ['review', 'ship-it'],
      invocation: '$review $ship-it',
    })
    // Installed where the CLI reads skills on the first ask, and not again.
    assert.deepEqual(attached, ['review', 'ship-it'])
    assert.deepEqual(await resolve({ workspaceRoot, mode: 'context', cli: 'grok', skills }), {
      ids: ['review', 'ship-it'],
      invocation: '/review /ship-it',
    })
    assert.deepEqual(await resolve({ workspaceRoot, mode: 'context', cli: 'opencode', skills }), {
      ids: ['review', 'ship-it'],
      invocation: 'Use the review and ship-it skills.',
    })
    // Cursor reads the folders other CLIs install into.
    assert.deepEqual(await resolve({ workspaceRoot, mode: 'context', cli: 'cursor', skills: [{ id: 'review' }] }), {
      ids: ['review'],
      invocation: '/review',
    })
    assert.deepEqual(attached, ['review', 'ship-it'])
    // A skill the chat already ran stays attached without being run again.
    assert.deepEqual(
      await resolve({ workspaceRoot, mode: 'context', cli: 'codex', skills, invoked: new Set(['review']) }),
      { ids: ['review', 'ship-it'], invocation: '$ship-it' },
    )
    assert.deepEqual(
      await resolve({ workspaceRoot, mode: 'context', cli: 'codex', skills, invoked: new Set(['review', 'ship-it']) }),
      { ids: ['review', 'ship-it'] },
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a skill the installer cannot place where the CLI reads it is refused by name', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-skills-'))
  try {
    const resolve = createConversationSkillsResolver({
      installer: { attach: async ({ skillId }) => ({ ok: true, skillId, targets: [] }) },
    })
    await assert.rejects(
      resolve({ workspaceRoot, mode: 'context', cli: 'grok', skills: [{ id: 'review' }] }),
      /review.*grok/,
    )
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})

test('a stateful chat opens with the skill invocation once, and later turns go without it', async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'conversation-skills-'))
  const sent: string[] = []
  const mock = createMockConversationProvider({ skills: 'context' })
  const runtime = new ConversationRuntime({
    adapters: [
      {
        ...mock,
        sessions: 'stateful',
        sendTurn(input) {
          sent.push(input.message)
          // The mock completes a `/tools` turn without asking for approval.
          return mock.sendTurn({ ...input, message: '/tools' })
        },
      },
    ],
    getProviderById: () => undefined,
    // The invocation the resolver hands back, for the skills not yet run.
    resolveSkills: async ({ skills, invoked }) => {
      const ids = skills.map((skill) => skill.id)
      const fresh = ids.filter((id) => !invoked?.has(id))
      return { ids, ...(fresh.length ? { invocation: fresh.map((id) => `/${id}`).join(' ') } : {}) }
    },
  })
  try {
    const key = { workspaceRoot, workspaceId: 'workspace', agentId: 'agent' }
    const session = await runtime.startSession({ ...key, providerId: 'mock-provider', modelId: 'mock-model' })
    assert.ok(session.ok)
    const sessionId = session.session.sessionId
    await runtime.sendTurn({ sessionId, message: 'Fix the flaky test', skills: [{ id: 'review' }] })
    await runtime.sendTurn({ sessionId, message: 'Now push it', skills: [{ id: 'review' }] })
    await runtime.sendTurn({ sessionId, message: 'And document it', skills: [{ id: 'review' }, { id: 'docs' }] })
    assert.deepEqual(sent, ['/review\n\nFix the flaky test', 'Now push it', '/docs\n\nAnd document it'])
  } finally {
    await runtime.shutdown()
    await rm(workspaceRoot, { recursive: true, force: true })
  }
})
