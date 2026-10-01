import { afterEach, expect, test } from 'vitest'
import { Model, TabNode, TabSetNode } from 'flexlayout-react'

import type { ConversationForkInput } from '../../../../../shared/conversation-runtime'
import { defaultAgent } from '../../../../../shared/agent-state'
import type { AgentState, Workspace } from '../../../types/workspace'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useToastStore } from '../../../store/toastStore'
import { addAgentTabAfter, registerModel, unregisterModel } from '../../../utils/modelRegistry'
import { composerDraftStore } from './draftStore'
import { forkChat, forkName, forkedAgentPatch } from './forkFromHere'

const WS = 'fork-from-here-ws'
const root = '/Users/dev/app-worktree'

// The chat forked from: a Claude chat in a worktree, with its own engine settings.
const parent: AgentState = {
  ...defaultAgent('parent', 'Atlas'),
  runtimeKind: 'conversation',
  conversation: { providerId: 'claude-agent', modelId: 'opus' },
  cliPermissionPreset: 'auto',
  cliPermissionMode: 'acceptEdits',
  conversationReasoningEffort: 'high',
  conversationSkills: ['review'],
  execution: { mode: 'worktree', worktreeId: null, cwd: root },
}

function setup(answer: { ok: true } | { ok: false; message: string } = { ok: true }) {
  const storage = new Map<string, string>()
  Object.assign(globalThis, {
    window: {
      setTimeout: () => 0,
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
        removeItem: (key: string) => void storage.delete(key),
      },
    },
  })
  useWorkspaceStore.setState({
    workspaces: [
      { id: WS, name: 'App', agents: { parent, other: defaultAgent('other', 'Iris') } } as unknown as Workspace,
    ],
  })
  const model = Model.fromJson({
    global: {},
    borders: [],
    layout: {
      type: 'row',
      children: [
        {
          type: 'tabset',
          children: [
            { type: 'tab', name: 'Atlas', component: 'agent', config: { agentId: 'parent' } },
            { type: 'tab', name: 'Iris', component: 'agent', config: { agentId: 'other' } },
          ],
        },
      ],
    },
  })
  registerModel(WS, model)
  const forks: ConversationForkInput[] = []
  const transport = {
    fork: async (input: ConversationForkInput) => {
      forks.push(input)
      return answer
    },
  }
  return { model, forks, transport, key: { workspaceRoot: root, workspaceId: WS, agentId: 'parent' } }
}

afterEach(() => {
  unregisterModel(WS)
  delete (globalThis as { window?: unknown }).window
})

const tabsOf = (model: Model) => {
  const tabset = model.getRootRow()!.getChildren()[0] as TabSetNode
  return {
    agents: tabset.getChildren().map((tab) => ((tab as TabNode).getConfig() as { agentId: string }).agentId),
    selected: tabset.getSelected(),
  }
}

test('a fork opens beside the chat it came from, as its twin, with the message forked before in its composer', async () => {
  const t = setup()
  await forkChat({
    transport: t.transport,
    key: t.key,
    target: { side: 'user', turnSeq: 4, draft: { text: 'try again', skillIds: ['review'], mentions: [] } },
  })
  expect(t.forks).toHaveLength(1)
  const [asked] = t.forks
  expect(asked).toMatchObject({ key: t.key, side: 'user', turnSeq: 4, title: 'Atlas (fork)' })
  expect(asked.newAgentId).toMatch(/^conversation-claude-agent-/)

  const fork = useWorkspaceStore.getState().workspaces[0].agents[asked.newAgentId]
  expect(fork).toMatchObject({
    name: 'Atlas (fork)',
    runtimeKind: 'conversation',
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    cliPermissionPreset: 'auto',
    cliPermissionMode: 'acceptEdits',
    conversationReasoningEffort: 'high',
    conversationSkills: ['review'],
    execution: { mode: 'worktree', cwd: root },
  })
  expect(composerDraftStore().getState().read(WS, asked.newAgentId).text).toBe('try again')

  // Right after the parent's tab, in its strip, and in front.
  const tabs = tabsOf(t.model)
  expect(tabs.agents).toEqual(['parent', asked.newAgentId, 'other'])
  expect(tabs.selected).toBe(1)
  expect(useToastStore.getState().toasts.at(-1)?.title).toContain('Both chats work in the same files')
})

test('a refused fork opens nothing', async () => {
  const t = setup({ ok: false, message: 'Stop the running turn before forking from an earlier message.' })
  await expect(
    forkChat({ transport: t.transport, key: t.key, target: { side: 'assistant', turnId: 'turn_1' } }),
  ).rejects.toThrow('Stop the running turn')
  expect(Object.keys(useWorkspaceStore.getState().workspaces[0].agents)).toEqual(['parent', 'other'])
  expect(tabsOf(t.model).agents).toEqual(['parent', 'other'])
})

test('the fork carries the engine, never the parent’s launch-only state', () => {
  const patch = forkedAgentPatch({ ...parent, chatStartupPrompt: 'hello', ownerModuleId: 'module' }, 'Atlas (fork)')
  expect(patch.chatStartupPrompt).toBeUndefined()
  expect(patch.ownerModuleId).toBeUndefined()
  expect(patch.cli).toBeUndefined()
})

test('beside a chat with no tab here, the fork is left to dock the ordinary way', () => {
  const t = setup()
  expect(addAgentTabAfter(WS, 'fork', 'Atlas (fork)', 'closed-chat')).toBe(false)
  expect(tabsOf(t.model).agents).toEqual(['parent', 'other'])
})

test('a fork is named after the chat it came from, numbered past the forks already open', () => {
  expect(forkName('Atlas', ['Atlas', 'Iris'])).toBe('Atlas (fork)')
  expect(forkName('Atlas', ['Atlas', 'Atlas (fork)'])).toBe('Atlas (fork 2)')
  // A fork of a fork is one more fork of the chat it started from.
  expect(forkName('Atlas (fork)', ['Atlas', 'Atlas (fork)'])).toBe('Atlas (fork 2)')
  expect(forkName('Atlas (fork 2)', ['Atlas', 'Atlas (fork)', 'Atlas (fork 2)'])).toBe('Atlas (fork 3)')
})
