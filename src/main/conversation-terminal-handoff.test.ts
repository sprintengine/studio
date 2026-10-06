import assert from 'node:assert/strict'
import { test } from 'vitest'

import type { AgentLaunchRequest, AgentLaunchResult } from '../shared/agent-launch'
import type { ConversationTerminalHandoffTarget } from './conversation-runtime'
import { defaultAgent } from '../shared/agent-state'
import type { ConversationSessionSummary, ConversationStartSessionInput } from '../shared/conversation-runtime'
import {
  chatHandoffStart,
  createConversationTerminalHandoff,
  handoffNotice,
  terminalLaunchRequest,
  type ConversationTerminalHandoffDeps,
  type TerminalHandoffStopped,
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

function harness(
  options: {
    target?: ConversationTerminalHandoffTarget | { refused: string }
    stop?: { ok: true; stopped: TerminalHandoffStopped } | { ok: false; message: string }
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
      stopForTerminalHandoff: async () => {
        steps.push('stop')
        return options.stop ?? { ok: true, stopped: { turn: false, agents: 0 } }
      },
      endTerminalHandoff: () => {
        steps.push('end')
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

test('the chat is stopped and suspended before the terminal opens its session, and told afterwards', async () => {
  const app = harness()
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), {
    ok: true,
    workspaceId: 'ws-1',
    agentId: 'agent-claude-code-abc123',
  })
  assert.deepEqual(app.steps, ['target', 'stop', 'launch', 'note', 'end'])
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
  assert.match(app.notices[0] ?? '', /^This conversation continues in a terminal/)
})

test('a chat stopped mid-turn hands over all the same, and its notice says the agent was stopped', async () => {
  const app = harness({ stop: { ok: true, stopped: { turn: true, agents: 0 } } })
  assert.equal((await app.handoff({ sessionId: 'conv-1' })).ok, true)
  assert.deepEqual(app.steps, ['target', 'stop', 'launch', 'note', 'end'])
  assert.match(app.notices[0] ?? '', /^The agent was stopped, so this conversation could continue in a terminal\./)
})

test('the notice names the agents a handoff stopped with the chat', () => {
  assert.match(handoffNotice({ turn: true, agents: 2 }), /^The agent was stopped, with the 2 agents it started,/)
  assert.match(handoffNotice({ turn: false, agents: 1 }), /^The agent this chat started was stopped,/)
})

test('a chat that could not be stopped is not handed over, and sends are let through again', async () => {
  const app = harness({ stop: { ok: false, message: 'Conversation provider is unavailable.' } })
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), {
    ok: false,
    message: 'Conversation provider is unavailable.',
  })
  assert.deepEqual(app.steps, ['target', 'stop', 'end'])
})

test("a chat's refusal reaches the person, and nothing is stopped or launched", async () => {
  const refused = 'This chat has no CLI session yet. Send it a message first.'
  const app = harness({ target: { refused } })
  assert.deepEqual(await app.handoff({ sessionId: 'conv-1' }), { ok: false, message: refused })
  assert.deepEqual(app.steps, ['target'])
})

