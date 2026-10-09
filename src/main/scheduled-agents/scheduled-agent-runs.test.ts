import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { emptyAgentLaunchSettings } from '../../shared/launch-settings'
import type { ConversationSessionSummary, ConversationSubscribeInput } from '../../shared/conversation-runtime'
import {
  scheduledAgentTitle,
  validateScheduledAgentDraft,
  type ScheduledAgent,
  type ScheduledAgentDraft,
  type ScheduledAgentRun,
  type ScheduledAgentView,
} from '../../shared/scheduled-agents'
import { createConversationLaunchService, type ConversationLaunchRequest } from '../conversation-launch-service'
import {
  createConversationModuleRegistry,
  type ModuleConversationWorkspace,
} from '../module-host/module-conversation-service'
import { runScheduledAgent } from './runner'
import { createScheduledAgentsScheduler } from './scheduler'
import { createScheduledAgentsModuleRegistry, createScheduledAgentsService } from './service'
import { createScheduledAgentsStore } from './store'

// What a scheduled agent's creator can tell about it and its runs: a name the
// sidebar shows, a tag each run's chat carries, the chat each run started, and
// a word each time one does.

// Wednesday 30 September 2026, 12:10 UTC.
const NOW = Date.UTC(2026, 8, 30, 12, 10)

function draft(overrides: Partial<ScheduledAgentDraft> = {}): ScheduledAgentDraft {
  return {
    prompt: 'Triage the issues opened since the last run.',
    schedule: { cron: '0 13 * * *', timezone: 'UTC' },
    folderPath: '/Users/dev/acme',
    hostId: null,
    cli: 'claude-code',
    cliModel: null,
    permissionPreset: null,
    skills: [],
    mcpServers: [],
    worktree: null,
    ...overrides,
  }
}

function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sprintengine-scheduled-agent-runs-'))
  return { path: join(dir, 'scheduled-agents.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('a name is the sidebar’s title, and the prompt’s first line is when there is none', () => {
  assert.equal(scheduledAgentTitle('Triage\nthe rest', '#240 Fix login — weekdays 09:30'), '#240 Fix login — weekdays 09:30')
  assert.equal(scheduledAgentTitle('Triage\nthe rest', '  '), 'Triage')
  assert.equal(scheduledAgentTitle('Triage\nthe rest'), 'Triage')
})

test('a draft’s name and tag are trimmed text of a bounded length, absent when not named', () => {
  const named = validateScheduledAgentDraft({ ...draft(), name: ' Morning triage ', tag: 'backlog/240.md' }, NOW)
  assert.ok(named.ok)
  assert.equal(named.draft.name, 'Morning triage')
  assert.equal(named.draft.tag, 'backlog/240.md')
  const plain = validateScheduledAgentDraft(draft(), NOW)
  assert.ok(plain.ok)
  assert.equal('name' in plain.draft, false)
  assert.equal('tag' in plain.draft, false)
  const cleared = validateScheduledAgentDraft({ ...draft(), name: null, tag: '' }, NOW)
  assert.ok(cleared.ok)
  assert.equal(cleared.draft.name, '')
  assert.equal(cleared.draft.tag, '')
  for (const bad of [{ name: 3 }, { name: 'x'.repeat(121) }, { tag: {} }, { tag: 't'.repeat(201) }]) {
    assert.equal(validateScheduledAgentDraft({ ...draft(), ...bad }, NOW).ok, false)
  }
})

test('the store keeps a name and tag, an edit without them keeps them, and an empty one clears it', async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    await store.create({ ...draft(), name: 'Morning triage', tag: 'item-240' }, 'task-board')
    assert.equal(store.get('sa-1')?.name, 'Morning triage')
    // The New chat panel editing it knows nothing of either.
    await store.update('sa-1', draft({ prompt: 'Triage, then label.' }))
    assert.equal(store.get('sa-1')?.name, 'Morning triage')
    assert.equal(store.get('sa-1')?.tag, 'item-240')
    await store.update('sa-1', { ...draft(), name: '' })
    assert.equal('name' in store.get('sa-1')!, false)
    assert.equal(store.get('sa-1')?.tag, 'item-240')
    await store.recordRun('sa-1', { at: NOW, ok: true, workspaceId: 'w-1', agentId: 'agent-1' })

    const reread = createScheduledAgentsStore({ filePath: file.path, now: () => NOW })
    await reread.load()
    assert.equal(reread.get('sa-1')?.tag, 'item-240')
    assert.deepEqual(reread.get('sa-1')?.lastRun, { at: NOW, ok: true, workspaceId: 'w-1', agentId: 'agent-1' })
    const onDisk = JSON.parse(readFileSync(file.path, 'utf8')) as { agents: ScheduledAgent[] }
    assert.equal('name' in onDisk.agents[0]!, false, 'a cleared name is absent, never empty')
  } finally {
    file.cleanup()
  }
})

