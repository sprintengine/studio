import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// jsdom globals must exist before React mounts
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  RemotePopover,
  deviceLivenessText,
  fleetMachinePhase,
  machinePhaseText,
  remoteGlyphState,
  remoteGlyphToneClass,
  remoteGlyphTooltip,
} from './RemotePopover'
import { drivenTerminalView, shortMachineName } from '../../remote/machineRowModel'
import { fleetLiveSessionsOf, type TailnetPresence } from './useTailnetPresence'
import { useToastStore } from '../../../store/toastStore'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { refreshTerminalSessions } from '../../../hooks/terminalSessionsStore'
import type { TailnetLiveDevice, TailnetRemoteStatus } from '../../../../../shared/tailnet'
import type {
  FleetConnection,
  FleetLiveAttachment,
  FleetMachineReachability,
} from '../../../../../shared/tailnet-fleet'
import { test } from 'vitest'

test('RemotePopover', async () => {
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
    approveResult: { ok: true } as {
      ok: boolean
      code?: string
      message?: string
      attemptsLeft?: number
      declined?: boolean
    },
    approveCalls: [] as Array<{ id: string; scopes: string[]; code: string }>,
    reachabilityCalls: [] as Array<string | undefined>,
    cancelCalls: [] as string[],
    forgetCalls: [] as string[],
    terminalSessions: [] as Array<Record<string, unknown>>,
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
    fleetForget: (connectionId: string) => {
      bridge.forgetCalls.push(connectionId)
      return Promise.resolve([])
    },
    // The driven-terminal line reads the terminal-session store, which seeds
    // itself from these two.
    terminalList: () => Promise.resolve(bridge.terminalSessions),
    onTerminalSessionsChanged: () => () => {},
  }

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
      endpoint: '100.64.0.66:8471',
      port: 8471,
      tailnetAddress: '100.64.0.66',
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
      machineName: 'Sam’s MacBook Air',
      endpoint: '100.64.0.101:8471',
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
      machineName: 'Sam’s MacBook Air',
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
      peerAddress: '100.64.0.101',
      ...overrides,
    }
  }

  function attachments(
    list: Array<Partial<FleetLiveAttachment> & { attachId: string }>,
  ): Map<string, FleetLiveAttachment> {
    return new Map(
      list.map((entry) => [
        entry.attachId,
        {
          connectionId: 'conn-1',
          machineName: 'Sam’s MacBook Air',
          sessionId: 's1',
          state: 'live',
          detail: '',
          ...entry,
        },
      ]),
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
      fleetRemoteChanges: new Map(),
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
  /** The row actions are glyphs now: they are addressed by their accessible name. */
  function buttonLabelled(mounted: HTMLElement, label: RegExp): HTMLButtonElement | null {
    return (
      [...mounted.querySelectorAll('button')].find((button) => label.test(button.getAttribute('aria-label') ?? '')) ??
      null
    )
  }
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }
  function popover(p: TailnetPresence, onOpenRemoteSettings: () => void = () => {}) {
    return <RemotePopover presence={p} onOpenRemoteSettings={onOpenRemoteSettings} />
  }

  // ── derivation ───────────────────────────────────────────────────────────

  run('the glyph is absent while the feature is off and nothing is paired — not present-but-empty', () => {
    assert.equal(
      remoteGlyphState(presence({ status: status({ enabled: false, running: false, endpoint: null }) })).visible,
      false,
    )
    assert.equal(remoteGlyphState(presence({ status: null })).visible, false)
  })

  run('a paired fleet machine earns the glyph even with the inbound listener off', () => {
    const state = remoteGlyphState(
      presence({ status: status({ enabled: false, running: false, endpoint: null }), fleet: [connection()] }),
    )
    assert.equal(state.visible, true)
  })

  run(
    'driving = a device attached to a terminal HERE; connected covers both directions; degraded = a link in trouble',
    () => {
      const driving = remoteGlyphState(
        presence({ live: { revision: 1, devices: [device({ attachedTerminalSessions: ['t1'] })] } }),
      )
      assert.equal(driving.driving, true)
      assert.equal(driving.connected, true)
      assert.equal(driving.degraded, false)
      const outbound = remoteGlyphState(
        presence({ fleet: [connection()], fleetAttachments: attachments([{ attachId: 'a', state: 'live' }]) }),
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
        }),
      )
      assert.equal(degraded.connected, true, 'one live link still counts as connected')
      assert.equal(degraded.degraded, true, 'and the reconnecting one makes it degraded — the warn dot')
      assert.equal(
        remoteGlyphState(presence({ fleetAttachments: attachments([{ attachId: 'a', state: 'connecting' }]) }))
          .degraded,
        false,
        'a first dial is not degradation',
      )
    },
  )

  run(
    'a machine’s phase is derived from its links, by precedence: live > reconnecting > connecting > offline > paired',
    () => {
      const byAttach = (list: Array<Partial<FleetLiveAttachment> & { attachId: string }>) =>
        fleetMachinePhase('conn-1', attachments(list))
      assert.deepEqual(byAttach([]), { phase: 'paired' })
      assert.deepEqual(byAttach([{ attachId: 'a', state: 'connecting', detail: 'Connecting to Air.' }]), {
        phase: 'connecting',
        detail: 'Connecting to Air.',
      })
      assert.equal(
        byAttach([
          { attachId: 'a', state: 'reconnecting' },
          { attachId: 'b', state: 'connecting' },
        ]).phase,
        'reconnecting',
      )
      assert.equal(byAttach([{ attachId: 'a', state: 'offline' }]).phase, 'offline')
      assert.deepEqual(
        byAttach([
          { attachId: 'a', state: 'live', sessionId: 's1' },
          { attachId: 'b', state: 'live', sessionId: 's1' },
          { attachId: 'c', state: 'live', sessionId: 's2' },
          { attachId: 'd', state: 'offline', sessionId: 's3' },
        ]),
        { phase: 'connected', liveSessions: 2 },
        'a live link wins, and sessions are counted, not panes',
      )
      assert.equal(
        byAttach([{ attachId: 'a', state: 'live', connectionId: 'other' }]).phase,
        'paired',
        'another machine’s links do not count',
      )
      const now = Date.now()
      assert.equal(machinePhaseText('Air', { phase: 'connecting', detail: '' }, now), 'Connecting to Air…')
      assert.equal(machinePhaseText('Air', { phase: 'reconnecting', detail: '' }, now), 'Reconnecting to Air…')
      assert.equal(machinePhaseText('Air', { phase: 'offline', detail: '' }, now), 'Air is not answering')
    },
  )

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
    assert.equal(
      deviceLivenessText({ connectedSince: now - 12 * 60_000, lastActivityAt: now }, now),
      'Connected for 12m',
    )
    assert.equal(deviceLivenessText({ connectedSince: now - 20_000, lastActivityAt: now }, now), 'Connected for 20s')
    assert.equal(
      deviceLivenessText({ connectedSince: null, lastActivityAt: now - 3 * 60_000 }, now),
      'Last seen 3m ago',
    )
  })

  run(
    'the glyph itself carries the state: green for serving or connected, pulsing amber only when someone is wanted',
    () => {
      const tone = (p: TailnetPresence) => remoteGlyphToneClass(remoteGlyphState(p))
      assert.match(tone(presence()), /tone-good/, 'serving alone is green — this Studio can be reached')
      assert.match(
        tone(presence({ live: { revision: 1, devices: [device({ attachedTerminalSessions: ['t1'] })] } })),
        /tone-good/,
        'a phone driving a terminal is the feature working, not a summons',
      )
      assert.doesNotMatch(
        tone(presence({ live: { revision: 1, devices: [device()] } })),
        /animate-pulse/,
        'and green never pulses',
      )
      const waiting = presence({
        status: status({
          pairRequests: [
            {
              id: 'r1',
              deviceName: 'air',
              peerNode: null,
              peerAddress: '100.9.9.9',
              comparisonCode: '000000',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      })
      assert.match(tone(waiting), /animate-pulse[\s\S]*tone-warn/, 'a waiting pair request wants a person')
      // Owner ruling 2026-09-05: a machine that stopped answering says so on its
      // own glyph in the popover; the top-bar glyph stays green while this device is
      // reachable, and only a pair request may pulse it.
      assert.match(
        tone(
          presence({
            fleet: [connection()],
            fleetReachability: new Map([['conn-1', reach({ reachable: false, detail: 'no answer' })]]),
          }),
        ),
        /tone-good/,
        'a quiet machine does not alarm the glyph',
      )
      assert.doesNotMatch(
        tone(
          presence({
            status: status({
              running: false,
              lastError: 'Tailnet remote control is enabled but no Tailscale interface was found.',
            }),
          }),
        ),
        /tone-good|tone-warn|tone-error/,
        'off the tailnet the glyph is the default ink — grey, never red: offline is not an error',
      )
      assert.equal(
        tone(presence({ status: status({ running: false, endpoint: null }) })),
        '',
        'idle remote takes the default ink',
      )
    },
  )

  run('a machine is named by its first label: the tailnet tail is the same on every row', () => {
    assert.equal(shortMachineName('sam-macbook-air.tailabc123.ts.net'), 'sam-macbook-air')
    assert.equal(shortMachineName('android-phone'), 'android-phone')
    assert.equal(shortMachineName('Sam’s MacBook Air'), 'Sam’s MacBook Air', 'a typed name is left alone')
    assert.equal(shortMachineName('Air. Studio'), 'Air. Studio', 'a full stop in a name is not a domain')
    assert.equal(shortMachineName('100.64.0.101'), '100.64.0.101', 'an address is not shortened into a lie')
  })

  // ── the surface ──────────────────────────────────────────────────────────

  run(
    'the popover lists the driving device and the machines — no addresses anywhere — and hosts the ACTING pair-request card',
    () => {
      const mounted = mount(
        popover(
          presence({
            status: status({
              pairRequests: [
                {
                  id: 'req1',
                  deviceName: 'macbook-air',
                  peerNode: 'sam-macbook-air',
                  peerAddress: '100.64.0.101',
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
          }),
        ),
      )
      const markup = mounted.innerHTML
      // Owner ruling 2026-09-05: a popover opened on a shared screen does not
      // enumerate a tailnet. No listening endpoint, no peer address, no machine's
      // endpoint — the state is the answer, and Settings → Remote holds the rest.
      assert.doesNotMatch(markup, /100\.91\.70\.66/, 'this machine\u2019s endpoint is not here')
      assert.doesNotMatch(markup, /100\.106\.119\.1/, 'nor the peer the transport saw')
      assert.doesNotMatch(markup, /This machine/, 'one list, not two headings')
      // Owner ruling 2026-09-05: the header is the name and the count. Whether
      // this device is on the tailnet is the glyph's ink and the glyph's tooltip.
      assert.doesNotMatch(markup, /Serving/, 'no listener word in the header')
      for (const row of mounted.querySelectorAll('[data-machine-phase]')) {
        assert.doesNotMatch(row.innerHTML, /rounded-full/, 'no status dot on a machine row — the glyph is the status')
      }
      assert.match(markup, /data-tailnet-listening="true"/)
      assert.match(markup, /Sprint Engine Android/)
      assert.match(markup, /Driving /, 'what it is driving reads on its own line')
      assert.doesNotMatch(markup, /agent-standup/, 'never the session id — the one thing on the row nobody can read')
      assert.match(markup, /Connected for 12m/, 'connected-for from connectedSince')
      assert.match(markup, /tabular-nums/, 'durations in tabular figures')
      // Connected is green and steady, driving or not: amber is this app's word
      // for "someone has to do something", and a phone typing into a terminal is
      // the feature working (owner ruling 2026-09-05).
      const drivingGlyph = mounted.querySelector('[aria-label="Driving a terminal"]')
      assert.ok(drivingGlyph, 'the driving device is announced on its glyph')
      assert.match(drivingGlyph?.innerHTML ?? '', /--tone-good/, 'and the glyph is green')
      assert.ok(
        buttonLabelled(mounted, /^Revoke Sprint Engine Android$/),
        'a red X revokes the device — the word is in its name and tooltip',
      )
      // The card: the proven node and the declared name, each labelled.
      assert.match(markup, /sam-macbook-air/)
      assert.match(markup, /asks to pair/)
      assert.match(markup, /Tailnet node/)
      assert.match(markup, /Calls itself/)
      assert.match(markup, /macbook-air/)
      // Phase 2: the code is TYPED here, not displayed — the digits live on the asker's screen.
      assert.doesNotMatch(markup, /481972/, 'the comparison code is not shown on the approving side')
      assert.match(markup, /Enter the code shown on sam-macbook-air/)
      assert.ok(codeInput(mounted), 'a numeric code input')
      assert.ok(buttonNamed(mounted, /^Allow/)?.disabled, 'Allow is dead until six digits are typed')
      // The scope rows are the shared `ScopePicker` now (remote-settings-rebuild):
      // one row per scope, named for what it reveals rather than for the transport.
      // "Terminals — control" read as being about shells; the scope also shows every
      // cross-machine conversation, so the row says so.
      assert.match(markup, /Watch chats &amp; terminals/)
      assert.match(markup, /Drive chats &amp; terminals/)
      assert.match(markup, /Arbitrary shell on this machine/)
      assert.match(markup, /Allow/)
      assert.match(markup, /Decline/)
      assert.doesNotMatch(markup, /Review/, 'no pointer elsewhere — the card acts, right here')
      // Machines: the shared remote glyph leads the row, the phase dot and text follow.
      assert.match(markup, /Sam’s MacBook Air/)
      assert.match(markup, /2 terminals attached/)
      assert.match(markup, /data-machine-answering="true"/, 'a machine with a live link is answering')
      assert.match(markup, /aria-label="Answering"/, 'said on its glyph')
      assert.match(markup, /Remote settings/)
      unmount()
    },
  )

  run('machine rows narrate the transitional and failed phases with the phase dot table', () => {
    const mounted = mount(
      popover(
        presence({
          fleet: [
            connection(),
            connection({ id: 'conn-2', machineName: 'Mini', endpoint: '100.1.1.2:8471' }),
            connection({ id: 'conn-3', machineName: 'Studio', endpoint: '100.1.1.3:8471' }),
          ],
          fleetAttachments: attachments([
            { attachId: 'a', state: 'reconnecting', connectionId: 'conn-1', detail: 'Reconnecting.' },
            { attachId: 'b', state: 'offline', connectionId: 'conn-2', machineName: 'Mini' },
          ]),
        }),
      ),
    )
    const markup = mounted.innerHTML
    assert.match(markup, /Reconnecting to Sam’s MacBook Air…/)
    assert.doesNotMatch(
      markup,
      /status-dot-pulse/,
      'no dots: the words carry the transitional phase, the glyph stays in the default ink',
    )
    assert.match(markup, /Mini is not answering/)
    assert.match(markup, /aria-label="Not answering"/)
    assert.match(markup, /paired/, 'a machine with no link is paired, nothing more claimed')
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
        }),
      ),
    )
    const allow = buttonNamed(mounted, /^Allow/)
    const decline = buttonNamed(mounted, /^Decline/)
    assert.ok(allow?.disabled, 'Allow is dead')
    assert.ok(decline?.disabled, 'Decline is dead')
    assert.match(mounted.innerHTML, /Lapsed/)
    assert.match(mounted.innerHTML, /lapsed before it was answered/)
    assert.match(
      mounted.innerHTML,
      /Address \(unverified\)/,
      'an unresolved peer is shown as the address, marked unverified',
    )
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
        }),
      ),
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
    const revoke = buttonLabelled(mounted, /^Revoke/)
    assert.ok(revoke && !revoke.disabled)
    click(revoke)
    assert.deepEqual(bridge.revokeCalls, ['d1'])
    assert.ok(buttonLabelled(mounted, /^Revoke/)?.disabled, 'busy and disabled while main answers')
    // A second click while pending must not fire a second revoke.
    click(buttonLabelled(mounted, /^Revoke/))
    assert.deepEqual(bridge.revokeCalls, ['d1'])
    await act(async () => {
      bridge.revokeResolve?.()
      await Promise.resolve()
    })
    await flush()
    assert.ok(buttonLabelled(mounted, /^Revoke/) && !buttonLabelled(mounted, /^Revoke/)?.disabled, 'idle again')
    assert.equal(useToastStore.getState().toasts.length, 0, 'success is quiet — the push channel removes the row')

    bridge.revokeFail = new Error('IPC went away')
    click(buttonLabelled(mounted, /^Revoke/))
    await flush()
    const toast = useToastStore.getState().toasts[0]
    assert.equal(toast?.tone, 'error')
    assert.match(toast?.title ?? '', /Could not revoke Sprint Engine Android/)
    assert.equal(toast?.description, 'IPC went away')
    bridge.revokeFail = null
    unmount()
  })

  run('a quiet popover says so rather than rendering empty sections', () => {
    const mounted = mount(popover(presence()))
    assert.match(mounted.innerHTML, /No machines connected\./)
    assert.doesNotMatch(mounted.innerHTML, /No machines paired\./, 'one list, one empty line')
    assert.match(mounted.innerHTML, /Add a machine…/, 'the way in is offered from the popover itself')
    assert.match(mounted.innerHTML, /Remote settings/, 'beside the settings tab that holds the rest')
    assert.doesNotMatch(mounted.innerHTML, /Open Fleet/, 'the Fleet panel is retired — no button into it')
    unmount()
  })

  run(
    "off the tailnet the popover says nothing in its header and grays every machine; the words are the glyph tooltip's",
    () => {
      const error = 'Tailnet remote control is enabled but no Tailscale address was found.'
      const p = presence({
        status: status({ running: false, lastError: error }),
        fleet: [connection()],
        fleetReachability: new Map([['conn-1', reach()]]),
      })
      const mounted = mount(popover(p))
      const header = mounted.querySelector('header')
      assert.ok(header, 'the panel header is there')
      // Owner ruling 2026-09-05: no dot and no sentence in the header. The glyph
      // that opened this popover is grey, its tooltip says why, and every row is
      // drawn in disabled ink — remembered, not reachable.
      assert.doesNotMatch(
        header!.textContent ?? '',
        /Tailnet remote control|Not serving|Serving/,
        'the header is the name and the count',
      )
      assert.ok(!header!.querySelector('[class*="status-dot"]'), 'and carries no dot')
      assert.match(mounted.innerHTML, /data-tailnet-listening="false"/)
      assert.match(
        mounted.innerHTML,
        /aria-label="Not connected to Tailscale"/,
        'the machine glyph says why it is grey',
      )
      assert.match(mounted.innerHTML, /--text-disabled/, 'the machine row is in disabled ink')
      assert.doesNotMatch(mounted.innerHTML, /Check whether/, 'no Retry: nothing here can ask')
      assert.doesNotMatch(
        mounted.innerHTML,
        /data-machine-answering="true"/,
        'a machine main last saw answering is not claimed answering now',
      )
      const state = remoteGlyphState(p)
      assert.equal(state.serving, false)
      assert.equal(state.answering, 0, 'nothing answers while this device is off the tailnet')
      assert.match(remoteGlyphTooltip(state), /not connected to Tailscale/)
      assert.match(remoteGlyphTooltip(state), /no Tailscale address/, 'the error rides the tooltip')
      assert.match(
        remoteGlyphTooltip(
          remoteGlyphState(presence({ fleet: [connection()], fleetReachability: new Map([['conn-1', reach()]]) })),
        ),
        /live · 1 machine answering/,
      )
      assert.equal(
        remoteGlyphState(presence({ fleet: [connection()], fleetReachability: new Map([['conn-1', reach()]]) }))
          .answering,
        1,
        'the count the glyph wears',
      )
      unmount()
    },
  )

  run('what a phone is driving is resolved to a name, and an unplaceable session still gets a line', () => {
    const sessions = [
      { sessionId: 's-agent', workspaceId: 'ws1', agentId: 'a1', agentName: 'launch-checks' },
      { sessionId: 's-loose', agentName: 'roaming-agent-7' },
    ]
    const named = drivenTerminalView('s-agent', sessions, () => 'Fix the login bug')
    assert.equal(named.label, 'Fix the login bug', 'the workspace agent’s own name wins')
    assert.deepEqual(named.target, { workspaceId: 'ws1', agentId: 'a1' })
    assert.equal(
      drivenTerminalView('s-agent', sessions, () => null).label,
      'launch-checks',
      'else the session manager’s label',
    )
    assert.deepEqual(
      drivenTerminalView('s-loose', sessions, () => null),
      { label: 'roaming-agent-7', target: null },
    )
    assert.deepEqual(
      drivenTerminalView('s-gone', sessions, () => null),
      { label: 'a terminal', target: null },
    )
  })

  run('the driven line names the agent and opens it — never the session id', async () => {
    bridge.terminalSessions = [
      {
        sessionId: 'sess-1',
        workspaceId: 'ws1',
        agentId: 'agent-1',
        agentName: 'launch-checks',
        processAlive: true,
        kind: 'agent',
        activity: { kind: 'idle', since: 0 },
      },
    ]
    act(() => {
      useWorkspaceStore.setState({
        activeWorkspaceId: null,
        workspaces: [
          { id: 'ws1', name: 'sprintengine', agents: { 'agent-1': { id: 'agent-1', name: 'Fix the login bug' } } },
        ],
      } as never)
    })
    const mounted = mount(
      popover(presence({ live: { revision: 1, devices: [device({ attachedTerminalSessions: ['sess-1'] })] } })),
    )
    // The terminal-session store seeds itself from `terminalList`; the test
    // asks for that read rather than racing the store's own connect.
    await act(async () => {
      await refreshTerminalSessions()
    })
    const link = buttonNamed(mounted, /Fix the login bug/)
    assert.ok(link, 'the agent is named, and it is a button')
    assert.doesNotMatch(mounted.innerHTML, /sess-1/, 'the session id is gone from the surface')
    click(link)
    await flush()
    assert.equal(
      useWorkspaceStore.getState().activeWorkspaceId,
      'ws1',
      'clicking it goes to the workspace holding that agent',
    )
    bridge.terminalSessions = []
    unmount()
  })

  run('a paired machine can be dropped from here, and the half only they can do is said', async () => {
    act(() => {
      useToastStore.setState({ toasts: [] })
    })
    bridge.forgetCalls.length = 0
    const mounted = mount(popover(presence({ fleet: [connection()] })))
    click(buttonLabelled(mounted, /^Remove Sam’s MacBook Air/))
    await flush()
    assert.deepEqual(bridge.forgetCalls, ['conn-1'])
    const toast = useToastStore.getState().toasts[0]
    assert.match(toast?.title ?? '', /Sam’s MacBook Air disconnected/)
    assert.match(toast?.description ?? '', /Revoke “mini”/, 'the grant over there is theirs to end')
    unmount()
  })

  // ── phase 2: a wrong code is refused inline, the third declines ──────────

  run('a wrong code is refused beside the field, in main’s words, and the field clears for another try', async () => {
    act(() => {
      useToastStore.setState({ toasts: [] })
    })
    bridge.approveCalls.length = 0
    bridge.approveResult = {
      ok: false,
      code: 'code_mismatch',
      message: 'That code did not match. 2 tries left.',
      attemptsLeft: 2,
      declined: false,
    }
    const mounted = mount(
      popover(
        presence({
          status: status({
            pairRequests: [
              {
                id: 'req-typo',
                deviceName: 'air',
                peerNode: 'sam-macbook-air',
                peerAddress: '100.4.4.4',
                comparisonCode: '481972',
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            ],
          }),
        }),
      ),
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

  run(
    'a request this machine made shows its code large with the instruction to type it over there, and can be stopped',
    async () => {
      bridge.cancelCalls.length = 0
      const mounted = mount(
        popover(
          presence({
            fleetRequests: [
              {
                requestId: 'tpr_9',
                endpoint: '100.5.5.5:8471',
                machineName: 'sam-macbook-air',
                comparisonCode: '481972',
                expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
                reverseOffered: true,
              },
            ],
          }),
        ),
      )
      const markup = mounted.innerHTML
      assert.match(markup, /Waiting for sam-macbook-air/)
      assert.match(markup, /481 972/, 'the code, grouped the way it is read aloud')
      assert.match(markup, /Type this code on sam-macbook-air to allow it/)
      assert.match(markup, /also lets sam-macbook-air drive this device/, 'the reverse offer is said')
      click(buttonNamed(mounted, /Stop waiting/))
      await flush()
      assert.deepEqual(bridge.cancelCalls, ['tpr_9'])
      unmount()
    },
  )

  run(
    'machine rows read main’s reachability when no pane is open: reachable, not answering with Retry, revoked with Pair again',
    async () => {
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
              [
                'conn-2',
                reach({
                  connectionId: 'conn-2',
                  machineName: 'Studio',
                  reachable: false,
                  detail: 'no answer',
                  lastReachedAt: Date.now() - 2 * 3_600_000,
                }),
              ],
              [
                'conn-3',
                reach({
                  connectionId: 'conn-3',
                  machineName: 'Old box',
                  reachable: false,
                  unauthorized: true,
                  detail: 'Unauthorized.',
                }),
              ],
            ]),
          })}
          onOpenRemoteSettings={() => {
            pairAgain += 1
          }}
        />,
      )
      const markup = mounted.innerHTML
      // A machine that answers gets no line under its name (owner ruling
      // 2026-09-05): green is the whole message, and when the check ran is not a
      // fact anyone acts on.
      assert.doesNotMatch(markup, /checked just now/)
      assert.match(markup, /data-machine-answering="true"/)
      assert.match(markup, /aria-label="Answering"/)
      assert.match(
        markup,
        /not answering · 2 h/,
        'how long it has been silent — not a second clause about when it last was not',
      )
      assert.doesNotMatch(markup, /last reached/)
      assert.match(markup, /revoked there — pair again to reconnect/)
      assert.match(markup, /aria-label="Revoked there"/)
      click(buttonLabelled(mounted, /^Check whether Studio is answering$/))
      await flush()
      assert.deepEqual(bridge.reachabilityCalls, ['conn-2'], 'Retry re-checks that one machine')
      click(buttonNamed(mounted, /Pair again/))
      assert.equal(pairAgain, 1, 'Pair again opens the picker')
      assert.equal(
        remoteGlyphState(
          presence({
            fleet: [connection()],
            fleetReachability: new Map([['conn-1', reach({ reachable: false, unauthorized: true })]]),
          }),
        ).degraded,
        true,
        'a revocation degrades the glyph',
      )
      unmount()
    },
  )

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`RemotePopover.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('RemotePopover.test.tsx: ok')
  })

  await suiteRun
})
