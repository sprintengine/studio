/**
 * MC-2156 — the last-window-close decision and the tray that stands in for a
 * window. Runs with zero windows and no Electron: the whole point of the
 * feature is what the app does when there is no display left to talk to.
 *
 * A full tray render is not testable headlessly (the backlog says so), so the
 * Tray is a fake here and the assertions are on the lifecycle hooks: what gets
 * created, what gets destroyed, and what the menu says at the moment it is
 * built.
 */
import assert from 'node:assert/strict'
import { createBackgroundPresence, type BackgroundTrayHandle } from './background-presence'
import type { BackgroundStatus, BackgroundTrayItem } from '../shared/background-mode'

type FakeTray = BackgroundTrayHandle & {
  destroyed: number
  tooltips: string[]
  menus: Array<readonly BackgroundTrayItem[]>
  listeners: Map<string, () => void>
}

function fakeTray(): FakeTray {
  const listeners = new Map<string, () => void>()
  const tray: FakeTray = {
    destroyed: 0,
    tooltips: [],
    menus: [],
    listeners,
    setToolTip: (text) => tray.tooltips.push(text),
    setContextMenu: (menu) => tray.menus.push(menu as readonly BackgroundTrayItem[]),
    on: (event, listener) => listeners.set(event, listener),
    destroy: () => {
      tray.destroyed += 1
    },
  }
  return tray
}

type Harness = {
  presence: ReturnType<typeof createBackgroundPresence>
  trays: FakeTray[]
  opened: number
  quits: number
  intervals: Array<() => void>
  cleared: number
  setStatus(next: BackgroundStatus): void
  setEnabled(next: boolean): void
  failTray(): void
  failStatus(next: boolean): void
  diagnostics: string[]
}

function harness(platform: string, enabled: boolean): Harness {
  const trays: FakeTray[] = []
  const intervals: Array<() => void> = []
  const diagnostics: string[] = []
  let status: BackgroundStatus = { agentSessions: 0, gateway: { running: true } }
  let backgroundMode = enabled
  let trayAvailable = true
  let statusThrows = false
  const state = {
    opened: 0,
    quits: 0,
    cleared: 0,
  }
  const presence = createBackgroundPresence({
    platform,
    isBackgroundModeEnabled: () => backgroundMode,
    readStatus: () => {
      if (statusThrows) throw new Error('scheduler unavailable')
      return status
    },
    createTray: () => {
      if (!trayAvailable) return null
      const tray = fakeTray()
      trays.push(tray)
      return tray
    },
    // The pure item list travels through untouched so assertions can read the
    // labels the real Menu would have been built from.
    buildMenu: (items) => items,
    actions: {
      open: () => {
        state.opened += 1
      },
      quit: () => {
        state.quits += 1
      },
    },
    logDiagnostic: (input) => diagnostics.push(input.title),
    timers: {
      setInterval: (handler) => {
        intervals.push(handler)
        return intervals.length
      },
      clearInterval: () => {
        state.cleared += 1
      },
    },
  })
  return {
    presence,
    trays,
    intervals,
    diagnostics,
    get opened() {
      return state.opened
    },
    get quits() {
      return state.quits
    },
    get cleared() {
      return state.cleared
    },
    setStatus: (next) => {
      status = next
    },
    setEnabled: (next) => {
      backgroundMode = next
    },
    failTray: () => {
      trayAvailable = false
    },
    failStatus: (next) => {
      statusThrows = next
    },
  }
}

function labels(tray: FakeTray, index = tray.menus.length - 1): string[] {
  return (tray.menus[index] ?? []).map((item) => item.label ?? '—')
}

// background mode OFF: today's rule, unchanged, and no tray anywhere
for (const platform of ['win32', 'linux']) {
  const h = harness(platform, false)
  assert.equal(h.presence.onWindowAllClosed(), 'quit', `${platform} still quits with the setting off`)
  assert.equal(h.trays.length, 0)
}
{
  const h = harness('darwin', false)
  assert.equal(h.presence.onWindowAllClosed(), 'stay', 'macOS has always outlived its windows')
  assert.equal(h.trays.length, 0, 'no tray without the setting: the affordance is part of the opt-in')
}

// background mode ON: the process stays up on every platform, tray and all
for (const platform of ['win32', 'linux', 'darwin']) {
  const h = harness(platform, true)
  h.setStatus({ agentSessions: 2, gateway: { running: true } })
  assert.equal(h.presence.onWindowAllClosed(), 'stay', `${platform} keeps running with the setting on`)
  assert.equal(h.trays.length, 1)
  assert.equal(h.presence.isTrayVisible(), true)
  const tray = h.trays[0]!
  assert.match(tray.tooltips.at(-1) ?? '', /2 agent sessions running · Studio gateway listening/)
  assert.ok(labels(tray).includes('2 agent sessions running'))
  assert.ok(labels(tray).includes('Studio gateway listening'))
}

