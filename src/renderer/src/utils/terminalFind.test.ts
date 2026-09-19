import assert from 'node:assert/strict'

import {
  registerMountedTerminalFind,
  respondToTerminalFind,
  resetMountedTerminalFinds,
  type MountedTerminalFind,
} from './terminalFind'
import { PANEL_COMMAND_EVENT } from './panelCommands'
import { test } from 'vitest'

test('terminalFind', async () => {
  // A fake window, installed BEFORE the module under test, because
  // `registerMountedTerminalFind` installs and removes exactly one listener on
  // it and that bookkeeping is half of what this file checks.
  type Listener = (event: Event) => void
  const listeners = new Map<string, Set<Listener>>()
  let addCalls = 0
  let removeCalls = 0
  ;(globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, listener: Listener) => {
      addCalls += 1
      const set = listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: Listener) => {
      removeCalls += 1
      listeners.get(type)?.delete(listener)
    },
  }

  // Several terminals are mounted at once — the panes of every background
  // workspace stay in the tree — so "which one answers ⌘F" is the whole question.
  // Opening a find bar in all of them is a bug you do not see until you switch
  // tabs and find a stale search sitting in a pane you never searched.

  function pane(
    workspaceId: string | null,
    options: { focused?: boolean } = {},
  ): MountedTerminalFind & { opened: number } {
    const entry = {
      workspaceId,
      opened: 0,
      isFocused: () => options.focused === true,
      openFind: () => {
        entry.opened += 1
      },
    }
    return entry
  }

  function run(name: string, body: () => void): void {
    resetMountedTerminalFinds()
    body()
    console.log(`ok - ${name}`)
  }

  run('the focused pane answers, whatever workspace it belongs to', () => {
    const background = pane('workspace-a')
    const focused = pane('workspace-b', { focused: true })
    registerMountedTerminalFind(background)
    registerMountedTerminalFind(focused)

    assert.equal(respondToTerminalFind('workspace-a'), focused)
    assert.equal(focused.opened, 1)
    assert.equal(background.opened, 0)
  })

  run('with nothing focused, the most recent pane of the ACTIVE workspace answers', () => {
    const other = pane('workspace-a')
    const older = pane('workspace-b')
    const newer = pane('workspace-b')
    registerMountedTerminalFind(other)
    registerMountedTerminalFind(older)
    registerMountedTerminalFind(newer)

    assert.equal(respondToTerminalFind('workspace-b'), newer)
    assert.equal(newer.opened, 1)
    assert.equal(older.opened, 0)
    assert.equal(other.opened, 0, 'a pane in another workspace must never answer')
  })

  run('a pane with no workspace answers only by holding focus', () => {
    // A fleet pane is attached to a MACHINE. Letting it answer through the
    // active-workspace fallback would put a find bar on a remote terminal because
    // of a key pressed while looking at a local one.
    const fleet = pane(null)
    registerMountedTerminalFind(fleet)

    assert.equal(respondToTerminalFind('workspace-a'), null)
    assert.equal(fleet.opened, 0)
  })

  run('a focused pane with no workspace does answer', () => {
    const fleet = pane(null, { focused: true })
    registerMountedTerminalFind(fleet)

    assert.equal(respondToTerminalFind(null), fleet)
    assert.equal(fleet.opened, 1)
  })

  run('exactly one pane ever answers', () => {
    const first = pane('workspace-a')
    const second = pane('workspace-a')
    registerMountedTerminalFind(first)
    registerMountedTerminalFind(second)

    respondToTerminalFind('workspace-a')

    assert.equal(first.opened + second.opened, 1)
  })

  run('no mounted pane is not a crash', () => {
    assert.equal(respondToTerminalFind('workspace-a'), null)
  })

  run('one window listener for the whole app, and none once the last pane unmounts', () => {
    addCalls = 0
    removeCalls = 0
    const unregisterFirst = registerMountedTerminalFind(pane('workspace-a'))
    const unregisterSecond = registerMountedTerminalFind(pane('workspace-a'))

    assert.equal(addCalls, 1, 'a listener per pane would run the election once per mounted terminal')
    assert.equal(listeners.get(PANEL_COMMAND_EVENT)?.size, 1)

    unregisterFirst()
    assert.equal(removeCalls, 0, 'the listener stays while any pane is mounted')

    unregisterSecond()
    assert.equal(removeCalls, 1)
    assert.equal(listeners.get(PANEL_COMMAND_EVENT)?.size, 0)
  })

  run('unregistering a pane takes it out of the election', () => {
    const staying = pane('workspace-a')
    const leaving = pane('workspace-a')
    registerMountedTerminalFind(staying)
    const unregisterLeaving = registerMountedTerminalFind(leaving)

    unregisterLeaving()
    assert.equal(respondToTerminalFind('workspace-a'), staying)
    assert.equal(leaving.opened, 0)
  })

  console.log('\n8 passed')
})
