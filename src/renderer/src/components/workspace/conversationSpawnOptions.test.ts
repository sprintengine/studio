import assert from 'node:assert/strict'

import {
  conversationAgentRuntimePatch,
  conversationLaunchDraftPatch,
  conversationLaunchEnginePatch,
  conversationNewChatSeed,
} from './conversationSpawnOptions'
import { test } from 'vitest'

test('the spawn patch opts the agent into the conversation runtime and clears every terminal field', () => {
  const patch = conversationAgentRuntimePatch('claude-agent', 'opus[1m]')
  assert.equal(patch.runtimeKind, 'conversation')
  assert.deepEqual(patch.conversation, { providerId: 'claude-agent', modelId: 'opus[1m]' })
  assert.equal(patch.cliStartRequested, false, 'no terminal start is requested')
  assert.equal('cliSessionId' in patch && patch.cliSessionId, undefined, 'no terminal session id is assigned')
  assert.equal(patch.cli, undefined, 'no CLI session is selected for a chat agent')
  assert.equal(patch.cliStartupPrompt, undefined, 'no terminal startup prompt is queued')
})

test('the launch prompt becomes the chat’s first message, not a composer draft', () => {
  assert.deepEqual(conversationLaunchDraftPatch([{ id: 'review' }, { id: 'tests' }], 'Check this change'), {
    conversationSkills: ['review', 'tests'],
    chatStartupPrompt: 'Check this change',
  })
  assert.deepEqual(
    conversationLaunchDraftPatch([{ id: 'review' }], '   '),
    { conversationSkills: ['review'] },
    'a skill-only launch sends nothing',
  )
})

test('the engine patch carries the picker’s permission preset and effort', () => {
  assert.deepEqual(conversationLaunchEnginePatch({ permissionPreset: 'bypass', reasoning: 'high' }), {
    cliPermissionPreset: 'bypass',
    conversationReasoningEffort: 'high',
  })
  assert.deepEqual(
    conversationLaunchEnginePatch({ permissionPreset: 'none', reasoning: null }),
    { cliPermissionPreset: 'none' },
    'the CLI’s own default effort names none',
  )
})

test('a New chat door opens the picked CLI model as a chat, named like a terminal agent', () => {
  const picked = conversationNewChatSeed(
    {
      provider: { providerId: 'codex-agent', modelId: 'gpt-6-sol', modelLabel: 'GPT-6 Sol' },
      skills: [{ id: 'review' }],
      reasoning: 'xhigh',
    },
    { prompt: 'hi', permissionPreset: 'bypass' },
  )
  assert.deepEqual(picked?.runtime, { providerId: 'codex-agent', modelId: 'gpt-6-sol' })
  assert.deepEqual(picked?.agentPatch.conversation, { providerId: 'codex-agent', modelId: 'gpt-6-sol' })
  assert.equal(picked?.agentPatch.chatStartupPrompt, 'hi')
  assert.deepEqual(picked?.agentPatch.conversationSkills, ['review'])
  assert.equal(picked?.agentPatch.cliPermissionPreset, 'bypass')
  assert.equal(picked?.agentPatch.conversationReasoningEffort, 'xhigh')
  assert.equal(
    'name' in (picked?.agentPatch ?? {}),
    false,
    'the seed names nothing: the workspace names the agent from the pool, never after its model',
  )
  assert.equal(conversationNewChatSeed({}, { permissionPreset: 'none' }), null, 'no provider, nothing to open')
})