test('a chat whose CLI cannot resume in a terminal is refused before it is stopped', async () => {
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
  assert.deepEqual(app.steps, ['target', 'stop', 'launch', 'end'])
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

const summary = (sessionId: string, status: ConversationSessionSummary['status'], updatedAt: number) =>
  ({
    sessionId,
    workspaceId: 'ws-1',
    agentId: 'chat-1',
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
    status,
    createdAt: 0,
    updatedAt,
  }) satisfies ConversationSessionSummary

test('a chat named by its identity is handed over through the session it is running', async () => {
  const asked: string[] = []
  const deps = {
    runtime: {
      terminalHandoffTarget: async (input: { sessionId: string }) => {
        asked.push(input.sessionId)
        return { ok: true as const, target: TARGET }
      },
      stopForTerminalHandoff: async () => ({ ok: true as const, stopped: { turn: false, agents: 0 } }),
      endTerminalHandoff: () => undefined,
      noteTerminalHandoff: async () => undefined,
      listSessions: () => ({
        ok: true as const,
        sessions: [summary('old', 'stopped', 9), summary('current', 'ready', 5), summary('older', 'ready', 1)],
      }),
      startSession: async () => {
        throw new Error('a chat with a session running is not started again')
      },
    },
    launch: async (request: AgentLaunchRequest) => ({
      ok: true as const,
      workspaceId: request.workspaceId,
      agentId: 'agent-claude-code-abc123',
      sessionId: 'terminal-1',
      cli: request.cli ?? '',
      executionId: 'terminal-1',
    }),
    cliResumesSessions: () => true,
  } satisfies ConversationTerminalHandoffDeps
  assert.equal(
    (await createConversationTerminalHandoff(deps).handoff({ workspaceId: 'ws-1', agentId: 'chat-1' })).ok,
    true,
  )
  assert.deepEqual(asked, ['current'])
})

test('a chat with no session since the app started is started from its record, then handed over', async () => {
  const started: ConversationStartSessionInput[] = []
  const asked: string[] = []
  const start: ConversationStartSessionInput = {
    workspaceRoot: '/repo',
    workspaceId: 'ws-1',
    agentId: 'chat-1',
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
  }
  const deps: ConversationTerminalHandoffDeps = {
    runtime: {
      terminalHandoffTarget: async (input) => {
        asked.push(input.sessionId)
        return { ok: true, target: TARGET }
      },
      stopForTerminalHandoff: async () => ({ ok: true, stopped: { turn: false, agents: 0 } }),
      endTerminalHandoff: () => undefined,
      noteTerminalHandoff: async () => undefined,
      listSessions: () => ({ ok: true, sessions: [summary('old', 'stopped', 9)] }),
      startSession: async (input) => {
        started.push(input)
        return { ok: true, session: summary('fresh', 'ready', 10) }
      },
    },
    launch: async (request) => ({
      ok: true,
      workspaceId: request.workspaceId,
      agentId: 'agent-claude-code-abc123',
      sessionId: 'terminal-1',
      cli: request.cli ?? '',
      executionId: 'terminal-1',
    }),
    cliResumesSessions: () => true,
    chatStart: () => start,
  }
  const { handoff } = createConversationTerminalHandoff(deps)
  assert.equal((await handoff({ workspaceId: 'ws-1', agentId: 'chat-1' })).ok, true)
  assert.deepEqual(started, [start])
  assert.deepEqual(asked, ['fresh'])

  // No record to start it from: said in words, nothing started.
  const none = createConversationTerminalHandoff({ ...deps, chatStart: () => null })
  assert.deepEqual(await none.handoff({ workspaceId: 'ws-1', agentId: 'gone' }), {
    ok: false,
    message: 'This chat has no CLI session yet. Send it a message first.',
  })
})

test('a session started for a handoff that is then refused is put back to rest; a CLI that cannot resume starts nothing', async () => {
  const started: string[] = []
  const suspended: string[] = []
  const start: ConversationStartSessionInput = {
    workspaceRoot: '/repo',
    workspaceId: 'ws-1',
    agentId: 'chat-1',
    providerId: 'claude-agent',
    modelId: 'claude-opus-5-5',
  }
  const deps: ConversationTerminalHandoffDeps = {
    runtime: {
      // A chat rewound with Edit from here has no CLI session to resume.
      terminalHandoffTarget: async () => ({ ok: false, message: 'This chat was rewound.' }),
      stopForTerminalHandoff: async () => ({ ok: true, stopped: { turn: false, agents: 0 } }),
      endTerminalHandoff: () => undefined,
      noteTerminalHandoff: async () => undefined,
      listSessions: () => ({ ok: true, sessions: [] }),
      startSession: async (input) => {
        started.push(input.agentId)
        return { ok: true, session: summary('fresh', 'ready', 10) }
      },
      suspendSession: async (input) => {
        suspended.push(input.sessionId)
      },
    },
    launch: async () => {
      throw new Error('nothing is launched for a refused handoff')
    },
    cliResumesSessions: () => true,
    chatStart: () => start,
  }
  assert.deepEqual(await createConversationTerminalHandoff(deps).handoff({ workspaceId: 'ws-1', agentId: 'chat-1' }), {
    ok: false,
    message: 'This chat was rewound.',
  })
  assert.deepEqual(suspended, ['fresh'], 'the session started for it is suspended again')

  started.length = 0
  const noResume = createConversationTerminalHandoff({ ...deps, cliResumesSessions: () => false })
  assert.equal((await noResume.handoff({ workspaceId: 'ws-1', agentId: 'chat-1' })).ok, false)
  assert.deepEqual(started, [], 'nothing was started for a CLI a terminal cannot resume')
})

test("a chat's start for a handoff is its record's: worktree, engine, preset and the WSL machine's CLI", () => {
  const agent = {
    ...defaultAgent('chat-1', 'Atlas'),
    runtimeKind: 'conversation' as const,
    conversation: { providerId: 'claude-agent', modelId: 'opus' },
    cliPermissionPreset: 'auto' as const,
    cliPermissionMode: 'acceptEdits',
    execution: { mode: 'worktree' as const, worktreeId: null, cwd: '/home/dev/app-worktree' },
  }
  const workspace = { id: 'ws-1', folderPath: '/home/dev/app', hostId: 'wsl:Ubuntu', agents: { 'chat-1': agent } }
  const start = chatHandoffStart(workspace, 'chat-1', { cliRuntimes: {}, hosts: {} })
  assert.equal(start?.workspaceRoot, '/home/dev/app-worktree')
  assert.equal(start?.providerId, 'claude-agent')
  assert.equal(start?.modelId, 'opus')
  assert.equal(start?.permissionPreset, 'auto')
  assert.equal(start?.permissionMode, 'acceptEdits')
  assert.equal(start?.cliRuntimes?.['claude-code']?.hostId, 'wsl:Ubuntu')
  // A terminal agent, or a chat the record no longer has, is no chat to start.
  assert.equal(chatHandoffStart(workspace, 'missing', {}), null)
  assert.equal(
    chatHandoffStart({ ...workspace, agents: { 'chat-1': { ...agent, runtimeKind: 'terminal' } } }, 'chat-1', {}),
    null,
  )
})
