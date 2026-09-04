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
// React's controlled-input change detection needs the real constructors on
// the global, or a synthetic `input` event never reaches onChange.
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
// React DOM is required above these globals in the bundle (esbuild hoists the
// import), so it decided at load that no DOM exists and uses its legacy
// change-event polyfill, which watches the focused element through IE's
// attachEvent/detachEvent. Give jsdom those as no-ops so the polyfill's
// focus → set value → keyup sequence (see `typeInto`) reaches onChange on
// every input, not just the first one focused.
const inputProto = dom.window.HTMLInputElement.prototype as unknown as Record<string, unknown>
inputProto.attachEvent = () => {}
inputProto.detachEvent = () => {}

// The bridge, with hooks a test can hold open or make fail.
const bridge = {
  revokeCalls: [] as string[],
  revokeResolve: null as null | (() => void),
  revokeFail: null as null | Error,
  approveResult: { ok: true } as { ok: boolean; code?: string; message?: string; attemptsLeft?: number; declined?: boolean },
  approveCalls: [] as Array<{ id: string; scopes: string[]; code: string }>,
  reachabilityCalls: [] as Array<string | undefined>,
  cancelCalls: [] as string[],
}
;(dom.window as unknown as { api: unknown }).api = {
  tailnetRevokeDevice: (deviceId: string) => {
    bridge.revokeCalls.push(deviceId)
    if (bridge.revokeFail) return Promise.reject(bridge.revokeFail)
    return new Promise<void>((resolve) => {
      bridge.revokeResolve = resolve
    })
  },
  tailnetApprovePairRequest: (id: string, scopes: string[], code: string) => {
    bridge.approveCalls.push({ id, scopes, code })
    return Promise.resolve(bridge.approveResult)
  },
  tailnetDenyPairRequest: () => Promise.resolve({}),
  fleetCheckReachability: (connectionId?: string) => {
    bridge.reachabilityCalls.push(connectionId)
    return Promise.resolve({ revision: 0, attachments: [], requests: [], reachability: [] })
  },
  fleetCancelPairing: (requestId: string) => {
    bridge.cancelCalls.push(requestId)
    return Promise.resolve()
  },
}

/* eslint-disable import/first -- jsdom globals must exist before React mounts */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { RemotePopover, deviceLivenessText, fleetMachinePhase, machinePhaseText, remoteGlyphState } from './RemotePopover'
import { fleetLiveSessionsOf, type TailnetPresence } from './useTailnetPresence'
import { useToastStore } from '../../../store/toastStore'
import type { TailnetLiveDevice, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type { FleetConnection, FleetLiveAttachment, FleetMachineReachability } from '../../../../../shared/tailnet-fleet'

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
    notifications: true,
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
    pairedVia: 'request',
    ...overrides,
  }
}

function reach(overrides: Partial<FleetMachineReachability> = {}): FleetMachineReachability {
  return {
    connectionId: 'conn-1',
    machineName: 'Conal’s MacBook Air',
    checking: false,
    reachable: true,
    unauthorized: false,
    checkedAt: Date.now() - 5_000,
    lastReachedAt: Date.now() - 5_000,
    detail: null,
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
    fleetRequests: [],
    fleetReachability: new Map(),
    ...overrides,
  }
}
// React DOM is required above the jsdom globals in this bundle (esbuild
// hoists the import), so it decided at load that no DOM exists and uses its
// change-event polyfill: a focused element is watched, and a value change is
// noticed on keyup. Typing here is that sequence — focus, set, keyup.
async function typeInto(input: Element | null, value: string): Promise<void> {
  assert.ok(input instanceof dom.window.HTMLInputElement, 'the input exists')
  // jsdom's constructor, not the lib.dom type, so the guard above does not narrow for TS.
  const field = input as HTMLInputElement
  await act(async () => {
    field.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    field.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
  })
}
function codeInput(mounted: HTMLElement): HTMLInputElement | null {
  return mounted.querySelector('input[inputmode="numeric"]')
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
  const now = Date.now()
  assert.equal(machinePhaseText('Air', { phase: 'connecting', detail: '' }, now), 'Connecting to Air…')
  assert.equal(machinePhaseText('Air', { phase: 'reconnecting', detail: '' }, now), 'Reconnecting to Air…')
  assert.equal(machinePhaseText('Air', { phase: 'offline', detail: '' }, now), 'Air is not answering')
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
  // Phase 2: the code is TYPED here, not displayed — the digits live on the asker's screen.
  assert.doesNotMatch(markup, /481972/, 'the comparison code is not shown on the approving side')
  assert.match(markup, /Enter the code shown on dev-macbook-air/)
  assert.ok(codeInput(mounted), 'a numeric code input')
  assert.ok(buttonNamed(mounted, /^Allow/)?.disabled, 'Allow is dead until six digits are typed')
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
  await typeInto(codeInput(mounted), '222333')
  click(buttonNamed(mounted, /^Allow/))
  await flush()
  assert.equal(bridge.approveCalls[0]?.id, 'req-gone')
  assert.equal(bridge.approveCalls[0]?.code, '222333', 'the typed code travels with the approval')
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
  assert.match(mounted.innerHTML, /No machines paired\./)
  assert.match(mounted.innerHTML, /Add a machine…/, 'the way in is offered from the popover itself')
  assert.doesNotMatch(mounted.innerHTML, /Open Fleet/, 'no workspace to dock the Fleet into, no dead button')
  unmount()
})

