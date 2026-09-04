import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The Remote glyph's derivation and surface (remote-sessions-ux /
// remote-glyph-topbar + incoming-pair-request-prompt). The push plumbing is
// pinned main-side
// (tailnet-live-events, tailnet-fleet); what this file pins is what the
// chrome SAYS and DOES — mounted for real, so busy states and answers can be
// driven by clicks.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

// The bridge, with hooks a test can hold open or make fail.
const bridge = {
  revokeCalls: [] as string[],
  revokeResolve: null as null | (() => void),
  revokeFail: null as null | Error,
  approveResult: { ok: true } as { ok: boolean; message?: string },
  approveCalls: [] as Array<{ id: string; scopes: string[] }>,
}
;(dom.window as unknown as { api: unknown }).api = {
  tailnetRevokeDevice: (deviceId: string) => {
    bridge.revokeCalls.push(deviceId)
    if (bridge.revokeFail) return Promise.reject(bridge.revokeFail)
    return new Promise<void>((resolve) => {
      bridge.revokeResolve = resolve
    })
  },
  tailnetApprovePairRequest: (id: string, scopes: string[]) => {
    bridge.approveCalls.push({ id, scopes })
    return Promise.resolve(bridge.approveResult)
  },
  tailnetDenyPairRequest: () => Promise.resolve({}),
}

