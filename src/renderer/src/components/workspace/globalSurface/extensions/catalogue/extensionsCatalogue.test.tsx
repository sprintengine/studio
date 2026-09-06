// The three catalogues, rendered: Plugins, Skills and Agent CLIs are the SAME
// page (source-tabs ruling, 2026-09-05), so what this asserts is the sameness —
// each view's title on the chrome row, Installed first in the tab row, one tab
// per source after it, the plus with its two items, and one pager at the foot.
//
// Against a real DOM rather than static markup: these read the workspace store
// and open a menu, and both are behaviour a markup snapshot cannot see.

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.CustomEvent = dom.window.CustomEvent
anyGlobal.Event = dom.window.Event
anyGlobal.InputEvent = dom.window.InputEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { ScanResult, SkillSource } from '../../../../../../../shared/skills'

// ── The main process this surface reads through ─────────────────────────────
// Only what the three catalogues actually call. Anything unstubbed answers
// `{ ok: false }`, which is the shape every read here degrades through, so a
// missing stub shows up as an honest error state rather than a crash.

const APP_SOURCE: SkillSource = {
  id: 'builtin',
  kind: 'builtin',
  name: 'Multicode',
  repo: '',
  monogram: 'MC',
  blurb: 'The skills Multicode ships.',
  commitSha: '',
  scannedAt: '',
}
const ACME_SOURCE: SkillSource = {
  id: 'github:acme/skills',
  kind: 'github',
  name: 'skills',
  repo: 'acme/skills',
  monogram: 'AS',
  blurb: 'Skills from acme.',
  commitSha: 'abc1234',
  scannedAt: '2026-09-01T10:00:00.000Z',
}

