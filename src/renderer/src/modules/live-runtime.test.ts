import assert from 'node:assert/strict'

import { createWorkspaceFileWatcher } from './workspace-file-watch'
import { createAgentSessionWatcher } from './agent-session-watch'
import { createModuleAgentSpawner } from './agent-spawn'
import { createRendererHost } from './renderer-host'
import { workspaceWorkingRoot } from '../utils/workspaceWorktree'
import type { Workspace } from '../types/workspace'

// The three live-runtime surfaces (MC-1535), tested through their injected
// ports: file watch (path validation, snapshot-then-debounced-change, missing
// file as null, teardown), session observation (workspace filter, view
// mapping, dedup, callback isolation), and agent spawn (structured failures,
// shared-runtime routing, record-before-spawn ordering, tab focus). Plus the
// host-level contracts: the effective working root (worktree-backed
// workspaces watch/spawn under the worktree, not the primary checkout) and
// the agent-runtime availability gate (named causes for "not wired" vs "the
// Agent Runtime module is disabled").

async function testWorkspaceFileWatch(): Promise<void> {
  const timers: Array<{ cb: () => void }> = []
  const watchCallbacks: Array<(event: { path?: string | null }) => void> = []
  let stopped = 0
  const files = new Map<string, string>([['/repo/state/loop.json', '{"v":1}']])
  const watcher = createWorkspaceFileWatcher({
    resolveFolderPath: (workspaceId) => (workspaceId === 'ws-1' ? '/repo' : null),
    watchPath: async (_path, cb) => {
      watchCallbacks.push(cb)
      return () => {
        stopped += 1
      }
    },
    readFile: async (path) => {
      const content = files.get(path)
      if (content === undefined) throw new Error('ENOENT')
      return content
    },
    setTimer: (cb) => {
      const timer = { cb }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as { cb: () => void })
      if (index >= 0) timers.splice(index, 1)
    },
  })

  // Named causes: absolute paths, traversal, unknown/folderless workspaces.
  await assert.rejects(() => watcher('ws-1', '/etc/passwd', () => {}), /absolute path/)
  await assert.rejects(() => watcher('ws-1', '../outside.json', () => {}), /stay inside the workspace root/)
  await assert.rejects(() => watcher('ws-missing', 'state/loop.json', () => {}), /has no project folder/)

  const events: Array<string | null> = []
  const stop = await watcher('ws-1', 'state/loop.json', (event) => events.push(event.content))
  assert.deepEqual(events, ['{"v":1}'], 'fires once with the current content')

  // A change to a sibling file is filtered out; a change to the watched file
  // debounces then re-reads.
  watchCallbacks[0]!({ path: '/repo/state/other.json' })
  assert.equal(timers.length, 0, 'sibling file events are filtered')
  files.set('/repo/state/loop.json', '{"v":2}')
  watchCallbacks[0]!({ path: '/repo/state/loop.json' })
  watchCallbacks[0]!({ path: '/repo/state/loop.json' })
  assert.equal(timers.length, 1, 'rapid events coalesce into one pending debounce')
  timers[0]!.cb()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['{"v":1}', '{"v":2}'])

  // A deleted file reads as null, never a throw.
  files.delete('/repo/state/loop.json')
  watchCallbacks[0]!({ path: '/repo/state/loop.json' })
  timers[0]!.cb()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(events, ['{"v":1}', '{"v":2}', null])

  stop()
  assert.equal(stopped, 1, 'teardown stops the fs watcher')
}