test('a run recorded before the chat agent was kept reads back without one', async () => {
  const file = tempFile()
  try {
    writeFileSync(
      file.path,
      JSON.stringify({
        version: 1,
        agents: [
          {
            ...draft(),
            id: 'sa-old',
            ownerModuleId: null,
            createdAt: NOW,
            updatedAt: NOW,
            lastRun: { at: NOW, ok: true, workspaceId: 'w-old' },
            lastFailureSeenAt: null,
          },
        ],
      }),
    )
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW })
    await store.load()
    assert.deepEqual(store.get('sa-old')?.lastRun, { at: NOW, ok: true, workspaceId: 'w-old' })
  } finally {
    file.cleanup()
  }
})

test('a run carries the schedule’s owner and tag onto its chat, and names the chat it started', async () => {
  const requests: ConversationLaunchRequest[] = []
  const run = await runScheduledAgent(
    {
      ...draft(),
      tag: 'item-240',
      id: 'sa-1',
      ownerModuleId: 'task-board',
      createdAt: NOW,
      updatedAt: NOW,
      lastRun: null,
      lastFailureSeenAt: null,
    },
    {
      launchConversation: async (request) => {
        requests.push(request)
        return {
          ok: true,
          workspaceId: 'w-9',
          agentId: 'agent-claude-code-x',
          name: 'n',
          cli: 'claude-code',
          providerId: 'claude-agent',
          modelId: 'default',
          sessionId: 's',
        }
      },
      getRepoRoot: async () => null,
      createWorktree: async () => ({ ok: false, message: 'unused' }),
      now: () => NOW,
    },
  )
  assert.deepEqual(run, { at: NOW, ok: true, workspaceId: 'w-9', agentId: 'agent-claude-code-x' })
  assert.equal(requests[0]?.ownerModuleId, 'task-board')
  assert.equal(requests[0]?.scheduledAgentId, 'sa-1')
  assert.equal(requests[0]?.scheduledAgentTag, 'item-240')
})

test('onRun hears each run that started a chat, and an extension hears only its own', async () => {
  const file = tempFile()
  try {
    let id = 0
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => `sa-${++id}` })
    await store.load()
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'w', agentId: 'a' }),
      recordRun: (entry, run) => store.recordRun(entry, run),
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    const service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    const registry = createScheduledAgentsModuleRegistry(service, () => [])
    const mine = await registry.create('task-board', { ...draft(), tag: 'item-240' })
    const theirs = await registry.create('insights', draft())
    assert.ok(mine.ok && theirs.ok)

    const heard: Array<[ScheduledAgentView, ScheduledAgentRun]> = []
    const all: string[] = []
    const stop = registry.onRun('task-board', (agent, run) => heard.push([agent, run]))
    service.onRun((agent) => all.push(agent.id))

    const started = { at: NOW, ok: true as const, workspaceId: 'w-1', agentId: 'agent-1' }
    service.notifyRan(store.get(mine.agent.id)!, started)
    service.notifyRan(store.get(theirs.agent.id)!, { ...started, agentId: 'agent-2' })
    // A run that failed, or one with no chat agent named, is no run to tell of.
    service.notifyRan(store.get(mine.agent.id)!, { at: NOW, ok: false, message: 'not signed in' })
    service.notifyRan(store.get(mine.agent.id)!, { at: NOW, ok: true, workspaceId: 'w-1' })

    assert.equal(heard.length, 1)
    assert.deepEqual(heard[0]![1], { at: NOW, workspaceId: 'w-1', agentId: 'agent-1' })
    assert.equal(heard[0]![0].tag, 'item-240')
    assert.deepEqual(heard[0]![0].lastRun, started, 'the agent as it ran')
    assert.deepEqual(all, [mine.agent.id, theirs.agent.id])

    stop()
    service.notifyRan(store.get(mine.agent.id)!, started)
    assert.equal(heard.length, 1)
  } finally {
    file.cleanup()
  }
})

test('runNow tells onRun too, through the scheduler’s report', async () => {
  const file = tempFile()
  try {
    const store = createScheduledAgentsStore({ filePath: file.path, now: () => NOW, newId: () => 'sa-1' })
    await store.load()
    let service: ReturnType<typeof createScheduledAgentsService> | null = null
    const scheduler = createScheduledAgentsScheduler({
      list: () => store.list(),
      run: async () => ({ at: NOW, ok: true, workspaceId: 'w-run', agentId: 'agent-run' }),
      recordRun: (entry, run) => store.recordRun(entry, run),
      // As the scheduled agents module wires it: told before anything closes.
      onRan: (agent, run) => service?.notifyRan(agent, run),
      now: () => NOW,
      setTimer: () => null,
      clearTimer: () => undefined,
    })
    service = createScheduledAgentsService({ store, scheduler, now: () => NOW })
    const registry = createScheduledAgentsModuleRegistry(service, () => [])
    const created = await registry.create('task-board', draft())
    assert.ok(created.ok)
    const runs: ScheduledAgentRun[] = []
    registry.onRun('task-board', (_agent, run) => runs.push(run))
    const ran = await registry.runNow('task-board', created.agent.id)
    assert.ok(ran.ok)
    assert.deepEqual(runs, [{ at: NOW, workspaceId: 'w-run', agentId: 'agent-run' }])
  } finally {
    file.cleanup()
  }
})

