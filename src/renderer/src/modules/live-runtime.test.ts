import assert from 'node:assert/strict'

import { createWorkspaceFileWatcher } from './workspace-file-watch'
import { createModuleTabFocuser, toModuleChatRuntimeOptions } from './workspace-tabs'
import { createRendererHost } from './renderer-host'
import { workspaceWorkingRoot } from '../utils/workspaceWorktree'
import type { Workspace } from '../types/workspace'
import { test } from 'vitest'

test('live-runtime', async () => {
  // The live-runtime surfaces, tested through their injected ports: file
  // watch (path validation, snapshot-then-debounced-change, missing file as
  // null, teardown), tab focus (chats by agent id, files by relative path) and
  // the chat runtime list. Plus the host-level contracts: the effective working
  // root (worktree-backed workspaces watch under the worktree, not the primary
  // checkout) and the agent-runtime availability gate (named causes for "not
  // wired" vs "the Agent Runtime module is disabled").

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

  async function testTabFocus(): Promise<void> {
    const reveals: Array<{ workspaceId: string; agentId: string; name: string }> = []
    const focus = createModuleTabFocuser({
      getWorkspace: (workspaceId) =>
        workspaceId === 'ws-1'
          ? {
              workingRoot: '/repo',
              agents: [
                { id: 'agent-poet', name: 'Poet', isChat: true },
                { id: 'agent-shell', name: 'Shell', isChat: false },
              ],
            }
          : workspaceId === 'ws-folderless'
            ? { workingRoot: null, agents: [] }
            : null,
      revealAgentTab: (workspaceId, agentId, name) => reveals.push({ workspaceId, agentId, name }),
      focusFileTab: (workspaceId, absolutePath) => workspaceId === 'ws-1' && absolutePath === '/repo/notes/plan.md',
    })

    // Files: workspace-relative paths only; escapes refuse.
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'file', id: 'notes/plan.md' }), true)
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'file', id: '/etc/passwd' }), false)
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'file', id: 'C:\\Windows\\win.ini' }), false)
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'file', id: '../escape.md' }), false)
    assert.equal(focus({ workspaceId: 'ws-folderless', kind: 'file', id: 'notes/plan.md' }), false)
    assert.equal(focus({ workspaceId: 'ws-x', kind: 'file', id: 'notes/plan.md' }), false)

    // Chats: an EXISTING chat, revealed under its real display name. A terminal
    // agent is not a chat, and an unknown id mints no phantom tab.
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'chat', id: 'agent-poet' }), true)
    assert.deepEqual(reveals, [{ workspaceId: 'ws-1', agentId: 'agent-poet', name: 'Poet' }])
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'chat', id: 'agent-shell' }), false)
    assert.equal(focus({ workspaceId: 'ws-1', kind: 'chat', id: 'agent-ghost' }), false)
    assert.equal(focus({ workspaceId: 'ws-x', kind: 'chat', id: 'agent-poet' }), false)
    assert.equal(reveals.length, 1)
  }

  function testChatRuntimeOptions(): void {
    const options = toModuleChatRuntimeOptions(
      [
        {
          value: 'claude-code',
          label: 'Claude Code',
          installed: true,
          modelSelection: { options: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet' }] },
        },
        // No conversation runtime: a chat has nothing to drive it on.
        { value: 'aider', label: 'Aider', installed: true },
        { value: 'codex', label: 'Codex', installed: false },
        { value: 'cursor', label: 'Cursor' },
      ],
      'codex',
    )
    assert.deepEqual(options, [
      {
        id: 'claude-code',
        label: 'Claude Code',
        available: true,
        models: [
          { id: 'opus', label: 'Opus' },
          { id: 'sonnet', label: 'sonnet' },
        ],
        lastSelected: false,
      },
      { id: 'codex', label: 'Codex', available: false, models: [], lastSelected: true },
      { id: 'cursor', label: 'Cursor', available: true, models: [], lastSelected: false },
    ])
  }

  type WorkingRootInput = Pick<Workspace, 'folderPath' | 'worktree' | 'moduleState'>

  const worktreeBackedWorkspace: WorkingRootInput = {
    folderPath: '/Users/example/.sprintengine-worktrees/project/auth',
    worktree: { branch: 'agent/auth' },
    moduleState: undefined,
  }

  async function testEffectiveWorkingRoot(): Promise<void> {
    // Worktree-backed workspace: live work happens under the worktree.
    assert.equal(workspaceWorkingRoot(worktreeBackedWorkspace), '/Users/example/.sprintengine-worktrees/project/auth')
    // Plain workspace: the primary checkout IS the working root.
    assert.equal(
      workspaceWorkingRoot({ folderPath: '/Users/example/project', worktree: null }),
      '/Users/example/project',
    )
    // Folderless: null, never a fallback.
    assert.equal(workspaceWorkingRoot({ folderPath: null, worktree: null }), null)

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
      '/Users/example/.sprintengine-worktrees/project/auth/state',
      'the watch attaches under the worktree, not the primary checkout',
    )
    stop()
  }

  async function testAgentRuntimeGate(): Promise<void> {
    const kernel = createRendererHost()
    const host = kernel.hostFor('test-module')

    // Unwired backends (early boot, tests): named "not wired" causes.
    await assert.rejects(() => host.watchWorkspaceFile('ws-1', 'a.json', () => {}), /has not wired/)
    assert.throws(() => host.focusTab({ workspaceId: 'ws-1', kind: 'chat', id: 'a-1' }), /has not wired/)
    assert.deepEqual(host.listChatRuntimes(), [], 'the chat runtime list reads empty before wiring')
    assert.equal(await host.getWorkingRoot('ws-1'), null, 'working root resolves null before wiring, never a throw')

    // Wire minimal live backends.
    const fileEmitters = new Set<() => void>()
    kernel.setWorkspaceFileWatcher(async (_workspaceId, relativePath, cb) => {
      const emit = (): void => cb({ relativePath, content: '{}' })
      fileEmitters.add(emit)
      emit()
      return () => fileEmitters.delete(emit)
    })
    const focused: string[] = []
    kernel.setTabFocuser((input) => {
      focused.push(`${input.kind}:${input.id}`)
      return true
    })
    kernel.setChatRuntimeSource(() => [
      { id: 'claude-code', label: 'Claude Code', available: true, models: [], lastSelected: true },
    ])
    kernel.setWorkingRootResolver((workspaceId) => (workspaceId === 'ws-1' ? '/repo' : null))

    // Disabled Agent Runtime module: the live-runtime methods refuse with the
    // named cause — a module author can tell this apart from an unwired shell.
    let agentRuntimeEnabled = false
    kernel.setModuleEnablementResolver(() => agentRuntimeEnabled)
    await assert.rejects(() => host.watchWorkspaceFile('ws-1', 'a.json', () => {}), /Agent Runtime module is disabled/)
    assert.throws(
      () => host.focusTab({ workspaceId: 'ws-1', kind: 'chat', id: 'a-1' }),
      /Agent Runtime module is disabled/,
    )

    // Enabled: calls route through to the backends, and an active file watch
    // stops delivering the moment the module is disabled (live per-delivery
    // gate, the Backlog watcher pattern).
    agentRuntimeEnabled = true
    const deliveries: unknown[] = []
    const stopWatch = await host.watchWorkspaceFile('ws-1', 'a.json', (event) => deliveries.push(event))
    assert.equal(deliveries.length, 1, 'fires once with the current content')
    agentRuntimeEnabled = false
    fileEmitters.forEach((emit) => emit())
    assert.equal(deliveries.length, 1, 'a disabled module stops receiving deliveries')
    agentRuntimeEnabled = true
    stopWatch()
    assert.equal(await host.getWorkingRoot('ws-1'), '/repo')
    assert.equal(host.focusTab({ workspaceId: 'ws-1', kind: 'file', id: 'notes/plan.md' }), true)
    assert.deepEqual(focused, ['file:notes/plan.md'])
    assert.deepEqual(host.listChatRuntimes(), [
      { id: 'claude-code', label: 'Claude Code', available: true, models: [], lastSelected: true },
    ])
  }

  async function main(): Promise<void> {
    await testWorkspaceFileWatch()
    await testTabFocus()
    testChatRuntimeOptions()
    await testEffectiveWorkingRoot()
    await testAgentRuntimeGate()
    console.log('live-runtime surfaces guard passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
