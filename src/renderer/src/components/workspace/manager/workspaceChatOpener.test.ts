import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import type { AgentState } from '../../../types/workspace'
import { createWorkspaceChatOpener, type WorkspaceChatOpenerDeps } from './workspaceChatOpener'

type Recorded = {
  writes: Array<{ workspaceId: string; agentId: string; patch: Partial<AgentState> }>
  drafts: Array<{ workspaceId: string; agentId: string; draft: { text: string; skillIds: string[] } }>
  ensured: Array<{ root: string; skillIds: string[] }>
  reveals: Array<{ workspaceId: string; agentId: string; name: string }>
}

function setup(overrides: Partial<WorkspaceChatOpenerDeps> = {}) {
  const recorded: Recorded = { writes: [], drafts: [], ensured: [], reveals: [] }
  const opener = createWorkspaceChatOpener({
    getWorkspace: (id): ReturnType<WorkspaceChatOpenerDeps['getWorkspace']> =>
      id === 'ws-project'
        ? { folderPath: '/Users/dev/acme', agents: { a1: { name: 'Ada' } } }
        : id === 'ws-folderless'
          ? { folderPath: null, agents: {} }
          : null,
    lastSelectedCli: () => 'claude-code',
    permissionPresetFor: () => 'bypass',
    newAgentId: (providerId) => `conversation-${providerId}-abc123`,
    pickName: (taken) => (taken.includes('Ada') ? 'Grace' : 'Ada'),
    writeAgent: (workspaceId, agentId, patch) => recorded.writes.push({ workspaceId, agentId, patch }),
    putDraft: (workspaceId, agentId, draft) => recorded.drafts.push({ workspaceId, agentId, draft }),
    ensureSkills: (root, skillIds) => recorded.ensured.push({ root, skillIds }),
    reveal: (workspaceId, agentId, name) => recorded.reveals.push({ workspaceId, agentId, name }),
    ...overrides,
  })
  return { opener, recorded }
}

