import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// jsdom globals must exist before React mounts
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { RemoteTailnetSettingsTab } from './RemoteTailnetSettingsTab'
import { test } from 'vitest'

test('RemoteTailnetSettingsTab', async () => {
  // Settings → Remote, mounted (remote-settings-rebuild).
  //
  // What this pins is the shape of the rebuilt tab, because the rebuild was
  // mostly SUBTRACTION and a subtraction has no other test: the notifications
  // switch, the "This machine" block with its address and port, the Scan button,
  // the second and third lists of the same machines, and every helper sentence
  // are gone, and nothing but a mount can say so. What it adds is the one thing
  // the old tab could not do — see and widen a paired machine's scopes.

  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.document = dom.window.document
  anyGlobal.navigator = dom.window.navigator
  anyGlobal.HTMLElement = dom.window.HTMLElement
  anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
  anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
  anyGlobal.Node = dom.window.Node
  anyGlobal.MouseEvent = dom.window.MouseEvent
  anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
  anyGlobal.getComputedStyle = dom.window.getComputedStyle
  anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

  const bridge = {
    forgetCalls: [] as Array<{ deviceId?: string; connectionId?: string }>,
    scopeCalls: [] as Array<{ deviceId: string; scopes: string[] }>,
    offerCalls: [] as string[][],
    listPeersCalls: 0,
  }

  // Relative to the real clock, because the tab reads `Date.now()`: a fixed
  // timestamp would make the last-seen token drift with the calendar.
  const MINUTES_AGO_35 = new Date(Date.now() - 35 * 60_000).toISOString()
  const SECONDS_AGO_30 = new Date(Date.now() - 30_000).toISOString()

  const DEVICE = {
    id: 'tnd_1',
    name: 'DESKTOP-A1B2C3D',
    scopes: ['workspace:read', 'workspace:operate', 'backlog:read', 'backlog:operate'],
    createdAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: SECONDS_AGO_30,
    lastPeerNode: 'desktop-a1b2c3d.example.ts.net',
    origin: { kind: 'approval', by: 'desktop-a1b2c3d.example.ts.net' },
  }

  const STATUS = {
    enabled: true,
    running: true,
    endpoint: '100.64.0.66:8471',
    port: 8471,
    tailnetAddress: '100.64.0.66',
    lastError: null,
    notifications: true,
    devices: [DEVICE],
    pairing: null,
    pairRequests: [],
  }

  const PEERS = [
    {
      id: 'n0',
      hostName: 'mac-mini',
      dnsName: 'mac-mini.example.ts.net',
      address: '100.64.0.66',
      os: 'macOS',
      online: true,
      isSelf: true,
      lastSeenAt: null,
      studio: { product: 'SprintEngine Studio MCP', transportVersion: 1, protocolVersions: [] },
    },
    {
      id: 'n1',
      hostName: 'DESKTOP-A1B2C3D',
      dnsName: 'desktop-a1b2c3d.example.ts.net',
      address: '100.64.0.70',
      os: 'windows',
      online: true,
      isSelf: false,
      lastSeenAt: SECONDS_AGO_30,
      studio: { product: 'SprintEngine Studio MCP', transportVersion: 1, protocolVersions: [] },
    },
    {
      id: 'n2',
      hostName: 'Android-Phone',
      dnsName: 'android-phone.example.ts.net',
      address: '100.64.0.80',
      os: 'android',
      online: false,
      isSelf: false,
      lastSeenAt: MINUTES_AGO_35,
      studio: null,
    },
  ]

  ;(dom.window as unknown as { api: unknown }).api = {
    platform: 'darwin',
    tailnetGetStatus: () => Promise.resolve(STATUS),
    tailnetGetLiveState: () => Promise.resolve({ revision: 0, devices: [] }),
    tailnetSetEnabled: () => Promise.resolve(STATUS),
    tailnetOfferPairing: (scopes: string[]) => {
      bridge.offerCalls.push(scopes)
      return Promise.resolve({ token: 'mcpair_x', scopes, expiresAt: '2026-10-10T12:00:00.000Z', pairingUrl: null })
    },
    tailnetCancelPairing: () => Promise.resolve(STATUS),
    tailnetForgetMachine: (input: { deviceId?: string; connectionId?: string }) => {
      bridge.forgetCalls.push(input)
      return Promise.resolve({
        status: STATUS,
        connections: [],
        revokedDeviceId: input.deviceId ?? null,
        forgottenConnectionId: null,
      })
    },
    tailnetUpdateDeviceScopes: (deviceId: string, scopes: string[]) => {
      bridge.scopeCalls.push({ deviceId, scopes })
      return Promise.resolve(STATUS)
    },
    tailnetListPeers: () => {
      bridge.listPeersCalls += 1
      return Promise.resolve({ tailscaleAvailable: true, unavailableReason: null, probedPort: 8471, peers: PEERS })
    },
    fleetListConnections: () => Promise.resolve([]),
    fleetGetLiveState: () => Promise.resolve({ revision: 0, attachments: [], requests: [], reachability: [] }),
    onTailnetEvent: () => () => {},
    onFleetEvent: () => () => {},
    clipboardWriteText: () => Promise.resolve(),
  }

  let failures = 0
  let queue: Promise<void> = Promise.resolve()
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

  async function mount(): Promise<{ host: HTMLElement; unmount: () => void }> {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.append(host)
    let root: Root | null = null
    await act(async () => {
      root = createRoot(host)
      root.render(<RemoteTailnetSettingsTab />)
    })
    // Let the mount-time reads (status, peers, presence) settle.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    return {
      host,
      unmount: () => {
        act(() => root?.unmount())
        host.remove()
      },
    }
  }

  function buttonNamed(host: HTMLElement, name: RegExp): HTMLButtonElement | null {
    return (
      [...host.querySelectorAll('button')].find((button) =>
        name.test((button.getAttribute('aria-label') ?? button.textContent ?? '').trim()),
      ) ?? null
    )
  }

  run('the tab is a header, one switch, and one list of machines', async () => {
    const { host, unmount } = await mount()
    const markup = host.innerHTML

    assert.match(markup, /Remote/)
    assert.match(markup, /Listening/, 'the listener state is the page’s one status word')
    assert.match(markup, /Remote control over your tailnet/)
    assert.match(markup, /Machines/)

    // The subtractions, each of which was its own row or section before.
    assert.doesNotMatch(markup, /Pairing notifications/, 'the notifications switch is gone from the UI')
    assert.doesNotMatch(markup, /This machine/, 'no This machine block')
    assert.doesNotMatch(markup, /100\.91\.70\.66/, 'no tailnet address anywhere')
    assert.doesNotMatch(markup, /8471/, 'no port, and no endpoint')
    assert.doesNotMatch(markup, />Scan</, 'the scan runs by itself')
    assert.doesNotMatch(markup, /same tools a local agent has/, 'every helper sentence is cut')
    assert.doesNotMatch(markup, /Scan to see the machines/)
    assert.doesNotMatch(markup, /Connect to another Studio/)

    // One row per Tailscale node, merged from devices + peers.
    assert.equal(host.querySelectorAll('[data-machine]').length, 3, 'this machine, the paired desktop, the phone')
    assert.match(markup, /This device/, 'the self row carries the chip')
    assert.match(markup, /Windows/)
    assert.match(markup, /4 scopes/, 'the scope count is the row’s one link')
    assert.match(markup, /Live/)
    // Never the word "offline": an asleep machine is not in an error state.
    assert.doesNotMatch(markup, /Offline/)
    assert.match(markup, /title="Last seen 35 minutes ago"/, 'the token’s long form rides the title')

    assert.ok(bridge.listPeersCalls > 0, 'the peer scan ran on mount with no Scan button')
    unmount()
  })

  run('the scopes popover names what is missing, and Grant widens the device', async () => {
    const { host, unmount } = await mount()
    const trigger = buttonNamed(host, /^4 scopes$/)
    assert.ok(trigger, 'the count is a button')
    await act(async () => {
      trigger?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    // The surface is portaled to <body>.
    const surface = dom.window.document.body.querySelector('[role="dialog"]')
    assert.ok(surface, 'the popover opened')
    const text = surface?.textContent ?? ''
    assert.match(text, /Granted scopes/)
    assert.match(text, /workspace:operate/)
    assert.match(text, /Not granted/)
    assert.match(text, /terminal:observe/)
    assert.match(text, /terminal:control/)
    // The sentence the whole rebuild exists for.
    assert.match(text, /can't see chats or terminals here/)

    const grant = [...dom.window.document.body.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === 'Grant',
    )
    assert.ok(grant, 'Grant is offered beside the missing set')
    await act(async () => {
      grant?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(bridge.scopeCalls.at(-1)?.deviceId, 'tnd_1')
    assert.deepEqual(bridge.scopeCalls.at(-1)?.scopes, [
      'workspace:read',
      'workspace:operate',
      'backlog:read',
      'backlog:operate',
      'terminal:observe',
      'terminal:control',
    ])
    unmount()
  })

  run('Revoke ends both halves through one call', async () => {
    const { host, unmount } = await mount()
    const revoke = buttonNamed(host, /^Revoke$/)
    assert.ok(revoke, 'a paired row offers Revoke')
    await act(async () => {
      revoke?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    // Both ids go in every time: a row that revoked only the inbound device left
    // the outbound credential live, and the machine kept answering.
    assert.deepEqual(bridge.forgetCalls.at(-1), { deviceId: 'tnd_1', connectionId: undefined })
    unmount()
  })

  run('Pair a device opens the modal, and Create link mints the chosen set', async () => {
    const { host, unmount } = await mount()
    const pair = buttonNamed(host, /^Pair a device$/)
    assert.ok(pair, 'the split button’s primary half')
    await act(async () => {
      pair?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    const dialog = dom.window.document.body.querySelector('[role="dialog"][aria-modal="true"]')
    assert.ok(dialog, 'the modal opened')
    const text = dialog?.textContent ?? ''
    assert.match(text, /Pair a device/)
    assert.match(text, /Read only/)
    assert.match(text, /Standard/)
    // Every row, named for what it reveals.
    assert.match(text, /Watch chats & terminals/)
    assert.match(text, /Drive chats & terminals/)
    assert.match(text, /Arbitrary shell on this machine/)
    assert.equal(dialog?.querySelectorAll('input[type="checkbox"]').length, 6)
    // Standard is the default preset, terminal:control included (owner ruling
    // 2026-09-10) — so every box is ticked when the dialog opens.
    assert.equal(dialog?.querySelectorAll('input[type="checkbox"]:checked').length, 6)

    const create = [...dom.window.document.body.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === 'Create link',
    )
    await act(async () => {
      create?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(bridge.offerCalls.at(-1), [
      'workspace:read',
      'workspace:operate',
      'backlog:read',
      'backlog:operate',
      'terminal:observe',
      'terminal:control',
    ])
    unmount()
  })

  const suiteRun = queue.then(() => {
    if (failures > 0) {
      console.error(`${failures} check(s) failed`)
      process.exit(1)
    }
    console.log('RemoteTailnetSettingsTab.test.tsx: ok')
  })

  await suiteRun
})