/** 30 skills in three folders, so the source needs three pages of twelve. */
const ACME_SCAN: ScanResult = {
  skills: Array.from({ length: 30 }, (_, index) => ({
    id: `skills/${['engineering', 'writing', 'ops'][index % 3]}/skill-${index}`,
    name: `skill-${index}`,
    description: `does thing ${index}`,
    group: ['engineering', 'writing', 'ops'][index % 3],
    files: [{ path: 'SKILL.md', size: 100, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
  })),
  groups: ['engineering', 'writing', 'ops'],
  groupingSignal: 'folders',
  fileCount: 30,
  commitSha: 'abc1234',
}

const api: Record<string, unknown> = {
  platform: 'darwin',
  mcpListCatalog: async () => ({
    ok: true,
    servers: [
      {
        id: 'railway',
        name: 'Railway',
        category: 'Deployments',
        description: 'Deploys, services, logs',
        transport: 'http',
        clients: [],
        required: false,
        riskLevel: 'low',
        skill: 'use-railway',
      },
      {
        id: 'stripe',
        name: 'Stripe MCP',
        category: 'Payments',
        description: 'Payments and billing',
        transport: 'http',
        clients: [],
        required: false,
        riskLevel: 'low',
      },
    ],
  }),
  readMarketplaceRegistry: async () => ({
    ok: true,
    registryUrl: null,
    marketplace: {
      plugins: [
        {
          id: 'stripe-plugin',
          name: 'Stripe',
          publisher: { name: 'Stripe', verified: true },
          summary: 'Payments, billing, customers',
          category: 'Payments',
          icon: 'stripe.svg',
          latest: 1,
          provides: ['mcp', 'skills'],
        },
        {
          id: 'cursor-cli',
          name: 'Cursor',
          publisher: { name: 'Cursor', verified: true },
          summary: 'Drive the Cursor agent.',
          category: 'Development',
          icon: 'cursor.svg',
          latest: 1,
          provides: ['cli'],
          cli: { pluginId: 'cursor' },
        },
      ],
    },
  }),
  skillsListSources: async () => ({ ok: true, sources: [APP_SOURCE, ACME_SOURCE] }),
  skillsGetScan: async ({ sourceId }: { sourceId: string }) =>
    sourceId === 'builtin'
      ? {
          ok: true,
          source: APP_SOURCE,
          scan: { skills: [], groups: [], groupingSignal: 'none', fileCount: 0, commitSha: '' },
        }
      : { ok: true, source: ACME_SOURCE, scan: ACME_SCAN },
  workspaceSkillsList: async () => ({ ok: true, skills: [] }),
  skillsListInstalledPlugins: async () => ({ ok: true, plugins: [] }),
  listThirdPartyModules: async () => ({ modules: [], rejected: [] }),
  pluginsList: async () => ({ ok: true, plugins: [] }),
  // A check that could not run: never silence that reads as "up to date".
  readMarketplacePluginUpdateStates: async () => ({ ok: false, message: 'not checked here' }),
  // A subscription, not a read: the proxy's async default would hand React a
  // Promise where an unsubscribe belongs.
  onSkillSourcesUpdated: () => () => {},
  openDir: async () => null,
  openExternal: async () => undefined,
}
domWindow.api = new Proxy(api, {
  get: (target, property: string) =>
    property in target ? target[property] : async () => ({ ok: false, message: 'not stubbed' }),
})

const container = dom.window.document.createElement('div')
dom.window.document.body.appendChild(container)
const root = createRoot(container as unknown as Element)

const settle = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

const text = (): string => container.textContent ?? ''
const tabs = (): HTMLElement[] => [...container.querySelectorAll('[role="tab"]')] as HTMLElement[]
const tabNames = (): string[] => tabs().map((tab) => (tab.textContent ?? '').replace(/\d+$/, '').trim())
const tabNamed = (name: string): HTMLElement | undefined =>
  tabs().find((tab) => (tab.textContent ?? '').startsWith(name))
const title = (): string => container.querySelector('h2')?.textContent ?? ''

async function run(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

async function main(): Promise<void> {
  const { useWorkspaceStore } = await import('../../../../../store/workspaceStore')
  const { default: ExtensionsGlobalSurface } = await import('../ExtensionsGlobalSurface')
  const { dispatchExtensionsSurfaceTarget, consumePendingExtensionsSurfaceTarget } = await import(
    '../extensionsSurfaceTarget'
  )

  const openView = async (view: 'plugins' | 'skills' | 'agent-clis'): Promise<void> => {
    consumePendingExtensionsSurfaceTarget()
    await act(async () => {
      dispatchExtensionsSurfaceTarget({ view })
    })
    await settle()
  }

  await act(async () => {
    root.render(React.createElement(ExtensionsGlobalSurface))
  })
  await settle()

  // ── The three views are one page ────────────────────────────────────────────

  await run('Plugins names itself on the chrome row and searches the open tab there', () => {
    assert.equal(title(), 'Plugins')
    const search = container.querySelector('input[type="search"]')
    assert.ok(search, 'the search field is in the bar, beside the name')
    assert.equal(
      search?.getAttribute('aria-label'),
      'Search plugins in the open tab',
      'and it says which list it filters',
    )
  })

  await run('Installed leads the tab row, then one tab per source, the app’s catalogue first', () => {
    assert.deepEqual(tabNames(), ['Installed', 'SprintEngine Studio', 'acme/skills'])
    assert.equal(
      container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('SprintEngine Studio'),
      true,
      'a cold open lands on a source, not on what is already installed',
    )
  })

  await run('the plus sits after the last tab and offers exactly two ways in', async () => {
    const plus = container.querySelector('button[aria-label="Add source"]') as HTMLElement | null
    assert.ok(plus, 'the plus is named for what it does')
    assert.equal(plus?.getAttribute('aria-haspopup'), 'menu')
    const strip = plus?.parentElement?.parentElement
    assert.ok(
      strip && strip.querySelector('[role="tablist"]'),
      'and it shares the tab row’s band rather than floating somewhere else',
    )
  })

  await run('the app’s tab keeps the registry’s categories as its groups, walked by one pager', () => {
    assert.ok(text().includes('Stripe'), 'a registry plugin is a row')
    assert.ok(text().includes('Railway'), 'and so is an MCP catalogue server')
    assert.ok(text().includes('Payments'), 'MCP servers keep the catalogue’s own categories as headings')
    assert.ok(/Showing 1–\d+ of \d+/.test(text()), 'one pager states where you are in the whole tab')
    assert.equal(text().includes('Featured'), false, 'the Featured facet is gone')
    assert.equal(/Show \d+ more/.test(text()), false, 'and so is "Show N more"')
  })

  // ── The plus menu ───────────────────────────────────────────────────────────

  await act(async () => {
    ;(container.querySelector('button[aria-label="Add source"]') as HTMLElement).click()
  })
  await settle()

  await run('the plus menu is a folder on this machine or a repository, and nothing else', () => {
    const items = [...dom.window.document.querySelectorAll('[role="menu"] button')].map(
      (item) => item.textContent?.trim() ?? '',
    )
    assert.deepEqual(items, ['Add from file…', 'Add from GitHub…'])
  })

  await run('Escape closes the menu', async () => {
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(dom.window.document.querySelector('[role="menu"]'), null)
  })

  // ── Skills: the repository's folders are the groups ──────────────────────────

  await openView('skills')

  await run('Skills is the same page, and its tab row is the same tab row', () => {
    assert.equal(title(), 'Skills')
    assert.deepEqual(tabNames(), ['Installed', 'SprintEngine Studio', 'acme/skills'])
    assert.ok(container.querySelector('button[aria-label="Add source"]'), 'the plus is here too')
  })

  await act(async () => {
    tabNamed('acme/skills')?.click()
  })
  await settle()

  await run('a repository lists under the folders it keeps its skills in, one page at a time', () => {
    assert.ok(text().includes('Engineering'), 'the folder names are the headings, cased for reading')
    assert.ok(text().includes('Showing 1–12 of 30'), 'and the pager walks the whole source, not one folder')
    assert.equal(text().includes('type="checkbox"'), false)
  })

  await run('the head line carries the source’s own state and its actions', () => {
    assert.ok(text().includes('30 skills'))
    assert.ok(container.querySelector('button[aria-label^="More actions for"]'), 'Remove and Open are one overflow')
  })

  await run('page 2 continues the source rather than restarting it', async () => {
    await act(async () => {
      ;(container.querySelector('button[aria-label="Page 2"]') as HTMLElement).click()
    })
    await settle()
    assert.ok(text().includes('Showing 13–24 of 30'))
    assert.equal(
      container.querySelector('button[aria-label="Page 2"]')?.getAttribute('aria-current'),
      'page',
      'and the page you are on says so the way a page does',
    )
  })

  await run('the search field is bound to the tab it filters', () => {
    // What the search DOES to a tab — the filter itself, and landing back on
    // page 1 — is the model's, and is asserted there (cataloguePaging.test.ts,
    // skillsSurfaceModel.test.ts). What the DOM owes is the binding: a filter
    // and its results are two separate stops for a screen reader, and without
    // the link the field is a text box that happens to sit above something.
    const search = container.querySelector('input[type="search"]')
    const panel = container.querySelector('[role="tabpanel"]')
    assert.ok(panel?.id)
    assert.equal(search?.getAttribute('aria-controls'), panel?.id)
  })

  // ── Agent CLIs: the same shape, minus the plus ──────────────────────────────

  await openView('agent-clis')

  await run('Agent CLIs is the same page with one source and no plus', () => {
    assert.equal(title(), 'Agent CLIs')
    assert.deepEqual(
      tabNames(),
      ['Installed', 'SprintEngine Studio'],
      'a repository can hold no CLI, so listing every source would be tabs that can only read "none"',
    )
    assert.equal(
      container.querySelector('button[aria-label="Add source"]'),
      null,
      'and the plus is withheld rather than offering a way in that leads nowhere',
    )
  })

  // ── The Installed tab ───────────────────────────────────────────────────────

  await act(async () => {
    tabNamed('Installed')?.click()
  })
  await settle()

  await run('Installed with no workspace says so rather than reading as nothing installed', () => {
    assert.equal(useWorkspaceStore.getState().activeWorkspaceId, null, 'the door is open with no workspace')
    assert.ok(
      text().includes('Open a workspace') || text().includes('Nothing installed yet'),
      `the Installed tab states its condition (saw: ${text().slice(0, 200)})`,
    )
  })

  await act(async () => {
    root.unmount()
  })

  console.log('extensions catalogue: ok')

}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