// the menu is rebuilt from live state, not from a snapshot taken at close time
{
  const h = harness('darwin', true)
  h.presence.onWindowAllClosed()
  const tray = h.trays[0]!
  h.setStatus({ agentSessions: 0, gateway: { running: false } })
  tray.listeners.get('click')?.()
  assert.ok(labels(tray).includes('No agent sessions running'))
  assert.ok(labels(tray).includes('Studio gateway not listening'))
  // and the slow tick refreshes it where click events never arrive (Linux)
  h.setStatus({ agentSessions: 4, gateway: { running: true } })
  h.intervals[0]?.()
  assert.ok(labels(tray).includes('4 agent sessions running'))
}

// the tray actions are the two the feature promises
{
  const h = harness('darwin', true)
  h.presence.onWindowAllClosed()
  const menu = h.trays[0]!.menus.at(-1) ?? []
  assert.deepEqual(
    menu.filter((item) => item.kind === 'action').map((item) => item.label),
    ['Open Multicode', 'Quit Multicode'],
  )
}

// reopening a window retires the tray; closing again brings a fresh one back
{
  const h = harness('win32', true)
  h.presence.onWindowAllClosed()
  h.presence.onWindowOpened()
  assert.equal(h.trays[0]!.destroyed, 1)
  assert.equal(h.presence.isTrayVisible(), false)
  assert.equal(h.cleared, 1, 'the refresh tick stops with the tray')
  assert.equal(h.presence.onWindowAllClosed(), 'stay')
  assert.equal(h.trays.length, 2)
}

// a second close with the tray already up reuses it rather than stacking icons
{
  const h = harness('win32', true)
  h.presence.onWindowAllClosed()
  h.presence.onWindowAllClosed()
  assert.equal(h.trays.length, 1)
  assert.equal(h.trays[0]!.menus.length, 2, 'the existing tray re-renders instead')
}

// quit disposes the tray, and a window-all-closed during shutdown never revives it
{
  const h = harness('win32', true)
  h.presence.onWindowAllClosed()
  h.presence.onBeforeQuit()
  assert.equal(h.trays[0]!.destroyed, 1)
  assert.equal(h.presence.onWindowAllClosed(), 'stay', 'shutdown is already in flight; do not re-quit')
  assert.equal(h.trays.length, 1, 'no tray is created while quitting')
}

// the setting is read at close time, so flipping it mid-session takes effect
{
  const h = harness('linux', false)
  assert.equal(h.presence.onWindowAllClosed(), 'quit')
  h.setEnabled(true)
  assert.equal(h.presence.onWindowAllClosed(), 'stay')
}

// no tray available: stay running (live agents outrank the missing icon), say so
{
  const h = harness('linux', true)
  h.failTray()
  assert.equal(h.presence.onWindowAllClosed(), 'stay')
  assert.equal(h.presence.isTrayVisible(), false)
  assert.ok(h.diagnostics.includes('Background tray unavailable'))
}

// a status read that throws must not take the process down with it
{
  const h = harness('linux', true)
  h.presence.onWindowAllClosed()
  const tray = h.trays[0]!
  const lastGood = labels(tray)
  h.failStatus(true)
  h.intervals[0]?.()
  h.intervals[0]?.()
  assert.deepEqual(labels(tray), lastGood, 'the menu holds its last good content')
  assert.equal(
    h.diagnostics.filter((title) => title === 'Background tray status unavailable').length,
    1,
    'reported once, not once per tick',
  )
  // and it recovers on its own once the reader comes back
  h.failStatus(false)
  h.setStatus({ agentSessions: 7, gateway: { running: true } })
  h.intervals[0]?.()
  assert.ok(labels(tray).includes('7 agent sessions running'))
}

// The chain that matters end to end: `window-all-closed` calling `app.quit()`
// is the ONLY thing that runs the shutdown legs (automations, agent state,
// PTYs), so staying in the background must leave every one of them untouched.
// This mirrors the handler in app-lifecycle.ts verbatim.
{
  const torndown: string[] = []
  const services = {
    automationService: { shutdown: () => torndown.push('automations') },
    agentStateService: { shutdown: () => torndown.push('agent-state') },
    terminalRuntime: { shutdown: () => torndown.push('ptys') },
  }
  const h = harness('win32', true)
  const appQuit = (): void => {
    // The real before-quit legs, in the order app-lifecycle runs them.
    services.automationService.shutdown()
    services.agentStateService.shutdown()
    services.terminalRuntime.shutdown()
  }
  const onWindowAllClosed = (): void => {
    if (h.presence.onWindowAllClosed() === 'quit') appQuit()
  }

  onWindowAllClosed()
  assert.deepEqual(torndown, [], 'automations, agent state and the PTYs all survive the last window')

  // …and with the setting off, the same handler tears them all down as before.
  const off = harness('win32', false)
  if (off.presence.onWindowAllClosed() === 'quit') appQuit()
  assert.deepEqual(torndown, ['automations', 'agent-state', 'ptys'])
}

console.log('background-presence tests passed')