test('a scheduled run’s chat is the schedule owner’s: listed with its schedule and tag, and followed', async () => {
  const workspaces: ModuleConversationWorkspace[] = [{ id: 'ws-1', folderPath: '/Users/dev/acme', agents: {} }]
  const sessions: ConversationSessionSummary[] = []
  const workspaceListeners = new Set<() => void>()
  const launch = createConversationLaunchService({
    getWorkspace: (id) => workspaces.find((workspace) => workspace.id === id) ?? null,
    getLaunchSettings: () => emptyAgentLaunchSettings(),
    writeAgent: () => ({ ok: true }),
    listWorkspaces: () => workspaces,
    createWorkspace: (request) => {
      const id = `ws-run-${workspaces.length}`
      workspaces.push({
        id,
        folderPath: request.folderPath,
        ...(request.scheduledAgentId ? { scheduledAgentId: request.scheduledAgentId } : {}),
        agents: { ...(request.agents ?? {}) },
      })
      for (const listener of workspaceListeners) listener()
      return { ok: true, workspaceId: id }
    },
    removeWorkspace: () => undefined,
    startSession: async (input) => {
      const summary: ConversationSessionSummary = {
        sessionId: `conv_${sessions.length + 1}`,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        providerId: input.providerId,
        modelId: input.modelId,
        status: 'ready',
        createdAt: 1,
        updatedAt: 1,
      }
      sessions.push(summary)
      return { ok: true, session: summary }
    },
    send: async () => ({ ok: true }) as never,
    newAgentSuffix: () => 'run1',
  })
  const follows: ConversationSubscribeInput[] = []
  const conversations = createConversationModuleRegistry({
    launch: (request) => launch.launch(request),
    runtime: {
      startSession: async () => ({ ok: false, message: 'unused' }),
      sendTurn: async () => ({ ok: false, message: 'unused' }),
      interrupt: async () => ({ ok: false, message: 'unused' }),
      respondToRequest: async () => ({ ok: false, message: 'unused' }),
      setPermission: async () => ({ ok: false, message: 'unused' }),
      setModel: async () => ({ ok: false, message: 'unused' }),
      stopSession: async () => ({ ok: false, message: 'unused' }),
      listSessions: (input = {}) => ({
        ok: true,
        sessions: sessions.filter(
          (entry) =>
            (!input.workspaceId || entry.workspaceId === input.workspaceId) &&
            (!input.agentId || entry.agentId === input.agentId),
        ),
      }),
      readTranscript: async () => ({ ok: true, events: [] }),
      onEvent: () => () => undefined,
    },
    follow: (input) => {
      follows.push(input)
      return { dispose: () => undefined, ready: Promise.resolve() }
    },
    writeAgent: () => ({ ok: true }),
    getWorkspaceAgents: () => workspaces,
    getModulePermissions: () => ['conversation:read'],
    onWorkspacesChanged: (listener) => {
      workspaceListeners.add(listener)
      return () => workspaceListeners.delete(listener)
    },
  })

  const run = await runScheduledAgent(
    {
      ...draft(),
      tag: 'item-240',
      id: 'sa-7',
      ownerModuleId: 'task-board',
      createdAt: NOW,
      updatedAt: NOW,
      lastRun: null,
      lastFailureSeenAt: null,
    },
    {
      launchConversation: (request) => launch.launch(request),
      getRepoRoot: async () => null,
      createWorktree: async () => ({ ok: false, message: 'unused' }),
      now: () => NOW,
    },
  )
  assert.ok(run.ok && run.agentId)
  const board = conversations.forModule('task-board')
  const listed = board.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.workspaceId, run.workspaceId)
  assert.equal(listed[0]!.agentId, run.agentId)
  assert.equal(listed[0]!.scheduledAgentId, 'sa-7')
  assert.equal(listed[0]!.scheduledAgentTag, 'item-240')
  assert.deepEqual(conversations.forModule('insights').list(), [], 'no other module reaches it')

  board.follow({ workspaceId: run.workspaceId, agentId: run.agentId }, undefined, () => undefined)
  assert.deepEqual(follows[0]?.key, {
    workspaceRoot: '/Users/dev/acme',
    workspaceId: run.workspaceId,
    agentId: run.agentId,
  })
})