/* eslint-disable import/first -- jsdom globals must exist before React mounts */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { RemotePopover, deviceLivenessText, fleetMachinePhase, machinePhaseText, remoteGlyphState } from './RemotePopover'
import { fleetLiveSessionsOf, type TailnetPresence } from './useTailnetPresence'
import { useToastStore } from '../../../store/toastStore'
import type { TailnetLiveDevice, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { FleetConnection, FleetLiveAttachment } from '../../../../../shared/tailnet-fleet'

let failures = 0
function run(name: string, fn: () => void | Promise<void>): void {
  queue = queue
    .then(async () => {
      await fn()
      console.log(`ok - ${name}`)
    })
    .catch((error) => {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    })
}
let queue: Promise<void> = Promise.resolve()

function status(overrides: Partial<TailnetRemoteStatus> = {}): TailnetRemoteStatus {
  return {
    enabled: true,
    running: true,
    endpoint: '100.91.70.66:8471',
    port: 8471,
    tailnetAddress: '100.91.70.66',
    lastError: null,
    devices: [],
    pairing: null,
    pairRequests: [],
    ...overrides,
  }
}

function connection(overrides: Partial<FleetConnection> = {}): FleetConnection {
  return {
    id: 'conn-1',
    machineName: 'Conal’s MacBook Air',
    endpoint: '100.106.119.1:8471',
    deviceId: 'tnd_x',
    deviceName: 'mini',
    scopes: ['workspace:read'],
    pairedAt: new Date(0).toISOString(),
    lastConnectedAt: null,
    ...overrides,
  }
}

function device(overrides: Partial<TailnetLiveDevice> = {}): TailnetLiveDevice {
  return {
    deviceId: 'd1',
    deviceName: 'Sprint Engine Android',
    connected: true,
    attachedTerminalSessions: [],
    connectedSince: Date.now() - 12 * 60_000,
    lastActivityAt: Date.now() - 3 * 60_000,
    peerNode: null,
    peerAddress: '100.106.119.1',
    ...overrides,
  }
}

function attachments(list: Array<Partial<FleetLiveAttachment> & { attachId: string }>): Map<string, FleetLiveAttachment> {
  return new Map(
    list.map((entry) => [
      entry.attachId,
      { connectionId: 'conn-1', machineName: 'Conal’s MacBook Air', sessionId: 's1', state: 'live', detail: '', ...entry },
    ])
  )
}

function presence(overrides: Partial<TailnetPresence> = {}): TailnetPresence {
  const fleetAttachments = overrides.fleetAttachments ?? new Map()
  return {
    status: status(),
    live: { revision: 0, devices: [] },
    fleet: [],
    fleetAttachments,
    fleetLiveSessions: fleetLiveSessionsOf(fleetAttachments),
    ...overrides,
  }
}

let root: Root | null = null
let host: HTMLElement | null = null
function mount(node: React.ReactNode): HTMLElement {
  const created = dom.window.document.createElement('div')
  host = created
  dom.window.document.body.appendChild(created)
  act(() => {
    root = createRoot(created)
    root.render(node)
  })
  return created
}
function unmount(): void {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
}
function click(element: Element | null): void {
  assert.ok(element, 'the element to click exists')
  act(() => {
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  })
}
function buttonNamed(mounted: HTMLElement, text: RegExp): HTMLButtonElement | null {
  return [...mounted.querySelectorAll('button')].find((button) => text.test(button.textContent ?? '')) ?? null
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
function popover(p: TailnetPresence, onOpenFleet: (() => void) | null = () => {}) {
  return <RemotePopover presence={p} onOpenFleet={onOpenFleet} onOpenRemoteSettings={() => {}} />
}

// ── derivation ───────────────────────────────────────────────────────────

run('the glyph is absent while the feature is off and nothing is paired — not present-but-empty', () => {
  assert.equal(
    remoteGlyphState(presence({ status: status({ enabled: false, running: false, endpoint: null }) })).visible,
    false
  )
  assert.equal(remoteGlyphState(presence({ status: null })).visible, false)
})

run('a paired fleet machine earns the glyph even with the inbound listener off', () => {
  const state = remoteGlyphState(
    presence({ status: status({ enabled: false, running: false, endpoint: null }), fleet: [connection()] })
  )
  assert.equal(state.visible, true)
})

run('driving = a device attached to a terminal HERE; connected covers both directions; degraded = a link in trouble', () => {
  const driving = remoteGlyphState(
    presence({ live: { revision: 1, devices: [device({ attachedTerminalSessions: ['t1'] })] } })
  )
  assert.equal(driving.driving, true)
  assert.equal(driving.connected, true)
  assert.equal(driving.degraded, false)
  const outbound = remoteGlyphState(
    presence({ fleet: [connection()], fleetAttachments: attachments([{ attachId: 'a', state: 'live' }]) })
  )
  assert.equal(outbound.driving, false)
  assert.equal(outbound.connected, true)
  assert.equal(outbound.degraded, false)
  const degraded = remoteGlyphState(
    presence({
      fleet: [connection()],
      fleetAttachments: attachments([
        { attachId: 'a', state: 'live' },
        { attachId: 'b', state: 'reconnecting', sessionId: 's2' },
      ]),
    })
  )
  assert.equal(degraded.connected, true, 'one live link still counts as connected')
  assert.equal(degraded.degraded, true, 'and the reconnecting one makes it degraded — the warn dot')
  assert.equal(
    remoteGlyphState(presence({ fleetAttachments: attachments([{ attachId: 'a', state: 'connecting' }]) })).degraded,
    false,
    'a first dial is not degradation'
  )
})

run('a machine’s phase is derived from its links, by precedence: live > reconnecting > connecting > offline > paired', () => {
  const byAttach = (list: Array<Partial<FleetLiveAttachment> & { attachId: string }>) =>
    fleetMachinePhase('conn-1', attachments(list))
  assert.deepEqual(byAttach([]), { phase: 'paired' })
  assert.deepEqual(byAttach([{ attachId: 'a', state: 'connecting', detail: 'Connecting to Air.' }]), {
    phase: 'connecting',
    detail: 'Connecting to Air.',
  })
  assert.equal(byAttach([{ attachId: 'a', state: 'reconnecting' }, { attachId: 'b', state: 'connecting' }]).phase, 'reconnecting')
  assert.equal(byAttach([{ attachId: 'a', state: 'offline' }]).phase, 'offline')
  assert.deepEqual(
    byAttach([
      { attachId: 'a', state: 'live', sessionId: 's1' },
      { attachId: 'b', state: 'live', sessionId: 's1' },
      { attachId: 'c', state: 'live', sessionId: 's2' },
      { attachId: 'd', state: 'offline', sessionId: 's3' },
    ]),
    { phase: 'connected', liveSessions: 2 },
    'a live link wins, and sessions are counted, not panes'
  )
  assert.equal(byAttach([{ attachId: 'a', state: 'live', connectionId: 'other' }]).phase, 'paired', 'another machine’s links do not count')
  assert.equal(machinePhaseText('Air', { phase: 'connecting', detail: '' }), 'Connecting to Air…')
  assert.equal(machinePhaseText('Air', { phase: 'reconnecting', detail: '' }), 'Reconnecting to Air…')
  assert.equal(machinePhaseText('Air', { phase: 'offline', detail: '' }), 'Air is not answering')
})

run('two panes on one session are two links: closing one does not retract the other’s live', () => {
  const both = attachments([
    { attachId: 'a', state: 'live' },
    { attachId: 'b', state: 'live' },
  ])
  assert.deepEqual([...(fleetLiveSessionsOf(both).get('conn-1') ?? [])], ['s1'])
  both.delete('a')
  assert.deepEqual([...(fleetLiveSessionsOf(both).get('conn-1') ?? [])], ['s1'], 'still live through pane b')
})

run('device liveness reads "Connected for" from the socket, else "Last seen" from the last activity', () => {
  const now = Date.now()
  assert.equal(deviceLivenessText({ connectedSince: now - 12 * 60_000, lastActivityAt: now }, now), 'Connected for 12m')
  assert.equal(deviceLivenessText({ connectedSince: now - 20_000, lastActivityAt: now }, now), 'Connected for 20s')
  assert.equal(deviceLivenessText({ connectedSince: null, lastActivityAt: now - 3 * 60_000 }, now), 'Last seen 3m ago')
})

// ── the surface ──────────────────────────────────────────────────────────

run('the popover names the endpoint and driving device, and hosts the ACTING pair-request card with both identities labelled', () => {
  const mounted = mount(
    popover(
      presence({
        status: status({
          pairRequests: [
            {
              id: 'req1',
              deviceName: 'macbook-air',
              peerNode: 'dev-macbook-air',
              peerAddress: '100.106.119.1',
              comparisonCode: '481972',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
            },
          ],
        }),
        live: { revision: 1, devices: [device({ attachedTerminalSessions: ['agent-standup'] })] },
        fleet: [connection()],
        fleetAttachments: attachments([
          { attachId: 'a', state: 'live', sessionId: 's1' },
          { attachId: 'b', state: 'live', sessionId: 's2' },
        ]),
      })
    )
  )
  const markup = mounted.innerHTML
  assert.match(markup, /100\.91\.70\.66:8471/, 'the listener endpoint reads in mono')
  assert.match(markup, /Sprint Engine Android/)
  assert.match(markup, /driving/)
  assert.match(markup, /agent-standup/, 'the driven session is NAMED, not counted')
  assert.match(markup, /Connected for 12m/, 'connected-for from connectedSince')
  assert.match(markup, /tabular-nums/, 'durations in tabular figures')
  assert.match(markup, /100\.106\.119\.1/, 'the peer the transport saw')
  assert.match(markup, /Revoke/)
  // The card: the proven node and the declared name, each labelled.
  assert.match(markup, /dev-macbook-air/)
  assert.match(markup, /asks to pair/)
  assert.match(markup, /Tailnet node/)
  assert.match(markup, /Calls itself/)
  assert.match(markup, /macbook-air/)
  assert.match(markup, /481972/)
  assert.match(markup, /Terminals — control/)
  assert.match(markup, /arbitrary shell/)
  assert.match(markup, /Allow/)
  assert.match(markup, /Decline/)
  assert.doesNotMatch(markup, /Review/, 'no pointer elsewhere — the card acts, right here')
  // Machines: the shared remote glyph leads the row, the phase dot and text follow.
  assert.match(markup, /Conal’s MacBook Air/)
  assert.match(markup, /2 terminals attached/)
  assert.match(markup, /aria-label="Connected"/, 'the connected phase dot')
  assert.match(markup, /Open Fleet/)
  assert.match(markup, /Remote settings/)
  unmount()
})

run('machine rows narrate the transitional and failed phases with the phase dot table', () => {
  const mounted = mount(
    popover(
      presence({
        fleet: [connection(), connection({ id: 'conn-2', machineName: 'Mini', endpoint: '100.1.1.2:8471' }), connection({ id: 'conn-3', machineName: 'Studio', endpoint: '100.1.1.3:8471' })],
        fleetAttachments: attachments([
          { attachId: 'a', state: 'reconnecting', connectionId: 'conn-1', detail: 'Reconnecting.' },
          { attachId: 'b', state: 'offline', connectionId: 'conn-2', machineName: 'Mini' },
        ]),
      })
    )
  )
  const markup = mounted.innerHTML
  assert.match(markup, /Reconnecting to Conal’s MacBook Air…/)
  assert.match(markup, /aria-label="Reconnecting"/)
  assert.match(markup, /status-dot-pulse/, 'the transitional phase carries the halo')
  assert.match(markup, /Mini is not answering/)
  assert.match(markup, /aria-label="Not answering"/)
  assert.match(markup, /aria-label="Paired"/, 'a machine with no link is paired, nothing more claimed')
  assert.equal((markup.match(/<svg/g) ?? []).length >= 3, true, 'the remote glyph leads every machine row')
  unmount()
})

run('a lapsed pair request keeps its card with Allow and Decline dead and the reason stated', () => {
  const mounted = mount(
    popover(
      presence({
        status: status({
          pairRequests: [
            {
              id: 'req-lapsed',
              deviceName: 'late',
              peerNode: null,
              peerAddress: '100.2.2.2',
              comparisonCode: '000111',
              createdAt: new Date(Date.now() - 6 * 60_000).toISOString(),
              expiresAt: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        }),
      })
    )
  )
  const allow = buttonNamed(mounted, /^Allow/)
  const decline = buttonNamed(mounted, /^Decline/)
  assert.ok(allow?.disabled, 'Allow is dead')
  assert.ok(decline?.disabled, 'Decline is dead')
  assert.match(mounted.innerHTML, /Lapsed/)
  assert.match(mounted.innerHTML, /lapsed before it was answered/)
  assert.match(mounted.innerHTML, /Address \(unverified\)/, 'an unresolved peer is shown as the address, marked unverified')
  unmount()
})

run('an answer of request_not_found is surfaced as an error toast, not swallowed', async () => {
  act(() => {
    useToastStore.setState({ toasts: [] })
  })
  bridge.approveResult = { ok: false, message: 'That pairing request is no longer waiting to be answered.' }
  const mounted = mount(
    popover(
      presence({
        status: status({
          pairRequests: [
            {
              id: 'req-gone',
              deviceName: 'gone',
              peerNode: 'gone-node',
              peerAddress: '100.3.3.3',
              comparisonCode: '222333',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      })
    )
  )
  click(buttonNamed(mounted, /^Allow/))
  await flush()
  assert.equal(bridge.approveCalls[0]?.id, 'req-gone')
  const toast = useToastStore.getState().toasts[0]
  assert.equal(toast?.tone, 'error')
  assert.match(toast?.description ?? '', /no longer waiting/)
  bridge.approveResult = { ok: true }
  unmount()
})

run('Revoke is busy while pending, and a failure lands as an error toast', async () => {
  act(() => {
    useToastStore.setState({ toasts: [] })
  })
  bridge.revokeCalls.length = 0
  const mounted = mount(popover(presence({ live: { revision: 1, devices: [device()] } })))
  const revoke = buttonNamed(mounted, /^Revoke/)
  assert.ok(revoke && !revoke.disabled)
  click(revoke)
  assert.deepEqual(bridge.revokeCalls, ['d1'])
  assert.ok(buttonNamed(mounted, /Revoking…/)?.disabled, 'busy and disabled while main answers')
  // A second click while pending must not fire a second revoke.
  click(buttonNamed(mounted, /Revoking…/))
  assert.deepEqual(bridge.revokeCalls, ['d1'])
  await act(async () => {
    bridge.revokeResolve?.()
    await Promise.resolve()
  })
  await flush()
  assert.ok(buttonNamed(mounted, /^Revoke$/) && !buttonNamed(mounted, /^Revoke$/)?.disabled, 'idle again')
  assert.equal(useToastStore.getState().toasts.length, 0, 'success is quiet — the push channel removes the row')

  bridge.revokeFail = new Error('IPC went away')
  click(buttonNamed(mounted, /^Revoke$/))
  await flush()
  const toast = useToastStore.getState().toasts[0]
  assert.equal(toast?.tone, 'error')
  assert.match(toast?.title ?? '', /Could not revoke Sprint Engine Android/)
  assert.equal(toast?.description, 'IPC went away')
  bridge.revokeFail = null
  unmount()
})

run('a quiet popover says so rather than rendering empty sections', () => {
  const mounted = mount(popover(presence(), null))
  assert.match(mounted.innerHTML, /No device is connected right now\./)
  assert.match(mounted.innerHTML, /No machines paired\. Pair one from the Fleet\./)
  assert.doesNotMatch(mounted.innerHTML, /Open Fleet/, 'no workspace to dock the Fleet into, no dead button')
  unmount()
})

void queue.then(() => {
  if (failures > 0) {
    console.error(`RemotePopover.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('RemotePopover.test.tsx: ok')
})