// ── phase 2: a wrong code is refused inline, the third declines ──────────

run('a wrong code is refused beside the field, in main’s words, and the field clears for another try', async () => {
  act(() => {
    useToastStore.setState({ toasts: [] })
  })
  bridge.approveCalls.length = 0
  bridge.approveResult = { ok: false, code: 'code_mismatch', message: 'That code did not match. 2 tries left.', attemptsLeft: 2, declined: false }
  const mounted = mount(
    popover(
      presence({
        status: status({
          pairRequests: [
            {
              id: 'req-typo',
              deviceName: 'air',
              peerNode: 'dev-macbook-air',
              peerAddress: '100.4.4.4',
              comparisonCode: '481972',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      })
    )
  )
  await typeInto(codeInput(mounted), '48 19 7x2')
  click(buttonNamed(mounted, /^Allow/))
  await flush()
  assert.equal(bridge.approveCalls[0]?.code, '481972', 'digits only, six at most — what main is sent')
  assert.match(mounted.innerHTML, /2 tries left/, 'the mismatch reads beside the field')
  assert.equal(codeInput(mounted)?.value, '', 'cleared for another go')
  assert.equal(useToastStore.getState().toasts.length, 0, 'not a toast — the person is mid-typing')
  bridge.approveResult = { ok: true }
  unmount()
})

// ── phases 3 and 4: the waiting card, and rows that know whether the other end answers ──

run('a request this machine made shows its code large with the instruction to type it over there, and can be stopped', async () => {
  bridge.cancelCalls.length = 0
  const mounted = mount(
    popover(
      presence({
        fleetRequests: [
          {
            requestId: 'tpr_9',
            endpoint: '100.5.5.5:8471',
            machineName: 'dev-macbook-air',
            comparisonCode: '481972',
            expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
            reverseOffered: true,
          },
        ],
      })
    )
  )
  const markup = mounted.innerHTML
  assert.match(markup, /Waiting for dev-macbook-air/)
  assert.match(markup, /481 972/, 'the code, grouped the way it is read aloud')
  assert.match(markup, /Type this code on dev-macbook-air to allow it/)
  assert.match(markup, /also lets dev-macbook-air drive this Mac/, 'the reverse offer is said')
  click(buttonNamed(mounted, /Stop waiting/))
  await flush()
  assert.deepEqual(bridge.cancelCalls, ['tpr_9'])
  unmount()
})

run('machine rows read main’s reachability when no pane is open: reachable, not answering with Retry, revoked with Pair again', async () => {
  bridge.reachabilityCalls.length = 0
  let pairAgain = 0
  const mounted = mount(
    <RemotePopover
      presence={presence({
        fleet: [
          connection(),
          connection({ id: 'conn-2', machineName: 'Studio', endpoint: '100.1.1.2:8471' }),
          connection({ id: 'conn-3', machineName: 'Old box', endpoint: '100.1.1.3:8471' }),
        ],
        fleetReachability: new Map([
          ['conn-1', reach()],
          ['conn-2', reach({ connectionId: 'conn-2', machineName: 'Studio', reachable: false, detail: 'no answer', lastReachedAt: Date.now() - 2 * 3_600_000 })],
          ['conn-3', reach({ connectionId: 'conn-3', machineName: 'Old box', reachable: false, unauthorized: true, detail: 'Unauthorized.' })],
        ]),
      })}
      onOpenFleet={() => {
        pairAgain += 1
      }}
      onOpenRemoteSettings={() => {}}
    />
  )
  const markup = mounted.innerHTML
  assert.match(markup, /reachable · checked just now/)
  assert.match(markup, /aria-label="Reachable"/)
  assert.match(markup, /not answering · last reached 2 h ago/)
  assert.match(markup, /revoked there — pair again to reconnect/)
  assert.match(markup, /aria-label="Revoked there"/)
  click(buttonNamed(mounted, /^Retry/))
  await flush()
  assert.deepEqual(bridge.reachabilityCalls, ['conn-2'], 'Retry re-checks that one machine')
  click(buttonNamed(mounted, /Pair again/))
  assert.equal(pairAgain, 1, 'Pair again opens the picker')
  assert.equal(remoteGlyphState(presence({ fleet: [connection()], fleetReachability: new Map([['conn-1', reach({ reachable: false, unauthorized: true })]]) })).degraded, true, 'a revocation degrades the glyph')
  unmount()
})

void queue.then(() => {
  if (failures > 0) {
    console.error(`RemotePopover.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('RemotePopover.test.tsx: ok')
})
