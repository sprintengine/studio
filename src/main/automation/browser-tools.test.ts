import assert from 'node:assert/strict'

import type { BrowserTabState } from '../../shared/browser'
import type { BrowserViewport } from '../../shared/browser-devices'
import type { McpConnectionContext, McpToolRegistration } from '../../shared/modules/mcp-tools'
import { BROWSER_MUTATION_TOOL_NAMES, createBrowserTools, type BrowserToolsDeps, type BrowserToolsManager } from './browser-tools'
import { isStudioGatewayMutation } from './studio-gateway-tools'

function run(name: string, body: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(body)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`)
      throw error
    })
}

function tabState(tabId: string, url: string, overrides: Partial<BrowserTabState> = {}): BrowserTabState {
  return {
    tabId,
    url,
    documentUrl: url,
    title: '',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: null,
    zoomFactor: 1,
    colorScheme: 'system',
    devToolsOpen: false,
    controller: 'none',
    ...overrides,
  }
}

type Harness = {
  tools: Map<string, McpToolRegistration>
  tabs: Map<string, { workspaceId: string; state: BrowserTabState }>
  active: Map<string, string>
  /** `<workspaceId>\0<agentId>` -> tabId, mirroring the real manager. */
  assignments: Map<string, string>
  calls: string[]
  viewports: Array<{ tabId: string; viewport: BrowserViewport }>
  openRequests: Array<{ workspaceId: string; url: string | null; tabId?: string | null }>
  manager: BrowserToolsManager
}

function harness(controlOverrides: Partial<BrowserToolsDeps['control']> = {}): Harness {
  const tabs = new Map<string, { workspaceId: string; state: BrowserTabState }>()
  const active = new Map<string, string>()
  const assignments = new Map<string, string>()
  const assignmentKey = (workspaceId: string, agentId: string) => `${workspaceId}\u0000${agentId}`
  const calls: string[] = []
  const viewports: Harness['viewports'] = []
  const openRequests: Harness['openRequests'] = []
  const manager: BrowserToolsManager = {
    listTabs: (workspaceId) => [...tabs.values()].filter((tab) => tab.workspaceId === workspaceId).map((tab) => tab.state),
    state: (tabId) => tabs.get(tabId)?.state ?? null,
    activeTab: (workspaceId) => {
      const preferred = active.get(workspaceId)
      if (preferred && tabs.has(preferred)) return { tabId: preferred }
      const first = [...tabs.entries()].find(([, tab]) => tab.workspaceId === workspaceId)
      return first ? { tabId: first[0] } : null
    },
    assignedTab: (workspaceId, agentId) => {
      const tabId = assignments.get(assignmentKey(workspaceId, agentId))
      if (tabId && tabs.get(tabId)?.workspaceId === workspaceId) return { tabId }
      assignments.delete(assignmentKey(workspaceId, agentId))
      return null
    },
    assignTab: (workspaceId, agentId, tabId) => {
      if (tabs.get(tabId)?.workspaceId === workspaceId) assignments.set(assignmentKey(workspaceId, agentId), tabId)
    },
    requestOpen: (workspaceId, url, tabId = null) => {
      openRequests.push({ workspaceId, url, tabId })
    },
    requestViewport: (tabId, viewport) => {
      viewports.push({ tabId, viewport })
    },
    navigate: (tabId, url) => {
      const tab = tabs.get(tabId)
      if (!tab) return false
      calls.push(`navigate:${tabId}:${url}`)
      tab.state = { ...tab.state, url, documentUrl: url, loading: false }
      return true
    },
    back: (tabId) => {
      calls.push(`back:${tabId}`)
      return tabs.get(tabId)?.state.canGoBack ?? false
    },
    forward: () => false,
    reload: (tabId, ignoreCache) => {
      calls.push(`reload:${tabId}:${ignoreCache ? 'hard' : 'soft'}`)
      return tabs.has(tabId)
    },
    setColorScheme: (tabId, scheme) => {
      calls.push(`scheme:${tabId}:${scheme}`)
      return tabs.has(tabId)
    },
    noteAgentActivity: (tabId) => {
      calls.push(`badge:${tabId}`)
    },
  }
  const control: BrowserToolsDeps['control'] = {
    snapshot: async () => ({ ok: true, text: '- button "Save" [ref=e1]', nodeCount: 1, truncated: false, url: 'http://localhost:5173/', title: 'App' }),
    screenshot: async () => ({ ok: true, data: 'AAAA', mimeType: 'image/jpeg', width: 800, height: 600 }),
    click: async (_tabId, target) => {
      calls.push(`click:${target.ref ?? target.selector}`)
      return { ok: true }
    },
    hover: async () => ({ ok: true }),
    type: async (_tabId, target, text, options = {}) => {
      calls.push(`type:${target?.ref ?? '-'}:${text}:${options.clear ? 'clear' : ''}${options.submit ? 'submit' : ''}`)
      return { ok: true }
    },
    press: async (_tabId, key) => {
      calls.push(`press:${key}`)
      return { ok: true }
    },
    scroll: async () => ({ ok: true }),
    evaluate: async () => ({ ok: true, value: 42, truncated: false }),
    waitFor: async () => ({ ok: false, code: 'timeout', message: 'Waited 5000ms' }),
    console: async () => ({ ok: true, entries: [] }),
    network: async () => ({ ok: true, entries: [] }),
    actionsOf: (tabId) =>
      tabId === 't1'
        ? [
            { id: 'a1', action: 'click', args: 'ref e1', status: 'succeeded', startedAt: '2026-09-04T09:00:00.000Z', completedAt: '2026-09-04T09:00:00.100Z' },
            { id: 'a2', action: 'human', args: '', status: 'succeeded', startedAt: '2026-09-04T09:00:01.000Z', completedAt: '2026-09-04T09:00:02.000Z' },
            { id: 'a3', action: 'type', args: '5 chars', status: 'interrupted', startedAt: '2026-09-04T09:00:01.500Z', completedAt: '2026-09-04T09:00:01.600Z', error: 'The person took over the browser; the action was abandoned.' },
          ]
        : [],
    ...controlOverrides,
  }
  const registrations = createBrowserTools({
    manager,
    control,
    hasWorkspace: (workspaceId) => workspaceId === 'ws-1' || workspaceId === 'ws-2',
    sleep: async () => {},
  })
  return { tools: new Map(registrations.map((tool) => [tool.name, tool])), tabs, active, assignments, calls, viewports, openRequests, manager }
}

const bound: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1' } }
/** Two agents in the SAME workspace — the case that used to share one tab. */
const agentA: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-a' } }
const agentB: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-b' } }
const unbound: McpConnectionContext = { metadata: { kind: 'external-local' } }

function structured(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent ?? {}
}

async function main(): Promise<void> {
  await run('every browser tool is classified: mutations in the set, the rest read-only', () => {
    const h = harness()
    const readOnly = new Set(['browser.status', 'browser.snapshot', 'browser.screenshot', 'browser.wait_for', 'browser.console', 'browser.network', 'browser.actions'])
    for (const name of h.tools.keys()) {
      const mutation = BROWSER_MUTATION_TOOL_NAMES.includes(name)
      assert.equal(mutation || readOnly.has(name), true, `${name} is neither a mutation nor listed read-only`)
      assert.equal(isStudioGatewayMutation(name), mutation, `${name} gateway classification`)
    }
    for (const name of BROWSER_MUTATION_TOOL_NAMES) assert.ok(h.tools.has(name), `${name} registered`)
  })

  await run('targeting: bound connections use their workspace; unbound need workspaceId; a mismatch is refused', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    const status = h.tools.get('browser.status')!
    assert.deepEqual(structured(await status.handler({}, bound)).activeTabId, 't1')
    const noWorkspace = await status.handler({}, unbound)
    assert.equal(noWorkspace.isError, true)
    assert.equal((structured(noWorkspace).error as { code: string }).code, 'no_workspace')
    const explicit = await status.handler({ workspaceId: 'ws-1' }, unbound)
    assert.equal(explicit.isError, undefined)
    const mismatch = await status.handler({ workspaceId: 'ws-2' }, bound)
    assert.equal((structured(mismatch).error as { code: string }).code, 'forbidden')
    const unknown = await status.handler({ workspaceId: 'ws-9' }, unbound)
    assert.equal((structured(unknown).error as { code: string }).code, 'unknown_workspace')
  })

  await run('a named tab must belong to the workspace; none open says how to start one', async () => {
    const h = harness()
    h.tabs.set('other', { workspaceId: 'ws-2', state: tabState('other', 'http://localhost:3000/') })
    const click = h.tools.get('browser.click')!
    const foreign = await click.handler({ tabId: 'other', ref: 'e1' }, bound)
    assert.equal((structured(foreign).error as { code: string }).code, 'no_tab')
    const none = await click.handler({ ref: 'e1' }, bound)
    assert.match((structured(none).error as { message: string }).message, /browser\.open/)
    assert.deepEqual(h.calls, [])
  })

  await run('browser.open navigates the active tab and reports it settled', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'about:blank') })
    const open = h.tools.get('browser.open')!
    const result = await open.handler({ url: 'localhost:5173' }, bound)
    assert.equal(result.isError, undefined)
    assert.deepEqual(h.calls, ['navigate:t1:http://localhost:5173/', 'badge:t1'])
    assert.equal((structured(result).tab as { url: string }).url, 'http://localhost:5173/')
    // No new tab, but the pane is asked to show the one that navigated.
    assert.deepEqual(h.openRequests, [{ workspaceId: 'ws-1', url: null, tabId: 't1' }])
  })

  await run('browser.open with no tab asks the renderer and waits for the tab to register', async () => {
    const h = harness()
    const open = h.tools.get('browser.open')!
    // The renderer answers the broadcast by attaching a guest, which registers.
    const original = h.manager.requestOpen
    h.manager.requestOpen = (workspaceId, url) => {
      original(workspaceId, url)
      h.tabs.set('t-new', { workspaceId, state: tabState('t-new', url ?? 'about:blank') })
    }
    const result = await open.handler({ url: 'http://localhost:5173/' }, bound)
    assert.equal(result.isError, undefined)
    assert.deepEqual(h.openRequests, [{ workspaceId: 'ws-1', url: 'http://localhost:5173/', tabId: null }])
    assert.equal((structured(result).tab as { tabId: string }).tabId, 't-new')
  })

  await run('browser.open reports when no window opened a tab, and refuses non-http URLs', async () => {
    const h = harness()
    const open = h.tools.get('browser.open')!
    const nobody = await open.handler({ url: 'http://localhost:5173/' }, bound)
    assert.equal((structured(nobody).error as { code: string }).code, 'pane_unavailable')
    const bad = await open.handler({ url: 'file:///etc/passwd' }, bound)
    assert.equal((structured(bad).error as { code: string }).code, 'invalid_url')
    assert.equal(h.openRequests.length, 1)
  })

  await run('a load error after navigation is the tool result, not a silent success', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'about:blank') })
    h.manager.navigate = (tabId, url) => {
      const tab = h.tabs.get(tabId)!
      tab.state = { ...tab.state, url, loading: false, error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url } }
      return true
    }
    const result = await h.tools.get('browser.navigate')!.handler({ url: 'http://localhost:9/' }, bound)
    assert.equal(result.isError, true)
    assert.match((structured(result).error as { message: string }).message, /ERR_CONNECTION_REFUSED/)
  })

  await run('browser.navigate actions map to the manager and say when there is nothing to go back to', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    const navigate = h.tools.get('browser.navigate')!
    const back = await navigate.handler({ action: 'back' }, bound)
    assert.equal((structured(back).error as { code: string }).code, 'unavailable')
    await navigate.handler({ action: 'hard_reload' }, bound)
    assert.ok(h.calls.includes('reload:t1:hard'))
    const neither = await navigate.handler({}, bound)
    assert.equal((structured(neither).error as { code: string }).code, 'invalid')
  })

  await run('snapshot with includeScreenshot attaches an image block after the text block', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    const result = await h.tools.get('browser.snapshot')!.handler({ includeScreenshot: true }, bound)
    assert.equal(result.content.length, 2)
    assert.equal(result.content[0].type, 'text')
    assert.deepEqual(result.content[1], { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' })
    assert.equal(structured(result).snapshot, '- button "Save" [ref=e1]')
    const plain = await h.tools.get('browser.snapshot')!.handler({}, bound)
    assert.equal(plain.content.length, 1)
  })

  await run('click, type and press pass through with their options; a control error becomes a tool error', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    await h.tools.get('browser.click')!.handler({ ref: 'e1' }, bound)
    await h.tools.get('browser.type')!.handler({ ref: 'e2', text: 'hello', clear: true, submit: true }, bound)
    await h.tools.get('browser.type')!.handler({ text: 'more' }, bound)
    await h.tools.get('browser.press')!.handler({ key: 'Escape' }, bound)
    assert.deepEqual(h.calls, ['click:e1', 'type:e2:hello:clearsubmit', 'type:-:more:', 'press:Escape'])
    const missing = await h.tools.get('browser.click')!.handler({}, bound)
    assert.equal((structured(missing).error as { code: string }).code, 'invalid')
    const waited = await h.tools.get('browser.wait_for')!.handler({ text: 'Saved' }, bound)
    assert.equal(waited.isError, true)
    assert.equal((structured(waited).error as { code: string }).code, 'timeout')
  })

  await run('resize resolves presets by label, freeform by size, and responsive to fill', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    const resize = h.tools.get('browser.resize')!
    await resize.handler({ preset: 'iphone 12 pro' }, bound)
    await resize.handler({ width: 500, height: 900 }, bound)
    await resize.handler({ preset: 'responsive' }, bound)
    assert.deepEqual(
      h.viewports.map((entry) => entry.viewport),
      [
        { mode: 'preset', presetId: 'iphone-12-pro', width: 390, height: 844 },
        { mode: 'freeform', width: 500, height: 900 },
        { mode: 'fill' },
      ],
    )
    const unknown = await resize.handler({ preset: 'Nokia 3310' }, bound)
    assert.equal((structured(unknown).error as { code: string }).code, 'invalid')
  })

  await run('console and network results are trimmed from the oldest to fit one socket line', async () => {
    const { boundedEntries } = await import('./browser-tools')
    const entries = Array.from({ length: 200 }, (_, i) => ({ level: 'log', text: `${i}:${'x'.repeat(2000)}`, location: null, at: i }))
    const bounded = boundedEntries(entries)
    assert.ok(bounded.dropped > 0, 'something was dropped')
    assert.ok(Buffer.byteLength(JSON.stringify(bounded.entries)) <= 200_000)
    assert.equal(bounded.entries[bounded.entries.length - 1]?.at, 199, 'the newest survive')
    assert.deepEqual(boundedEntries([{ a: 1 }]), { entries: [{ a: 1 }], dropped: 0 })
  })

  await run('a page that never finishes loading is a timeout, and active means what the person sees', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'about:blank') })
    h.tabs.set('t2', { workspaceId: 'ws-1', state: tabState('t2', 'about:blank') })
    h.active.set('ws-1', 't2')
    h.manager.navigate = (tabId, url) => {
      const tab = h.tabs.get(tabId)!
      tab.state = { ...tab.state, url, loading: true }
      return true
    }
    // `now` jumps past the load deadline on the second look.
    let clock = 0
    const stuck = createBrowserTools({
      manager: h.manager,
      control: {} as never,
      hasWorkspace: () => true,
      now: () => (clock += 20_000),
      sleep: async () => {},
    }).find((tool) => tool.name === 'browser.navigate')!
    const result = await stuck.handler({ tabId: 't1', url: 'http://localhost:5173/' }, bound)
    assert.equal((structured(result).error as { code: string }).code, 'timeout')
    h.manager.navigate = (tabId, url) => {
      const tab = h.tabs.get(tabId)!
      tab.state = { ...tab.state, url, loading: false }
      return true
    }
    const done = await h.tools.get('browser.navigate')!.handler({ tabId: 't1', url: 'http://localhost:5173/' }, bound)
    assert.equal((structured(done).tab as { active: boolean }).active, false, 't1 is not the tab the person is looking at')
  })

  await run('history rides status, snapshot and browser.actions', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/', { controller: 'human' }) })
    const status = structured(await h.tools.get('browser.status')!.handler({}, bound))
    const tab = (status.tabs as Array<Record<string, unknown>>)[0]
    assert.equal(tab.controller, 'human')
    assert.equal((tab.lastAction as { status: string }).status, 'interrupted')
    const snap = structured(await h.tools.get('browser.snapshot')!.handler({}, bound))
    assert.deepEqual((snap.actions as Array<{ action: string }>).map((entry) => entry.action), ['click', 'human', 'type'])
    const all = structured(await h.tools.get('browser.actions')!.handler({}, bound))
    assert.equal((all.actions as unknown[]).length, 3)
  })

  await run('set_appearance validates the scheme and lights the badge', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    await h.tools.get('browser.set_appearance')!.handler({ scheme: 'dark' }, bound)
    assert.deepEqual(h.calls, ['scheme:t1:dark', 'badge:t1'])
    const bad = await h.tools.get('browser.set_appearance')!.handler({ scheme: 'sepia' }, bound)
    assert.equal((structured(bad).error as { code: string }).code, 'invalid')
  })

  // Per-agent tabs. Before this, the tab a tool acted on was the tab the PERSON
  // was looking at, so every agent in a workspace drove the same page.

  await run('an agent claims the tab it first acts on and stays there', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    h.active.set('ws-1', 't1')
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentA)
    assert.equal(h.assignments.get('ws-1\u0000agent-a'), 't1')
    // The person moves to another tab; the agent does not follow it.
    h.tabs.set('t2', { workspaceId: 'ws-1', state: tabState('t2', 'http://localhost:3000/') })
    h.active.set('ws-1', 't2')
    h.calls.length = 0
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentA)
    assert.deepEqual(h.calls, ['reload:t1:soft', 'badge:t1'])
  })

  await run('two agents in one workspace do not drive the same tab', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    h.active.set('ws-1', 't1')
    // A takes the existing tab; B asks for a new one and gets its own.
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentA)
    h.tabs.set('t2', { workspaceId: 'ws-1', state: tabState('t2', 'http://localhost:3000/') })
    await h.tools.get('browser.navigate')!.handler({ action: 'reload', tabId: 't2' }, agentB)
    assert.equal(h.assignments.get('ws-1\u0000agent-a'), 't1')
    assert.equal(h.assignments.get('ws-1\u0000agent-b'), 't2')
    // Now neither steals from the other.
    h.calls.length = 0
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentA)
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentB)
    assert.deepEqual(h.calls, ['reload:t1:soft', 'badge:t1', 'reload:t2:soft', 'badge:t2'])
  })

  await run('browser.open reuses the agent’s own tab, not the person’s', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    h.tabs.set('t2', { workspaceId: 'ws-1', state: tabState('t2', 'http://localhost:3000/') })
    h.assignments.set('ws-1\u0000agent-a', 't1')
    // The person is reading t2; the agent's open must not navigate it.
    h.active.set('ws-1', 't2')
    await h.tools.get('browser.open')!.handler({ url: 'http://localhost:5173/next' }, agentA)
    assert.ok(h.calls.includes('navigate:t1:http://localhost:5173/next'), 'the agent navigated its own tab')
    assert.ok(!h.calls.some((call) => call.startsWith('navigate:t2')), 'the person’s tab was left alone')
  })

  await run('an agent whose tab closed resolves afresh instead of failing', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    h.assignments.set('ws-1\u0000agent-a', 'gone')
    h.active.set('ws-1', 't1')
    const result = await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, agentA)
    assert.equal(structured(result).error, undefined)
    assert.equal(h.assignments.get('ws-1\u0000agent-a'), 't1')
  })

  await run('a connection with no agent keeps the person’s active tab, claiming nothing', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    h.active.set('ws-1', 't1')
    await h.tools.get('browser.navigate')!.handler({ action: 'reload' }, bound)
    assert.equal(h.assignments.size, 0, 'an agent-less connection claims no tab')
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