describe('the workspace chat opener behind RendererHost.openChat', () => {
  test('seeds a chat agent owned by the module into the named workspace, with the prompt as a draft', async () => {
    const { opener, recorded } = setup()
    const result = await opener({
      moduleId: 'planner',
      workspaceId: 'ws-project',
      prompt: '  Plan the release  ',
      skills: ['release-notes', 'release-notes', ' '],
    })
    assert.deepEqual(result, { ok: true, agentId: 'conversation-claude-agent-abc123' })

    assert.equal(recorded.writes.length, 1)
    const { workspaceId, agentId, patch } = recorded.writes[0]!
    assert.equal(workspaceId, 'ws-project')
    assert.equal(agentId, 'conversation-claude-agent-abc123')
    assert.equal(patch.ownerModuleId, 'planner')
    assert.equal(patch.name, 'Grace', 'named from the pool, avoiding names the workspace has')
    assert.equal(patch.runtimeKind, 'conversation')
    assert.deepEqual(patch.conversation, { providerId: 'claude-agent', modelId: 'default' })
    assert.equal(patch.cliPermissionPreset, 'bypass')
    assert.deepEqual(patch.conversationSkills, ['release-notes'])
    assert.equal(patch.chatStartupPrompt, undefined, 'a draft is not sent')

    assert.deepEqual(recorded.drafts, [
      { workspaceId: 'ws-project', agentId, draft: { text: 'Plan the release', skillIds: ['release-notes'] } },
    ])
    assert.deepEqual(recorded.ensured, [{ root: '/Users/dev/acme', skillIds: ['release-notes'] }])
    assert.deepEqual(recorded.reveals, [{ workspaceId: 'ws-project', agentId, name: 'Grace' }])
  })

  test('send: true makes the prompt the chat’s first message, on the CLI and model asked for', async () => {
    const { opener, recorded } = setup()
    const result = await opener({
      moduleId: 'planner',
      workspaceId: 'ws-project',
      prompt: 'Summarise the diff',
      cli: 'codex',
      model: 'gpt-5-codex',
      send: true,
    })
    assert.equal(result.ok, true)
    const patch = recorded.writes[0]!.patch
    assert.deepEqual(patch.conversation, { providerId: 'codex-agent', modelId: 'gpt-5-codex' })
    assert.equal(patch.chatStartupPrompt, 'Summarise the diff')
    assert.deepEqual(recorded.drafts, [])
    assert.deepEqual(recorded.ensured, [], 'no skills asked for, none ensured')
  })

  test('refuses an unknown workspace, a folderless one, and a CLI with no chat runtime — writing nothing', async () => {
    const { opener, recorded } = setup()
    const unknown = await opener({ moduleId: 'planner', workspaceId: 'ws-gone' })
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.equal(unknown.code, 'unknown_workspace')

    const folderless = await opener({ moduleId: 'planner', workspaceId: 'ws-folderless' })
    assert.equal(folderless.ok, false)
    if (!folderless.ok) assert.equal(folderless.code, 'workspace_folder_missing')

    const notChat = await opener({ moduleId: 'planner', workspaceId: 'ws-project', cli: 'gemini' })
    assert.equal(notChat.ok, false)
    if (!notChat.ok) assert.equal(notChat.code, 'cli_not_conversational')

    const noneChosen = await setup({ lastSelectedCli: () => null }).opener({
      moduleId: 'planner',
      workspaceId: 'ws-project',
    })
    assert.equal(noneChosen.ok, false)
    if (!noneChosen.ok) assert.equal(noneChosen.code, 'cli_not_conversational')

    assert.deepEqual(recorded, { writes: [], drafts: [], ensured: [], reveals: [] })
  })

  test('a name titles the chat, and a dedupeKey is kept on it', async () => {
    const { opener, recorded } = setup()
    const result = await opener({
      moduleId: 'radar',
      workspaceId: 'ws-project',
      prompt: 'Why is CI red?',
      name: '  Fix CI on acme/app#12 ',
      dedupeKey: 'acme/app#12',
    })
    assert.deepEqual(result, { ok: true, agentId: 'conversation-claude-agent-abc123' })
    const patch = recorded.writes[0]!.patch
    assert.equal(patch.name, 'Fix CI on acme/app#12')
    assert.equal(patch.moduleChatKey, 'acme/app#12')
    assert.equal(recorded.reveals[0]!.name, 'Fix CI on acme/app#12')
  })

  test('a dedupeKey this module opened a chat under focuses that chat and changes nothing in it', async () => {
    const agents = {
      a1: { name: 'Ada' },
      mine: { name: 'Fix CI', ownerModuleId: 'radar', moduleChatKey: 'acme/app#12' },
      theirs: { name: 'Other', ownerModuleId: 'calendar', moduleChatKey: 'acme/app#12' },
    }
    const { opener, recorded } = setup({
      getWorkspace: (id) => (id === 'ws-project' ? { folderPath: '/Users/dev/acme', agents } : null),
    })
    const again = await opener({
      moduleId: 'radar',
      workspaceId: 'ws-project',
      prompt: 'Why is CI red?',
      send: true,
      dedupeKey: 'acme/app#12',
    })
    assert.deepEqual(again, { ok: true, agentId: 'mine', existing: true })
    assert.deepEqual(recorded.reveals, [{ workspaceId: 'ws-project', agentId: 'mine', name: 'Fix CI' }])
    assert.deepEqual(recorded.writes, [], 'nothing written, nothing sent')
    assert.deepEqual(recorded.drafts, [], 'the person’s draft is left alone')

    // Another module's key is not this one's: it opens a chat of its own.
    const other = await opener({ moduleId: 'planner', workspaceId: 'ws-project', dedupeKey: 'acme/app#12' })
    assert.equal(other.ok && other.existing, undefined)
    assert.equal(recorded.writes.length, 1)
  })

  test('a name or key that is not a string, or too long, is refused before anything is written', async () => {
    const { opener, recorded } = setup()
    for (const input of [{ name: 3 }, { name: 'x'.repeat(121) }, { dedupeKey: {} }, { dedupeKey: 'k'.repeat(201) }]) {
      const result = await opener({ moduleId: 'planner', workspaceId: 'ws-project', ...(input as object) })
      assert.equal(!result.ok && result.code, 'invalid_input')
    }
    assert.deepEqual(recorded, { writes: [], drafts: [], ensured: [], reveals: [] })
  })
})