async function testAgentSessionWatch(): Promise<void> {
  let sessions: Array<Record<string, unknown>> = [
    { sessionId: 's-1', workspaceId: 'ws-1', agentId: 'a-1', agentName: 'Poet', kind: 'agent', processAlive: true, agentSession: { system: 'sprintengine', executionId: 'run-1' } },
    { sessionId: 's-2', workspaceId: 'ws-2', kind: 'terminal', processAlive: true },
  ]
  const listeners = new Set<() => void>()
  const watcher = createAgentSessionWatcher({
    getSessions: () => sessions as never,
    subscribe: (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  })

  const emissions: unknown[] = []
  const stop = watcher('ws-1', (views) => emissions.push(views))
  assert.deepEqual(emissions, [[{
    sessionId: 's-1',
    agentId: 'a-1',
    name: 'Poet',
    kind: 'agent',
    system: 'sprintengine',
    executionId: 'run-1',
    isLive: true,
  }]], 'fires once with the workspace-filtered snapshot')

  // A change in ANOTHER workspace does not re-fire (deduped by view signature).
  sessions = [...sessions, { sessionId: 's-3', workspaceId: 'ws-2', kind: 'terminal', processAlive: true }]
  listeners.forEach((cb) => cb())
  assert.equal(emissions.length, 1)

  // Liveness flips re-fire with the updated view.
  sessions = sessions.map((s) => (s.sessionId === 's-1' ? { ...s, processAlive: false } : s))
  listeners.forEach((cb) => cb())
  assert.equal(emissions.length, 2)
  assert.equal((emissions[1] as Array<{ isLive: boolean }>)[0]!.isLive, false)

  stop()
  assert.equal(listeners.size, 0, 'unsubscribe detaches from the store')

  // No workspace id = every workspace, narrowed to the caller's own agent-id
  // namespaces. That narrowing is the whole reason the unscoped mode is
  // answerable: without it, a module would be watching the machine.
  sessions = [
    { sessionId: 's-1', workspaceId: 'ws-1', agentId: 'review-guide-abc', agentName: 'Review guide', kind: 'agent', processAlive: true },
    { sessionId: 's-2', workspaceId: 'ws-2', agentId: 'review-guide-def', agentName: 'Review guide', kind: 'agent', processAlive: true },
    { sessionId: 's-3', workspaceId: 'ws-2', agentId: 'agent-someone-else', agentName: 'Poet', kind: 'agent', processAlive: true },
    { sessionId: 's-4', workspaceId: 'ws-1', kind: 'terminal', processAlive: true },
  ]
  const mine: unknown[] = []
  const stopMine = watcher(undefined, (views) => mine.push(views), { agentIdPrefixes: ['review-guide-'] })
  assert.deepEqual(
    (mine[0] as Array<{ sessionId: string }>).map((view) => view.sessionId),
    ['s-1', 's-2'],
    'an unscoped watch crosses workspaces but stays inside the module\'s namespaces',
  )
  stopMine()

  const none: unknown[] = []
  const stopNone = watcher(undefined, (views) => none.push(views))
  assert.deepEqual(none, [[]], 'a module that claimed no namespace sees nothing, not everything')
  stopNone()
}

async function testAgentSpawn(): Promise<void> {
  const upserts: Array<{ workspaceId: string; agentId: string; patch: unknown }> = []
  const removals: Array<{ workspaceId: string; agentId: string }> = []
  const spawns: Array<Record<string, unknown>> = []
  const reveals: Array<{ workspaceId: string; agentId: string; name: string }> = []
  let spawnOk = true
  let defaultCliId: string | null = 'claude'
  const spawner = createModuleAgentSpawner({
    getWorkspace: (workspaceId) =>
      workspaceId === 'ws-1'
        ? { folderPath: '/repo', agents: [{ id: 'agent-poet', name: 'Poet' }] }
        : workspaceId === 'ws-folderless'
          ? { folderPath: null, agents: [] }
          : null,
    upsertAgent: (workspaceId, agentId, patch) => upserts.push({ workspaceId, agentId, patch }),
    removeAgent: (workspaceId, agentId) => removals.push({ workspaceId, agentId }),
    spawnTerminal: async (input) => {
      spawns.push(input as never)
      return spawnOk ? { ok: true } : { ok: false, message: 'no pty' }
    },
    revealAgentTab: (workspaceId, agentId, name) => reveals.push({ workspaceId, agentId, name }),
    focusFileTab: (workspaceId, absolutePath) => workspaceId === 'ws-1' && absolutePath === '/repo/notes/plan.md',
    listRuntimes: () => [{ id: 'claude', label: 'Claude Code', available: true, models: [], isDefault: true }],
    defaultCli: () => defaultCliId,
    pickAgentName: () => 'Sailor',
    newAgentId: () => 'agent-new',
    newSessionId: () => 'session-new',
  })

  // Structured failures, never throws.
  assert.deepEqual((await spawner.spawnAgent({ workspaceId: 'ws-x' })).ok, false)
  assert.equal((await spawner.spawnAgent({ workspaceId: 'ws-x' }) as { code: string }).code, 'unknown_workspace')
  assert.equal((await spawner.spawnAgent({ workspaceId: 'ws-folderless' }) as { code: string }).code, 'missing_folder')
  assert.equal(
    (await spawner.spawnAgent({ workspaceId: 'ws-1', cli: 'not-installed' }) as { code: string }).code,
    'unknown_runtime',
  )

  // Happy path: record first, spawn through the shared runtime, focus the tab.
  const result = await spawner.spawnAgent({ workspaceId: 'ws-1', prompt: 'Say hello' })
  assert.deepEqual(result, { ok: true, agentId: 'agent-new' })
  assert.deepEqual(upserts, [{ workspaceId: 'ws-1', agentId: 'agent-new', patch: { name: 'Sailor', cli: 'claude', cliModel: undefined } }])
  assert.deepEqual(spawns, [{
    sessionId: 'session-new',
    cwd: '/repo',
    cli: 'claude',
    prompt: 'Say hello',
    workspaceId: 'ws-1',
    agentId: 'agent-new',
    cliModel: undefined,
  }])
  assert.deepEqual(reveals, [{ workspaceId: 'ws-1', agentId: 'agent-new', name: 'Sailor' }])

  // focus: false skips the reveal; a failed spawn reports spawn_failed AND
  // rolls the pre-spawn agent record back (no persisted ghost).
  await spawner.spawnAgent({ workspaceId: 'ws-1', focus: false })
  assert.equal(reveals.length, 1)
  spawnOk = false
  assert.equal((await spawner.spawnAgent({ workspaceId: 'ws-1' }) as { code: string }).code, 'spawn_failed')
  assert.deepEqual(removals, [{ workspaceId: 'ws-1', agentId: 'agent-new' }])
  spawnOk = true

  // An unavailable last-used CLI falls back to an available runtime rather
  // than failing a pick-free spawn.
  defaultCliId = 'not-installed'
  const fallback = await spawner.spawnAgent({ workspaceId: 'ws-1', focus: false })
  assert.equal(fallback.ok, true)
  assert.equal((spawns[spawns.length - 1] as { cli: string }).cli, 'claude')
  defaultCliId = 'claude'

  // focusTab: workspace-relative file paths only; escapes refuse. Agent tabs
  // require an EXISTING agent and reveal under its real display name.
  assert.equal(spawner.focusTab({ workspaceId: 'ws-1', kind: 'file', id: 'notes/plan.md' }), true)
  assert.equal(spawner.focusTab({ workspaceId: 'ws-1', kind: 'file', id: '/etc/passwd' }), false)
  assert.equal(spawner.focusTab({ workspaceId: 'ws-1', kind: 'file', id: '../escape.md' }), false)
  assert.equal(spawner.focusTab({ workspaceId: 'ws-1', kind: 'agent', id: 'agent-poet' }), true)
  assert.equal(reveals[reveals.length - 1]!.name, 'Poet', 'reveals under the display name, not the id')
  assert.equal(spawner.focusTab({ workspaceId: 'ws-1', kind: 'agent', id: 'agent-ghost' }), false)

  assert.deepEqual(spawner.listAgentRuntimes(), [
    { id: 'claude', label: 'Claude Code', available: true, models: [], isDefault: true },
  ])
}

type WorkingRootInput = Pick<Workspace, 'folderPath' | 'worktree' | 'sprintEngineState'>

const worktreeBackedWorkspace: WorkingRootInput = {
  folderPath: '/Users/example/project',
  worktree: null,
  sprintEngineState: {
    vcs: {
      mode: 'run_worktree',
      worktreePath: '.multi-code/sprintengine/auth/worktree',
      branchName: 'sprintengine/auth',
    },
  } as unknown as Workspace['sprintEngineState'],
}

async function testEffectiveWorkingRoot(): Promise<void> {
  // Worktree-backed sprint workspace: live work happens under the worktree.
  assert.equal(
    workspaceWorkingRoot(worktreeBackedWorkspace),
    '/Users/example/project/.multi-code/sprintengine/auth/worktree'
  )
  // Plain workspace: the primary checkout IS the working root.
  assert.equal(
    workspaceWorkingRoot({ folderPath: '/Users/example/project', worktree: null, sprintEngineState: null }),
    '/Users/example/project'
  )
  // Folderless: null, never a fallback.
  assert.equal(workspaceWorkingRoot({ folderPath: null, worktree: null, sprintEngineState: null }), null)

  // File watch resolves workspace-relative paths against the working root, so
  // a worktree-backed workspace's watch attaches under the worktree — the same
  // resolver modules/index.ts wires as the watcher's resolveFolderPath.
  const watchedPaths: string[] = []
  const watcher = createWorkspaceFileWatcher({
    resolveFolderPath: () => workspaceWorkingRoot(worktreeBackedWorkspace),
    watchPath: async (path) => {
      watchedPaths.push(path)
      return () => {}
    },
    readFile: async () => '{}',
  })
  const stop = await watcher('ws-1', 'state/loop.json', () => {})
  assert.equal(
    watchedPaths[0],
    '/Users/example/project/.multi-code/sprintengine/auth/worktree/state',
    'the watch attaches under the worktree, not the primary checkout'
  )
  stop()
}

async function testAgentRuntimeGate(): Promise<void> {
  const kernel = createRendererHost()
  const host = kernel.hostFor('test-module')

  // Unwired backends (early boot, tests): named "not wired" causes.
  await assert.rejects(() => host.watchWorkspaceFile('ws-1', 'a.json', () => {}), /has not wired/)
  assert.throws(() => host.watchAgentSessions('ws-1', () => {}), /has not wired/)
  await assert.rejects(() => host.spawnAgent({ workspaceId: 'ws-1' }), /has not wired/)
  assert.throws(() => host.focusTab({ workspaceId: 'ws-1', kind: 'agent', id: 'a-1' }), /has not wired/)
  assert.throws(() => host.listAgentRuntimes(), /has not wired/)
  assert.equal(await host.getWorkingRoot('ws-1'), null, 'working root resolves null before wiring, never a throw')

  // Wire minimal live backends.
  const sessionEmitters = new Set<() => void>()
  kernel.setWorkspaceFileWatcher(async (_workspaceId, relativePath, cb) => {
    cb({ relativePath, content: '{}' })
    return () => {}
  })
  const watchScopes: Array<string | undefined> = []
  const watchPrefixes: Array<readonly string[] | undefined> = []
  kernel.setAgentSessionWatcher((workspaceId, cb, scope) => {
    watchScopes.push(workspaceId)
    watchPrefixes.push(scope?.agentIdPrefixes)
    const emit = (): void => cb([])
    sessionEmitters.add(emit)
    emit()
    return () => sessionEmitters.delete(emit)
  })
  kernel.setAgentSpawner({
    spawnAgent: async () => ({ ok: true, agentId: 'agent-1' }),
    focusTab: () => true,
    listAgentRuntimes: () => [
      { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus' }], isDefault: true },
    ],
  })
  kernel.setWorkingRootResolver((workspaceId) => (workspaceId === 'ws-1' ? '/repo' : null))

  // Disabled Agent Runtime module: every live-runtime method refuses with the
  // named cause — a module author can tell this apart from an unwired shell.
  let agentRuntimeEnabled = false
  kernel.setModuleEnablementResolver(() => agentRuntimeEnabled)
  await assert.rejects(() => host.watchWorkspaceFile('ws-1', 'a.json', () => {}), /Agent Runtime module is disabled/)
  assert.throws(() => host.watchAgentSessions('ws-1', () => {}), /Agent Runtime module is disabled/)
  await assert.rejects(() => host.spawnAgent({ workspaceId: 'ws-1' }), /Agent Runtime module is disabled/)
  assert.throws(() => host.focusTab({ workspaceId: 'ws-1', kind: 'agent', id: 'a-1' }), /Agent Runtime module is disabled/)
  assert.throws(() => host.listAgentRuntimes(), /Agent Runtime module is disabled/)

  // Enabled: calls route through to the backends, and an active session watch
  // stops delivering the moment the module is disabled (live per-delivery
  // gate, the Backlog watcher pattern).
  agentRuntimeEnabled = true
  const deliveries: unknown[] = []
  const stopSessions = host.watchAgentSessions('ws-1', (views) => deliveries.push(views))
  assert.equal(deliveries.length, 1, 'fires once with the current snapshot')
  agentRuntimeEnabled = false
  sessionEmitters.forEach((emit) => emit())
  assert.equal(deliveries.length, 1, 'a disabled module stops receiving deliveries')
  agentRuntimeEnabled = true
  stopSessions()
  assert.equal(await host.getWorkingRoot('ws-1'), '/repo')
  assert.equal((await host.spawnAgent({ workspaceId: 'ws-1' })).ok, true)
  assert.deepEqual(host.listAgentRuntimes(), [
    { id: 'claude', label: 'Claude Code', available: true, models: [{ id: 'opus', label: 'Opus' }], isDefault: true },
  ])

  // The kernel — not the module — decides which prefixes an unscoped watch
  // sees: they come from this module's own registrations, so a module cannot
  // name someone else's.
  kernel.hostFor('test-module').registerAgentIdNamespace({ prefix: 'test-guide-', label: 'Test' })
  kernel.hostFor('other-module').registerAgentIdNamespace({ prefix: 'other-guide-', label: 'Other' })
  host.watchAgentSessions(undefined, () => {})()
  assert.equal(watchScopes.at(-1), undefined, 'an unscoped watch passes no workspace through')
  assert.deepEqual(watchPrefixes.at(-1), ['test-guide-'], 'and exactly the calling module\'s prefixes')
  host.watchAgentSessions('ws-1', () => {})()
  assert.equal(watchPrefixes.at(-1), undefined, 'a workspace-scoped watch is not namespace-narrowed')
}

async function main(): Promise<void> {
  await testWorkspaceFileWatch()
  await testAgentSessionWatch()
  await testAgentSpawn()
  await testEffectiveWorkingRoot()
  await testAgentRuntimeGate()
  console.log('live-runtime surfaces guard passed')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
