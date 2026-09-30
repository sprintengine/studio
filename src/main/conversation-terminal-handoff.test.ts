import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { ConversationSessionActionResult } from '../shared/conversation-runtime'
import type { ConversationTerminalHandoffTarget } from './conversation-runtime'
import {
  createConversationTerminalHandoff,
  terminalLaunchRequest,
  type ConversationTerminalHandoffDeps,
} from './conversation-terminal-handoff'

const TARGET: ConversationTerminalHandoffTarget = {
  workspaceId: 'ws-1',
  agentId: 'chat-1',
  providerId: 'claude-agent',
  modelId: 'claude-opus-5-5',
  workspaceRoot: '/repo/.worktrees/chat-1',
  providerSessionId: '5d1c2a3e-provider',
  permissionPreset: 'auto',
}

const SUSPENDED = { ok: true, session: {} } as unknown as ConversationSessionActionResult

function harness(
  options: {
    target?: ConversationTerminalHandoffTarget | { refused: string }
    suspend?: ConversationSessionActionResult
    launch?: AgentLaunchResult
    cliResumesSessions?: (cli: string) => boolean
  } = {},
) {
  const steps: string[] = []
  const launches: AgentLaunchRequest[] = []
  const notices: string[] = []
  const deps: ConversationTerminalHandoffDeps = {
    runtime: {
      terminalHandoffTarget: async () => {
        steps.push('target')
        const target = options.target ?? TARGET
        return 'refused' in target ? { ok: false, message: target.refused } : { ok: true, target }
      },
      suspendSession: async () => {
        steps.push('suspend')
        return options.suspend ?? SUSPENDED
      },
      noteTerminalHandoff: async ({ notice }) => {
        steps.push('note')
        notices.push(notice)
      },
    },
    launch: async (request) => {
      steps.push('launch')
      launches.push(request)
      return (
        options.launch ?? {
          ok: true,
          workspaceId: request.workspaceId,
          agentId: 'agent-claude-code-abc123',
          sessionId: 'terminal-1',
          cli: request.cli ?? '',
          executionId: 'terminal-1',
        }
      )
    },
    cliResumesSessions: options.cliResumesSessions ?? (() => true),
    permissionPresetsForCli: () => ['none', 'manual', 'auto', 'bypass'],
    chatName: () => 'Fix the login bug',
  }
  return { handoff: createConversationTerminalHandoff(deps).handoff, steps, launches, notices }
}

test('the chat is suspended before the terminal opens its session, and told afterwards', async () => {
  const app = harness()
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), {
    ok: true,
    workspaceId: 'ws-1',
    agentId: 'agent-claude-code-abc123',
  })
  assert.deepEqual(app.steps, ['target', 'suspend', 'launch', 'note'])
  assert.deepEqual(app.launches, [
    {
      workspaceId: 'ws-1',
      cli: 'claude-code',
      cwd: '/repo/.worktrees/chat-1',
      resumeCliSessionId: '5d1c2a3e-provider',
      name: 'Fix the login bug (terminal)',
      permissionPreset: 'auto',
      cliModel: 'claude-opus-5-5',
    },
  ])
  assert.match(app.notices[0] ?? '', /continues in a terminal/)
})

test("a chat's refusal reaches the person, and nothing is suspended or launched", async () => {
  const app = harness({ target: { refused: 'The agent is still working.' } })
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), { ok: false, message: 'The agent is still working.' })
  assert.deepEqual(app.steps, ['target'])
})

test('a chat whose CLI cannot resume in a terminal is refused before it is suspended', async () => {
  const cursor = harness({ target: { ...TARGET, providerId: 'cursor-agent' }, cliResumesSessions: () => false })
  assert.equal((await cursor.handoff({ sessionId: 'conv-1' })).ok, false)
  assert.deepEqual(cursor.steps, ['target'])

  const mock = harness({ target: { ...TARGET, providerId: 'mock-provider' } })
  assert.equal((await mock.handoff({ sessionId: 'conv-1' })).ok, false, 'a provider with no CLI has nothing to resume')
  assert.deepEqual(mock.steps, ['target'])
})

test('a launch that fails leaves the chat suspended, not told it moved', async () => {
  const app = harness({ launch: { ok: false, code: 'agent_spawn_failed', message: 'claude was not found.' } })
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), { ok: false, message: 'claude was not found.' })
  assert.deepEqual(app.steps, ['target', 'suspend', 'launch'])
})

test("the terminal runs on the chat's machine, and takes its mode only where the CLI has it", () => {
  const request = terminalLaunchRequest(
    {
      ...TARGET,
      providerId: 'codex-agent',
      modelId: 'default',
      permissionPreset: 'manual',
      cliRuntimes: { codex: { hostId: 'wsl:Ubuntu' } },
    },
    'codex',
    { terminalPresets: ['none', 'bypass'], chatName: null },
  )
  assert.deepEqual(request, {
    workspaceId: 'ws-1',
    cli: 'codex',
    cwd: '/repo/.worktrees/chat-1',
    resumeCliSessionId: '5d1c2a3e-provider',
    host: 'wsl:Ubuntu',
  })
})
