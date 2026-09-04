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
    agentActive: false,
    ...overrides,
  }
}

type Harness = {
  tools: Map<string, McpToolRegistration>
  tabs: Map<string, { workspaceId: string; state: BrowserTabState }>
  active: Map<string, string>
  calls: string[]
  viewports: Array<{ tabId: string; viewport: BrowserViewport }>
  openRequests: Array<{ workspaceId: string; url: string | null }>
  manager: BrowserToolsManager
}

function harness(controlOverrides: Partial<BrowserToolsDeps['control']> = {}): Harness {
  const tabs = new Map<string, { workspaceId: string; state: BrowserTabState }>()
  const active = new Map<string, string>()
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
    requestOpen: (workspaceId, url) => {
      openRequests.push({ workspaceId, url })
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
    type: async (_tabId, target, text, options) => {
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
    ...controlOverrides,
  }
  const registrations = createBrowserTools({
    manager,
    control,
    hasWorkspace: (workspaceId) => workspaceId === 'ws-1' || workspaceId === 'ws-2',
    sleep: async () => {},
  })
  return { tools: new Map(registrations.map((tool) => [tool.name, tool])), tabs, active, calls, viewports, openRequests, manager }
}

const bound: McpConnectionContext = { metadata: { kind: 'studio-agent', workspaceId: 'ws-1' } }
const unbound: McpConnectionContext = { metadata: { kind: 'external-local' } }

function structured(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  return result.structuredContent ?? {}
}

async function main(): Promise<void> {
  await run('every browser tool is classified: mutations in the set, the rest read-only', () => {
    const h = harness()
    const readOnly = new Set(['browser.status', 'browser.snapshot', 'browser.screenshot', 'browser.wait_for', 'browser.console', 'browser.network'])
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
    assert.deepEqual(h.openRequests, [])
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
    assert.deepEqual(h.openRequests, [{ workspaceId: 'ws-1', url: 'http://localhost:5173/' }])
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

  await run('set_appearance validates the scheme and lights the badge', async () => {
    const h = harness()
    h.tabs.set('t1', { workspaceId: 'ws-1', state: tabState('t1', 'http://localhost:5173/') })
    await h.tools.get('browser.set_appearance')!.handler({ scheme: 'dark' }, bound)
    assert.deepEqual(h.calls, ['scheme:t1:dark', 'badge:t1'])
    const bad = await h.tools.get('browser.set_appearance')!.handler({ scheme: 'sepia' }, bound)
    assert.equal((structured(bad).error as { code: string }).code, 'invalid')
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
