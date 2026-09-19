import assert from 'node:assert/strict'

import {
  TERMINAL_PROMPT_NEXT_COMMAND,
  TERMINAL_PROMPT_PREVIOUS_COMMAND,
  registerMountedTerminalPromptNavigation,
  respondToTerminalPromptNavigation,
  resetMountedTerminalPromptNavigations,
  type MountedTerminalPromptNavigation,
  type TerminalPromptDirection,
} from './terminalPromptNavigation'
import { PANEL_COMMAND_EVENT } from './panelCommands'
import { test } from 'vitest'

test('terminalPromptNavigation', async () => {
  // A fake window, installed BEFORE the module under test, because
  // `registerMountedTerminalPromptNavigation` installs and removes exactly one
  // listener on it and that bookkeeping is half of what this file checks.
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
  // workspace stay in the tree — so "which one answers the key" is the whole
  // question. Scrolling all of them would move panes the user is not looking at.

  function pane(
    workspaceId: string | null,
    options: { focused?: boolean } = {},
  ): MountedTerminalPromptNavigation & { moves: TerminalPromptDirection[] } {
    const entry = {
      workspaceId,
      moves: [] as TerminalPromptDirection[],
      isFocused: () => options.focused === true,
      scrollToPrompt: (direction: TerminalPromptDirection) => {
        entry.moves.push(direction)
        return true
      },
    }
    return entry
  }

  function run(name: string, body: () => void): void {
    resetMountedTerminalPromptNavigations()
    body()
    console.log(`ok - ${name}`)
  }

  run('the focused pane answers, whatever workspace it belongs to', () => {
    const background = pane('workspace-a')
    const focused = pane('workspace-b', { focused: true })
    registerMountedTerminalPromptNavigation(background)
    registerMountedTerminalPromptNavigation(focused)

    assert.equal(respondToTerminalPromptNavigation('workspace-a', 'previous'), focused)
    assert.deepEqual(focused.moves, ['previous'])
    assert.deepEqual(background.moves, [])
  })

  run('with nothing focused, the most recent pane of the ACTIVE workspace answers', () => {
    const other = pane('workspace-a')
    const older = pane('workspace-b')
    const newer = pane('workspace-b')
    registerMountedTerminalPromptNavigation(other)
    registerMountedTerminalPromptNavigation(older)
    registerMountedTerminalPromptNavigation(newer)

    assert.equal(respondToTerminalPromptNavigation('workspace-b', 'next'), newer)
    assert.deepEqual(newer.moves, ['next'])
    assert.deepEqual(older.moves, [])
    assert.deepEqual(other.moves, [], 'a pane in another workspace must never answer')
  })

  run('a pane with no workspace answers only by holding focus', () => {
    const unowned = pane(null)
    registerMountedTerminalPromptNavigation(unowned)

    assert.equal(respondToTerminalPromptNavigation('workspace-a', 'previous'), null)
    assert.deepEqual(unowned.moves, [])
  })

  run('exactly one pane ever answers', () => {
    const first = pane('workspace-a')
    const second = pane('workspace-a')
    registerMountedTerminalPromptNavigation(first)
    registerMountedTerminalPromptNavigation(second)

    respondToTerminalPromptNavigation('workspace-a', 'previous')

    assert.equal(first.moves.length + second.moves.length, 1)
  })

  run('no mounted pane is not a crash', () => {
    assert.equal(respondToTerminalPromptNavigation('workspace-a', 'next'), null)
  })

  // The two commands share one listener, so the id is the only thing that decides
  // which way the pane moves — and an id belonging to some other panel command
  // must move nothing at all.
  run('the panel command carries the direction, and only ours is answered', () => {
    const focused = pane('workspace-a', { focused: true })
    registerMountedTerminalPromptNavigation(focused)
    const listener = [...(listeners.get(PANEL_COMMAND_EVENT) ?? [])][0]
    assert.ok(listener, 'a listener was installed')

    const fire = (id: string): void => {
      listener({ detail: { id } } as unknown as Event)
    }

    fire(TERMINAL_PROMPT_PREVIOUS_COMMAND)
    fire(TERMINAL_PROMPT_NEXT_COMMAND)
    fire('terminal.find')
    fire('git.commit')
    listener({} as Event)
    listener({ detail: {} } as unknown as Event)

    assert.deepEqual(focused.moves, ['previous', 'next'])
  })

  run('one window listener for the whole app, and none once the last pane unmounts', () => {
    addCalls = 0
    removeCalls = 0
    const unregisterFirst = registerMountedTerminalPromptNavigation(pane('workspace-a'))
    const unregisterSecond = registerMountedTerminalPromptNavigation(pane('workspace-a'))

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
    registerMountedTerminalPromptNavigation(staying)
    const unregisterLeaving = registerMountedTerminalPromptNavigation(leaving)

    unregisterLeaving()
    assert.equal(respondToTerminalPromptNavigation('workspace-a', 'previous'), staying)
    assert.deepEqual(leaving.moves, [])
  })

  console.log('\n8 passed')
})
