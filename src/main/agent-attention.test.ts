/**
 * A background agent asks for the person through the taskbar or the dock and
 * never by bringing a window forward. The fake window records every call made
 * on it, including the ones attention must never make.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { createAgentAttention, isAttentionEvent, isScriptSecondLaunch, type AttentionWindow } from './agent-attention'
import type { AgentPhaseEvent } from '../shared/agent-runtime'

type FakeWindow = AttentionWindow & {
  focused: boolean
  flashes: boolean[]
  raised: string[]
}

function fakeWindow(focused = false): FakeWindow {
  const win: FakeWindow = {
    focused,
    flashes: [],
    raised: [],
    isDestroyed: () => false,
    isFocused: () => win.focused,
    flashFrame: (flag) => void win.flashes.push(flag),
  }
  // What a focus steal would call. Present so a regression would be recorded
  // rather than throw on a missing method.
  for (const method of ['focus', 'show', 'restore', 'moveTop', 'setAlwaysOnTop']) {
    Object.assign(win, { [method]: () => void win.raised.push(method) })
  }
  return win
}

function phase(overrides: Partial<AgentPhaseEvent>): AgentPhaseEvent {
  return {
    workspaceId: 'ws-1',
    agentId: 'agent-1',
    executionId: null,
    phase: 'idle',
    previousPhase: 'tool_use',
    event: 'Stop',
    turnEnd: true,
    turnFailure: false,
    ts: 1,
    pendingWakeupAt: null,
    ...overrides,
  }
}

function harness(platform: string, windows: FakeWindow[]) {
  const bounces: number[] = []
  const badges: number[] = []
  const attention = createAgentAttention({
    platform,
    listWindows: () => windows,
    bounceDock: () => void bounces.push(1),
    setBadgeCount: (count) => void badges.push(count),
  })
  return { attention, bounces, badges }
}

test('a turn end on Windows flashes the taskbar and never raises the window', () => {
  const win = fakeWindow()
  const { attention, badges } = harness('win32', [win])
  attention.onAgentPhase(phase({}))
  assert.deepEqual(win.flashes, [true])
  assert.deepEqual(win.raised, [], 'attention must not focus, show or restore the window')
  assert.deepEqual(badges, [], 'Windows has no badge count; the flash is the signal')
})

test('the tool churn inside a turn asks for nothing', () => {
  const win = fakeWindow()
  const { attention } = harness('win32', [win])
  for (const current of ['starting', 'thinking', 'tool_use'] as const) {
    attention.onAgentPhase(phase({ phase: current, event: 'PostToolUse', turnEnd: false }))
  }
  attention.onAgentPhase(phase({ phase: 'idle', event: 'SubagentStop', turnEnd: false }))
  assert.deepEqual(win.flashes, [])
  assert.deepEqual(win.raised, [])
  assert.equal(attention.pendingCount(), 0)
})

test('a question on macOS bounces the dock once and badges the count', () => {
  const win = fakeWindow()
  const { attention, bounces, badges } = harness('darwin', [win])
  attention.onAgentPhase(phase({ phase: 'awaiting_input', event: 'Notification', turnEnd: false }))
  attention.onAgentPhase(phase({ agentId: 'agent-2' }))
  assert.equal(bounces.length, 2)
  assert.deepEqual(badges, [1, 2])
  assert.deepEqual(win.flashes, [], 'flashFrame is the Windows signal')
  assert.deepEqual(win.raised, [])
})

test('a repeated awaiting_input frame is not a second request', () => {
  assert.equal(isAttentionEvent(phase({ phase: 'awaiting_input', previousPhase: 'tool_use', turnEnd: false })), true)
  assert.equal(
    isAttentionEvent(phase({ phase: 'awaiting_input', previousPhase: 'awaiting_input', turnEnd: false })),
    false,
  )
})

test('Linux badges the launcher and neither flashes nor bounces', () => {
  const win = fakeWindow()
  const { attention, bounces, badges } = harness('linux', [win])
  attention.onAgentPhase(phase({}))
  assert.deepEqual(badges, [1])
  assert.equal(bounces.length, 0)
  assert.deepEqual(win.flashes, [])
  assert.deepEqual(win.raised, [])
})

test('nothing is asked while the person is already in the app', () => {
  const win = fakeWindow(true)
  const { attention, bounces, badges } = harness('darwin', [win])
  attention.onAgentPhase(phase({}))
  assert.equal(bounces.length, 0)
  assert.deepEqual(badges, [])
  assert.equal(attention.pendingCount(), 0)
})

test('focusing the app clears the badge and stops the flash', () => {
  const win = fakeWindow()
  const windows = harness('win32', [win])
  windows.attention.onAgentPhase(phase({}))
  windows.attention.onWindowFocused()
  assert.deepEqual(win.flashes, [true, false])
  assert.equal(windows.attention.pendingCount(), 0)

  const mac = harness('darwin', [fakeWindow()])
  mac.attention.onAgentPhase(phase({}))
  mac.attention.onWindowFocused()
  assert.deepEqual(mac.badges, [1, 0])
})

test('an agent that goes back to work on its own stops counting', () => {
  const win = fakeWindow()
  const { attention, badges } = harness('win32', [win])
  attention.onAgentPhase(phase({ phase: 'awaiting_input', event: 'Notification', turnEnd: false }))
  attention.onAgentPhase(phase({ phase: 'thinking', event: 'UserPromptSubmit', turnEnd: false }))
  assert.equal(attention.pendingCount(), 0)
  assert.deepEqual(win.flashes, [true, false])
  assert.deepEqual(badges, [])
})

test('a hook that reached the binary as a second launch is told apart from a person', () => {
  const exe = 'C:\\Program Files\\SprintEngine Studio\\SprintEngine Studio.exe'
  assert.equal(
    isScriptSecondLaunch([exe, 'C:/work/app/.sprintengine/hooks/agent-state.mjs', '--socket', '\\\\.\\pipe\\se-agent']),
    true,
  )
  assert.equal(
    isScriptSecondLaunch([exe, 'C:\\Program Files\\SprintEngine Studio\\resources\\mcp-stdio-bridge.mjs']),
    true,
  )
  assert.equal(isScriptSecondLaunch([exe]), false, 'a plain relaunch still brings the app forward')
  assert.equal(isScriptSecondLaunch([exe, 'sprintengine://auth/callback?code=abc']), false, 'a deep link still does')
  assert.equal(isScriptSecondLaunch(['/usr/bin/electron', '/Users/dev/studio/out/main/index.js']), false)
})
