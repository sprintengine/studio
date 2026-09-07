import assert from 'node:assert/strict'

// The Extensions home's tile contract (Extensions drawer ruling, 2026-09-05,
// Stage 3): five tiles, in the drawer's order, opening exactly what the drawer
// rows open, and absent for a module that is switched off.
//
// Mounted against the REAL module registry, like the drawer's own test, because
// the contract is the WIRING. The ruling's words are "tiles ... that open the
// same surfaces the drawer rows do", and the only way to prove "the same" is to
// click both and compare the state each leaves behind — a tile asserted against
// a hand-written expectation would keep passing on the day a view's deep-link
// latch changed under it and only the drawer was updated.
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
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class FakeResizeObserver { observe() {} unobserve() {} disconnect() {} }
anyGlobal.ResizeObserver = FakeResizeObserver
domWindow.ResizeObserver = FakeResizeObserver
// React's change-event POLYFILL, given the two IE methods it reaches for.
//
// THIS IS A PROPERTY OF THIS TEST ENVIRONMENT, not of anything the page does.
// ES imports are hoisted, so the CJS bundle evaluates react-dom before the
// statements above have put jsdom's globals on `globalThis`: React decides at
// load that there is no DOM at all and never detects the browser `input` event,
// and the polyfill it falls back to instead watches ONE focused field at a time
// and attaches to it through `attachEvent`/`detachEvent`, which jsdom does not
// have. Without these two no-ops every real focus threw inside React's own
// dispatch — noise in the log, and worse than noise: the throw came BEFORE the
// polyfill could let go of the field it was watching, so once the model
// picker's search box had taken focus the page's own search box could never be
// tracked again and typing into it silently did nothing. The other way out is a
// module of its own imported ahead of react-dom, which is a change to how every
// renderer test in this repo is bootstrapped and not this file's to make.
const asAny = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>
asAny.attachEvent = () => {}
asAny.detachEvent = () => {}
dom.window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as unknown as typeof dom.window.matchMedia
// The page's five readers, stubbed at the preload boundary. The two that are
// absent here (`skillsListSources`, `listDesignSystemLibrary`) are absent on
// purpose: every reader is guarded, and a missing one must leave its tile
// standing with no count line rather than taking the tile down with it.
domWindow.api = {
  listSprintRuns: async () => [],
  onSprintRunsChanged: () => () => {},
}

import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import type { HostedCard } from '../../../../shared/hosted-card-feed'
import ExtensionsHomeSurface from './ExtensionsHomeSurface'
import { EXTENSIONS_HOME_TILE_SUMMARIES } from './extensionsHomeTiles'
import { ExtensionsRail } from '../workspace/ExtensionsRail'
import { getRendererHost } from '../../modules'
import type { RegisteredSidebarNavEntry } from '../../modules/renderer-host'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { consumePendingExtensionsSurfaceTarget } from '../workspace/globalSurface/extensions/extensionsSurfaceTarget'
import { setExtensionsSurfaceHost } from '../workspace/globalSurface/extensions/extensionsSurfaceHost'
import type { CardLaunchChoice } from '../workspace/globalSurface/extensions/home/CardGoPicker'
import {
  __resetModelPermissionPresetsForTest,
  setModelPermissionPreset,
} from '../ui/modelPermissionPresets'

/** A model id this machine "has", added the way Settings adds one. */
const MODEL = 'claude-opus-5'

const RULED_ORDER = ['Workflows', 'Sprints', 'Design', 'Plugins', 'Skills', 'Agent CLIs']

function mount(element: React.ReactElement): { host: HTMLElement; unmount: () => void } {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host as unknown as Element)
  act(() => {
    root.render(element)
  })
  return {
    host,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

const tilesIn = (host: HTMLElement) => [...host.querySelectorAll('ul button')] as HTMLElement[]
// The name is the tile's first span that is not decorative — the glyph and the
// chevron wrappers are `aria-hidden`, which is both correct markup and what
// makes the name findable without depending on child order.
const nameOf = (tile: HTMLElement) =>
  tile.querySelector(':scope > span:not([aria-hidden])')?.textContent?.trim() ?? ''

// ── Five tiles, in the drawer's order ────────────────────────────────────────
const home = mount(React.createElement(ExtensionsHomeSurface))
assert.deepEqual(
  tilesIn(home.host).map(nameOf),
  RULED_ORDER,
  'the home is the ruling’s five parts in the ruling’s order — the same list the drawer holds, resolved by the same function',
)

// Each tile is a real button carrying its own name as text, so it is in the tab
// order, has an accessible name without an aria-label, and is operable from the
// keyboard by being a button at all.
for (const tile of tilesIn(home.host)) {
  assert.equal(tile.tagName, 'BUTTON', 'a tile is a button, not a div with a click handler')
  assert.equal(tile.getAttribute('type'), 'button')
  const name = nameOf(tile)
  assert.ok(name.length > 0, 'a tile names itself in text')
  // The glyph and the chevron say nothing a reader needs — the name is already
  // there — so neither may be announced.
  for (const svg of [...tile.querySelectorAll('svg')]) {
    assert.equal(svg.getAttribute('aria-hidden'), 'true', `${name}: a decorative glyph is hidden from readers`)
  }
}

// Each tile carries the summary its id was given, on the tile it belongs to —
// a copy table keyed by the wrong id would swap two sentences silently.
const summaryFor: Record<string, string> = {
  Workflows: EXTENSIONS_HOME_TILE_SUMMARIES.workflows,
  Sprints: EXTENSIONS_HOME_TILE_SUMMARIES.sprints,
  Design: EXTENSIONS_HOME_TILE_SUMMARIES.design,
  Plugins: EXTENSIONS_HOME_TILE_SUMMARIES.plugins,
  Skills: EXTENSIONS_HOME_TILE_SUMMARIES.skills,
  'Agent CLIs': EXTENSIONS_HOME_TILE_SUMMARIES['agent-clis'],
}
for (const tile of tilesIn(home.host)) {
  const name = nameOf(tile)
  assert.ok(
    tile.textContent?.includes(summaryFor[name]),
    `${name}: the tile carries its own one-line summary`,
  )
}

// ── A feed with nothing in it is the page it was yesterday ───────────────────
// The store starts with no cards, which is a fresh profile with no network and
// also an old build meeting a feed of cards whose artwork ships later. Both
// fall back to the tiles ALONE, and the page says nothing about either: no
// apology, no notice, no version line (epic rulings R5 and R6).
assert.equal(
  home.host.querySelectorAll('article').length,
  0,
  'no cards, so no card region',
)
assert.equal(
  home.host.querySelectorAll('input[type="search"]').length,
  0,
  'and no filter over cards the page is not showing',
)
assert.ok(
  !home.host.textContent?.includes('Or go straight to the parts'),
  'the heading arrives with the cards and leaves with them — with nothing above them the tiles ARE the page again',
)
for (const apology of ['offline', 'Offline', 'could not', 'Could not', 'unavailable', 'Unavailable', 'Retry', 'try again']) {
  assert.ok(
    !home.host.textContent?.includes(apology),
    `the page never reports on its own network (R6), and it does not say “${apology}”`,
  )
}
// The Community "coming soon" block STAYS. Item 2468 deleted it on the reading
// that the card feed was the promise kept; the copy says otherwise — a browse of
// what OTHER PEOPLE have published, with search and one-click install, once the
// registry scan lands — and none of that has shipped. It is an owner ruling of
// 2026-09-05 and retiring it is an owner call this epic did not make, so the
// assertion on its copy is here word for word, exactly as it was before.
assert.ok(
  home.host.textContent?.includes('Community') && home.host.textContent.includes('Coming soon'),
  'the Community section keeps its heading and its tag',
)
assert.ok(
  home.host.textContent?.includes(
    'A browse of modules other people have published, with search and one-click install, will be listed here once the registry scan lands.',
  ),
  'and the ruling’s copy, word for word',
)
const communitySection = home.host.querySelector(
  'section[aria-labelledby="extensions-community-heading"]',
)
assert.ok(communitySection, 'it is a named region, not a run of divs')
assert.equal(
  communitySection?.querySelector('#extensions-community-heading')?.tagName,
  'H2',
  'and the heading that names it is a heading',
)
assert.equal(
  [...home.host.querySelectorAll('input[type="checkbox"], [role="switch"]')].length,
  0,
  'no module switches here: those live in Settings → Modules, and one choice in two shapes on two surfaces is the thing Stage 2 removed',
)

// ── A tile opens EXACTLY what the drawer row opens ───────────────────────────
// The drawer's Sprints row is the sprint-engine module's OWN lazy component,
// which a Suspense boundary in this bundle has nothing to show for — so the
// drawer draws four of the five rows here and the home draws all five (a tile
// is built from the door's declared label and glyph, with no component to
// load). The four the shell draws are the real ones, resolved from the real
// registry by the function both surfaces call.
const drawer = mount(React.createElement(ExtensionsRail, { collapsed: false }))
const drawerRows = () => [...drawer.host.querySelectorAll('[role="listitem"] button')] as HTMLElement[]
// The two run doors draw their OWN rows (one lazy component, item 2470), so
// the shell has nothing to paint for either — their slots are there, empty.
const MODULE_DRAWN_ROWS = ['Workflows', 'Sprints']
const SHELL_DRAWN = RULED_ORDER.filter((label) => !MODULE_DRAWN_ROWS.includes(label))
assert.deepEqual(
  drawerRows().map((row) => row.textContent?.trim()),
  SHELL_DRAWN,
  'the drawer and the home are the same rows in the same order — they are resolved by one function',
)
assert.equal(
  drawer.host.querySelectorAll('[role="listitem"]').length,
  RULED_ORDER.length,
  'and the Workflows and Sprints slots are there, holding their module’s own rows',
)

/** What clicking left behind: the routed surface, and the view it was latched to. */
function landing(click: () => void): { surface: string | null; view: string | null } {
  act(() => {
    useWorkspaceStore.getState().closeGlobalSurface()
  })
  consumePendingExtensionsSurfaceTarget()
  act(click)
  return {
    surface: useWorkspaceStore.getState().activeGlobalSurface,
    view: consumePendingExtensionsSurfaceTarget(),
  }
}

for (const label of SHELL_DRAWN) {
  const row = drawerRows().find((candidate) => candidate.textContent?.trim() === label)
  const tile = tilesIn(home.host).find((candidate) => nameOf(candidate) === label)
  assert.ok(row && tile, `${label}: both the drawer row and the tile exist`)
  const fromRow = landing(() => row.click())
  const fromTile = landing(() => tile.click())
  assert.deepEqual(
    fromTile,
    fromRow,
    `${label}: the tile lands where the row lands — same surface, same latched view`,
  )
  assert.ok(fromTile.surface, `${label}: and clicking it actually routes the card region somewhere`)
}

// A sprint door already open does not change what the next tile does: the view
// latches before the shell opens, exactly as a drawer row does, so an
// already-open surface and a cold one both land on the tile that was clicked.
act(() => {
  useWorkspaceStore.getState().openGlobalSurface('sprints')
})
consumePendingExtensionsSurfaceTarget()
act(() => {
  tilesIn(home.host).find((tile) => nameOf(tile) === 'Skills')?.click()
})
assert.equal(useWorkspaceStore.getState().activeGlobalSurface, 'extensions')
assert.deepEqual(
  consumePendingExtensionsSurfaceTarget(),
  { view: 'skills' },
  'a tile clicked over an open door latches its view first, like the row does',
)
act(() => {
  useWorkspaceStore.getState().closeGlobalSurface()
})

// ── A disabled module takes its tile with it, as it takes its row ────────────
act(() => {
  useWorkspaceStore.setState((state) => ({
    appSettings: { ...state.appSettings, modules: { ...state.appSettings.modules, design: false } },
  }))
})
assert.deepEqual(
  tilesIn(home.host).map(nameOf),
  ['Workflows', 'Sprints', 'Plugins', 'Skills', 'Agent CLIs'],
  'a tile for a module that is off is absent rather than dead, and the rest keep their order',
)
assert.deepEqual(
  drawerRows().map((row) => row.textContent?.trim()),
  tilesIn(home.host).map(nameOf).filter((label) => !MODULE_DRAWN_ROWS.includes(label)),
  'and the drawer says the same thing at the same moment',
)

// ── The cards are the body of the page, and the tiles are the foot ───────────
// Driven through the store, which is where the page reads the feed from: the
// main process owns the fetch and WorkspaceManager owns the subscription, so a
// page that fetched for itself would be a second reader of one file.
const FEED: HostedCard[] = [
  {
    slug: 'workflows',
    kind: 'workflow',
    title: 'Big task? No problem.',
    dek: 'Hand it something too big for one sitting and watch the board.',
    credit: 'Sprint engine',
    art: 'board',
    publishedAt: '2026-09-01T00:00:00.000Z',
    hero: true,
    go: [],
  },
  {
    slug: 'browser',
    kind: 'mcp',
    title: 'Let an agent drive your browser',
    dek: 'Describe the journey in words. It opens your app and clicks through it.',
    credit: 'Playwright',
    art: 'browser',
    publishedAt: '2026-09-05T00:00:00.000Z',
    go: [],
  },
  {
    slug: 'street',
    kind: 'showcase',
    title: 'Build a 3D apocalypse of your own street',
    dek: 'Photorealistic tiles of your actual postcode, streamed into Unreal.',
    credit: 'Unreal Engine',
    art: 'city',
    publishedAt: '2026-09-03T00:00:00.000Z',
    go: [],
  },
  {
    slug: 'from-a-later-release',
    kind: 'skill',
    title: 'A card this build cannot draw',
    dek: 'It names artwork that ships in a release this one has never seen.',
    art: 'artwork-from-a-later-release',
    publishedAt: '2026-09-06T00:00:00.000Z',
    go: [],
  },
]

act(() => {
  useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
})

const cardsIn = (host: HTMLElement) => [...host.querySelectorAll('article')] as HTMLElement[]
const titleOf = (poster: HTMLElement) => poster.querySelector('h3')?.textContent?.trim() ?? ''

assert.deepEqual(
  cardsIn(home.host).map(titleOf),
  [
    'Big task? No problem.',
    'Let an agent drive your browser',
    'Build a 3D apocalypse of your own street',
  ],
  'the hero leads however old it is, then newest first — and the card naming artwork this build does not hold is not there at all (2467’s ruling)',
)
assert.ok(
  !home.host.textContent?.includes('A card this build cannot draw'),
  'a card from a later release is absent, and the page does not mention it (R5, R6)',
)

// Layout C (ruling R3): the title sits ON the picture, inside the plate, not in
// a caption under it. The plate is the element carrying the aspect ratio.
for (const poster of cardsIn(home.host)) {
  const heading = poster.querySelector('h3')
  assert.ok(heading, `${titleOf(poster)}: the card names itself in a heading`)
  assert.ok(
    heading?.closest('[class*="aspect-"]'),
    `${titleOf(poster)}: the title is over the picture, in the scrim — not under it (layout C)`,
  )
}
assert.ok(
  cardsIn(home.host)[0]?.querySelector('[class*="aspect-[2.7/1]"]'),
  'the hero is the wide crop, and nothing else on the page is',
)
assert.equal(
  cardsIn(home.host).filter((poster) => poster.querySelector('[class*="aspect-[16/9]"]')).length,
  2,
  'the two columns are 16:9',
)

// The stamp, the sentences and the credit — Frame 2’s anatomy, in the DOM.
for (const [title, stamp, credit] of [
  ['Big task? No problem.', 'Workflow', 'Sprint engine'],
  ['Let an agent drive your browser', 'MCP server', 'Playwright'],
  ['Build a 3D apocalypse of your own street', 'Showcase', 'Unreal Engine'],
]) {
  const poster = cardsIn(home.host).find((candidate) => titleOf(candidate) === title)
  assert.ok(poster, `${title}: the card is on the page`)
  assert.ok(poster?.textContent?.includes(stamp), `${title}: the stamp says what it is`)
  assert.ok(poster?.textContent?.includes(credit), `${title}: the credit line names the thing`)
}
assert.equal(
  [...home.host.querySelectorAll('article ol, article ul')].length,
  0,
  'a card is an advert, never a list of steps (ruling R2)',
)

// ── One Go per card, and one accent in the whole view ────────────────────────
const goButtons = () =>
  [...home.host.querySelectorAll('button')].filter((button) =>
    button.textContent?.trim() === 'Go',
  ) as HTMLElement[]
assert.equal(goButtons().length, 3, 'one Go per card, and nothing else to press on it')
for (const go of goButtons()) {
  assert.equal(go.getAttribute('type'), 'button')
  const name = go.getAttribute('aria-label') ?? ''
  assert.ok(
    name.startsWith('Go — '),
    'the accessible name leads with the visible label and then says which card it belongs to',
  )
}
// principles, "The accent budget": a solid accent fill is the primary action
// and nothing else, one per view. Seven accented buttons over five tiles whose
// glyphs are deliberately neutral ink is exactly the breach that comment warns
// about, so the hero — the card the FEED promoted, the only one this page ranks
// — takes the fill and every other card takes the outline.
const accented = [...home.host.querySelectorAll('button')].filter((button) =>
  (button.getAttribute('class') ?? '').includes('var(--accent-primary)'),
)
assert.equal(accented.length, 1, 'the accent is spent once in the whole view')
assert.equal(
  accented[0]?.getAttribute('aria-label'),
  'Go — Big task? No problem.',
  'and it is spent on the hero’s Go',
)

// The task-card family contract: hover is a background change, never a lift.
for (const poster of cardsIn(home.host)) {
  const classes = poster.getAttribute('class') ?? ''
  assert.ok(classes.includes('hover:bg-'), `${titleOf(poster)}: hover changes the ground`)
  assert.ok(
    !/shadow|scale-|-translate|translate-y/.test(classes),
    `${titleOf(poster)}: and does nothing else — no lift, no shadow, no scale`,
  )
}

// ── The whole card is reachable, and `Go` is the one way in ──────────────────
// The card is a target for a pointer and a target for a keyboard, and the two
// have to be the same target. The article itself is inert — no tab stop, no
// role, because a card CONTAINS a button and a button inside `role="button"` is
// markup nothing is required to make sense of — so `Go` is the single control
// and a stretched overlay is what makes the rest of the card press it.
for (const poster of cardsIn(home.host)) {
  assert.equal(poster.getAttribute('tabindex'), null, `${titleOf(poster)}: the card is not a second tab stop`)
  assert.equal(poster.getAttribute('role'), null, `${titleOf(poster)}: and it claims no role a button could not sit inside`)
  assert.equal(
    [...poster.querySelectorAll('button, a[href], input, [tabindex]')].length,
    1,
    `${titleOf(poster)}: exactly one thing to reach, and it is the Go`,
  )
  assert.ok(
    (poster.getAttribute('class') ?? '').includes('has-[button:focus-visible]:focus-ring'),
    `${titleOf(poster)}: the ring is drawn on the CARD when its button takes focus — the card is what Enter acts on`,
  )
  // The overlay: the ordinary card owns it as `Go`'s own pseudo-element, the
  // hero as a direct child of the article, because the hero's button sits
  // inside an absolutely positioned row and a pseudo-element resolves against
  // that row rather than against the card.
  const go = [...poster.querySelectorAll('button')][0] as HTMLElement
  const stretched =
    (go.getAttribute('class') ?? '').includes('after:absolute after:inset-0') ||
    [...poster.children].some((child) =>
      (child.getAttribute('class') ?? '').includes('absolute inset-0'),
    )
  assert.ok(stretched, `${titleOf(poster)}: something stretches over the card, so the card is the target`)
}

// The rest of this file runs inside `main()` for one reason: the assertions
// below need to flush a settled promise before they read the DOM again, and a
// cjs bundle has no top-level await to do it on. `WorkspaceSidebar.liveRows
// .test.tsx` is written the same way, and so is this item’s own
// `run-card.test.ts` — the shape is the repo’s, not a special case.
async function main(): Promise<void> {
  // ── `Go` opens the picker, and CHOOSING a row is what runs the card ─────────
  // Owner ruling R4b (2026-09-06, item 2473): pressing Go shows the model
  // picker's popover; nothing installs and nothing runs until a row is chosen.
  // This is the assertion that catches a Go that went back to running on its
  // own — and the one that catches a picker built beside the shipped one, since
  // the rows it reads are `CliModelPopoverSurface`'s own `data-model-row`.
  //
  // The run itself belongs to the shell: this page asks the Extensions host to
  // do it, because a page that installed things would be a second
  // implementation of every installer. So what is asserted here is the half that
  // IS this page's — one press, one popover, one run — plus the states around it.

  /** The card's picker, portaled to <body> rather than into the card. */
  const picker = () =>
    dom.window.document.querySelector('[role="dialog"][aria-label^="Run "]') as HTMLElement | null
  const pickerRows = () =>
    [...(picker()?.querySelectorAll('[data-model-row="true"]') ?? [])] as HTMLElement[]
  const rowNamed = (needle: string) =>
    pickerRows().find((row) => row.textContent?.includes(needle))
  /** The card's glass — the pointer surface a mouse actually lands on. */
  const glassOf = (index: number) =>
    cardsIn(home.host)[index]?.querySelector(':scope > span[aria-hidden="true"]') as HTMLElement | undefined
  /**
   * Press a card the way a person does: on the glass, mouse DOWN and then the
   * click.
   *
   * Both halves matter. The popover dismisses itself on a mousedown outside its
   * surface and its trigger, so a press on the card is a dismissal followed by a
   * click — and a glass that decided what to do at click time would reopen what
   * the person had just closed, forever. Clicking the `Go` element directly (as
   * this suite used to) can never see that: the glass is what a pointer hits.
   */
  const pressCard = (index: number) => {
    const glass = glassOf(index)
    act(() => {
      glass?.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
      glass?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
  }
  /** Shut whatever is open, the way a second press on the card does. */
  const closePicker = () => {
    for (const [index, card] of cardsIn(home.host).entries()) {
      if (card.querySelector('button[aria-expanded="true"]')) pressCard(index)
    }
  }

  // A model the picker can name, so the row a click lands on is one this test
  // can identify — and a preset stored against THAT row, to prove the preset
  // rides the row rather than the app.
  act(() => {
    useWorkspaceStore.setState((state) => ({
      appSettings: {
        ...state.appSettings,
        lastSelectedCli: 'claude-code',
        cliRuntimes: { 'claude-code': { command: 'claude', useWsl: false, models: [MODEL] } },
        lastAgentSpawnPermissionPreset: 'manual' as const,
      },
    }))
  })
  __resetModelPermissionPresetsForTest()
  setModelPermissionPreset('claude-code', MODEL, 'auto')

  // With no host registered (no WorkspaceManager mounted), opening the picker
  // and choosing from it is a no-op that must not throw: the same guard every
  // reader on this page already has.
  act(() => {
    goButtons()[0]?.click()
  })
  assert.ok(picker(), 'Go opens the picker rather than running the card')
  act(() => {
    rowNamed(MODEL)?.click()
  })
  closePicker()

  {
    let settle: (() => void) | null = null
    const ran: Array<{ slug: string; launch: CardLaunchChoice }> = []
    setExtensionsSurfaceHost({
      onLaunchConnector: () => {},
      onUseInAutomation: () => {},
      onUseSkillInNewAgent: () => {},
      onRunCard: (card, launch) => {
        ran.push({ slug: card.slug, launch })
        return new Promise<void>((resolve) => {
          settle = resolve
        })
      },
    })

    // Pressing Go — twice, and on two different cards — starts NOTHING. The one
    // moment the card stops and waits is this popover, and it is not a consent
    // screen: it is the control every other agent in this product is spawned
    // from (the ruling of 2026-08-04, "the model picker is the spawner").
    act(() => {
      goButtons()[0]?.click()
      goButtons()[1]?.click()
    })
    assert.equal(ran.length, 0, 'pressing Go installs nothing and runs nothing on its own (R4b)')
    assert.equal(
      goButtons()[0]?.getAttribute('aria-expanded'),
      'true',
      'the button says it opened something, because it is now a popover trigger',
    )
    closePicker()

    // A MOUSE can open it and a mouse can close it, on the card itself: press
    // once and the picker is there, press again and it is gone. The second
    // press is the one that used to be impossible — the card's glass reopened
    // on every click, so the only way out was a click off the card entirely.
    pressCard(0)
    assert.ok(picker(), 'a press on the card opens the picker')
    pressCard(0)
    assert.equal(picker(), null, 'and a second press on the card closes it again')
    assert.equal(ran.length, 0, 'opening and closing runs nothing')

    // Choosing a row IS the press that runs it, and the row's own axes ride
    // with it: the cli, the model, the effort the CLI declares, and the
    // permission preset remembered against `<cli>:<model>` since 2026-09-05.
    act(() => {
      goButtons()[0]?.click()
    })
    const row = rowNamed(MODEL)
    assert.ok(row, 'the picker lists the model this machine has, on the shipped surface’s own rows')
    act(() => {
      row?.click()
      // A second click on a row that has already started the run must not start
      // a second: the page's ref is what makes that true, not its state.
      row?.click()
    })
    assert.equal(ran.length, 1, 'choosing a row runs the card exactly once')
    assert.deepEqual(
      ran[0]?.launch,
      { cli: 'claude-code', model: MODEL, reasoning: null, permissionPreset: 'auto' },
      'and it runs on THAT row — its cli, its model, and the preset stored against it rather than the app-wide default',
    )
    assert.equal(ran[0]?.slug, 'workflows', 'on the card whose Go was pressed')
    assert.equal(picker(), null, 'the popover closes on the choice; there is nothing to confirm afterwards')

    // Every Go is disabled while a run is in flight, because a button that looks
    // pressable and does nothing is worse than one that says it cannot be
    // pressed — and a disabled trigger opens no popover, which is what keeps the
    // non-re-entrancy guard true for the picker as well as for the run.
    for (const go of goButtons()) {
      assert.equal((go as HTMLButtonElement).disabled, true, 'every Go is disabled while a run is in flight')
    }
    act(() => {
      goButtons()[1]?.click()
      cardsIn(home.host)[1]?.click()
    })
    assert.equal(picker(), null, 'a card cannot open its picker while a run is in flight — nor through its glass')
    assert.equal(ran.length, 1, 'and nothing else started')
    assert.equal(
      goButtons()[0]?.getAttribute('aria-busy'),
      'true',
      'and the card that is actually working says so, without a spinner on a poster',
    )
    // Settled, then flushed, then asserted. This is the only cover the page's
    // `finally` and its `mounted` ref have: without it a run that ended would
    // leave every Go on the page disabled for good, and the page would look
    // exactly like one still working. The flush is the shape the repo already
    // uses for this (`WorkspaceSidebar.liveRows.test.tsx`).
    settle?.()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    for (const go of goButtons()) {
      assert.equal((go as HTMLButtonElement).disabled, false, 'and every Go is pressable again once the run settles')
    }
    assert.equal(goButtons()[0]?.getAttribute('aria-busy'), null, 'and no card is left claiming to be busy')

    // A row nobody has set falls back to the APP-WIDE default in Settings, not
    // to something invented here: the CLI's own default-model row has no stored
    // preset, so it launches on `lastAgentSpawnPermissionPreset`.
    act(() => {
      goButtons()[0]?.click()
    })
    const defaultRow = rowNamed('Claude Code')
    assert.ok(defaultRow, 'the runtime’s own default-model row is there too')
    act(() => {
      defaultRow?.click()
    })
    assert.equal(ran.length, 2)
    assert.deepEqual(
      ran[1]?.launch,
      { cli: 'claude-code', model: null, reasoning: null, permissionPreset: 'manual' },
      'a row nobody has touched launches on the app-wide default preset, and on the CLI’s own model',
    )
    settle?.()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    setExtensionsSurfaceHost(null)
  }

  // ── Which row it opens on, and which rows it offers ────────────────────────
  // A card declaring `require.cli` PRESELECTS that runtime and says so in the
  // quiet line Frame 4 draws on its group heading. What it does NOT do is
  // shorten the list: Frame 4 draws a Codex group under the Claude Code group,
  // and the code agrees with the drawing, because a card's skills are copied
  // into every skills-capable harness on the machine rather than into the one
  // `require.cli` names.
  act(() => {
    useWorkspaceStore.setState(() => ({
      cards: [
        {
          slug: 'asks-for-claude-code',
          kind: 'skill' as const,
          title: 'A card that asks for a runtime',
          dek: 'It names the harness its skill is copied into.',
          art: 'tokens',
          publishedAt: '2026-09-06T00:00:00.000Z',
          go: [{ verb: 'require.cli' as const, cli: 'claude-code' }],
        },
        {
          slug: 'asks-for-a-runtime-you-do-not-have',
          kind: 'skill' as const,
          title: 'A card that asks for one you do not have',
          dek: 'It names a harness this machine has never installed.',
          art: 'browser',
          publishedAt: '2026-09-05T00:00:00.000Z',
          go: [{ verb: 'require.cli' as const, cli: 'a-cli-nobody-installed' }],
        },
      ] satisfies HostedCard[],
      cardFeedStatus: 'ready' as const,
    }))
  })

  // While the plugin catalogue is still LOADING, the catalogue is the legacy
  // fallback — three runtimes plus whatever is persisted — and `resources/plugins/`
  // ships a dozen. So "that runtime is not installed" is a sentence this page
  // has not earned yet, and it must not say it: a cold press on a card that
  // requires one of the other nine would otherwise be told a lie it acts on.
  act(() => {
    goButtons()[1]?.click()
  })
  assert.ok(picker(), 'a card whose runtime the catalogue has not answered for yet still opens a picker')
  assert.ok(
    !picker()?.textContent?.includes('is not installed'),
    'and it does not say a runtime is missing while it is still asking which are here',
  )
  closePicker()

  // The catalogue answers: two runtimes, one of them with an effort axis and a
  // model this test can name.
  act(() => {
    useWorkspaceStore.setState(() => ({
      pluginCatalogEntries: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          source: 'bundled',
          version: 1,
          binary: 'claude',
          modelSelection: { options: [{ id: MODEL }], allowCustomId: true },
          reasoningSelection: { levels: [{ id: 'low' }, { id: 'high' }] },
        },
        {
          id: 'codex',
          displayName: 'Codex',
          source: 'bundled',
          version: 1,
          binary: 'codex',
          modelSelection: { options: [{ id: 'gpt-6-astra' }], allowCustomId: true },
        },
      ] as never,
      pluginCatalogStatus: 'ready' as never,
    }))
  })

  {
    const ran: Array<{ slug: string; launch: CardLaunchChoice }> = []
    setExtensionsSurfaceHost({
      onLaunchConnector: () => {},
      onUseInAutomation: () => {},
      onUseSkillInNewAgent: () => {},
      onRunCard: (card, launch) => {
        ran.push({ slug: card.slug, launch })
        return Promise.resolve()
      },
    })

    act(() => {
      goButtons()[0]?.click()
    })
    const note = [...(picker()?.querySelectorAll('p') ?? [])].find((element) =>
      element.textContent?.includes('the card asks for this one'),
    )
    assert.ok(note, 'the picker says the card asked for this runtime, in the mockup’s own words')
    assert.ok(
      note?.textContent?.includes('Claude Code'),
      'and names the runtime it is about, because the line is that group’s heading',
    )
    assert.equal(
      note?.nextElementSibling?.getAttribute('role'),
      'listbox',
      'the line is a heading over the rows it describes — not a chip in the trailing row of controls',
    )
    assert.ok(
      pickerRows().some((row) => row.textContent?.includes(MODEL)),
      'and it opens on that runtime’s rows',
    )

    // The other runtimes are still there. The surface groups by provider on its
    // rail, so "the whole catalogue" is asserted where the catalogue lives.
    const railFor = (label: string) =>
      picker()?.querySelector(`[role="radio"][aria-label="${label}"]`) as HTMLElement | null
    assert.ok(railFor('Codex'), 'the runtime the card did not name is offered too — `require.cli` leads the list, it does not shorten it')
    act(() => {
      railFor('Codex')?.click()
    })
    assert.ok(
      pickerRows().some((row) => row.textContent?.includes('gpt-6-astra')),
      'and its rows can be reached and pressed',
    )
    closePicker()

    // The EFFORT the person set here rides the launch — and, like the row
    // itself, it is never written to the engine the next New chat opens on.
    act(() => {
      goButtons()[0]?.click()
    })
    const effortTrigger = picker()?.querySelector('[data-reasoning-trigger="true"]') as HTMLElement | null
    assert.ok(effortTrigger, 'the CLI declares an effort axis, so the picker offers it')
    act(() => {
      effortTrigger?.click()
    })
    const highLevel = [...dom.window.document.querySelectorAll('[data-reasoning-option="true"]')].find(
      (option) => option.textContent?.trim() === 'high',
    ) as HTMLElement | undefined
    assert.ok(highLevel, 'and the levels the manifest declares are the levels offered')
    act(() => {
      highLevel?.click()
    })
    assert.equal(
      useWorkspaceStore.getState().appSettings.specialistModelDefaults?.__general__?.reasoning,
      undefined,
      'touching effort on a card writes NOTHING to the engine the person’s next New chat opens on',
    )
    act(() => {
      rowNamed(MODEL)?.click()
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    assert.deepEqual(
      ran.at(-1)?.launch,
      { cli: 'claude-code', model: MODEL, reasoning: 'high', permissionPreset: 'auto' },
      'the level chosen here is the level the run launches at, on the row that was clicked',
    )
    // The whole point of holding the choice locally: a card is how to run ONE
    // card, not a new default for everything after it.
    assert.equal(
      useWorkspaceStore.getState().appSettings.specialistCliDefaults?.__general__,
      undefined,
      'and choosing a row leaves the remembered New-chat engine exactly where it was',
    )
    assert.equal(
      useWorkspaceStore.getState().appSettings.specialistModelDefaults?.__general__,
      undefined,
      'model included',
    )
    setExtensionsSurfaceHost(null)
  }

  // A card naming a CLI this machine does not have says which one, with the way
  // to install it — now that the catalogue has actually answered.
  act(() => {
    goButtons()[1]?.click()
  })
  assert.ok(
    picker()?.textContent?.includes('a-cli-nobody-installed'),
    'a card naming a CLI this machine does not have says which one',
  )
  assert.ok(
    picker()?.textContent?.includes('Install an agent CLI'),
    'and offers the one route that ends with having it — never an empty list',
  )
  assert.equal(pickerRows().length, 0, 'there is no model row to press, because there is no runtime to press it on')
  closePicker()
  act(() => {
    useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
  })

  // ── The tiles are still there, and they are underneath ───────────────────────
  assert.ok(tilesIn(home.host).length > 0, 'the tiles keep their place on the page')
  const regions = [...home.host.querySelectorAll('article, ul')]
  assert.equal(
    regions[regions.length - 1]?.tagName,
    'UL',
    'the cards are the reason to be here and the tiles are the way off, so the tiles come last',
  )
  assert.ok(
    home.host.textContent?.includes('Or go straight to the parts'),
    'and the quiet heading that turns them into the way off arrives with the cards',
  )

  // ── The search filters on title, dek and credit ──────────────────────────────
  const searchField = () => home.host.querySelector('input[type="search"]') as HTMLInputElement | null
  assert.ok(searchField(), 'a feed with cards in it gets a field to search them')

  // React DOM is imported above the jsdom globals in this bundle (esbuild hoists
  // it), so it decided at load that no DOM exists and runs its change-event
  // polyfill: a focused element is watched and a value change is noticed on
  // keyup. Typing here is that sequence — focus, set, keyup — the same one
  // `topbar/RemotePopover.test.tsx` and `ToastHost.test.tsx` already use.
  function search(value: string): void {
    const input = searchField()
    assert.ok(input, 'the search field is on the chrome row')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
    act(() => {
      input?.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }))
      setter?.call(input, value)
      input?.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      input?.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }))
    })
  }

  search('postcode')
  assert.deepEqual(
    cardsIn(home.host).map(titleOf),
    ['Build a 3D apocalypse of your own street'],
    'the dek is searched',
  )
  search('playwright')
  assert.deepEqual(cardsIn(home.host).map(titleOf), ['Let an agent drive your browser'], 'so is the credit, case and all')
  search('big task')
  assert.deepEqual(cardsIn(home.host).map(titleOf), ['Big task? No problem.'], 'and so is the title')
  assert.equal(
    [...home.host.querySelectorAll('button')].filter((button) =>
      (button.getAttribute('class') ?? '').includes('var(--accent-primary)'),
    ).length,
    1,
    'the hero keeps the accent while it is the only card showing',
  )
  search('nothing on any of these cards')
  assert.equal(cardsIn(home.host).length, 0)
  const noMatch = [...home.host.querySelectorAll('p')].find((line) =>
    line.textContent?.includes('No cards match this search'),
  )
  assert.ok(
    noMatch,
    'a search that matches nothing gets an answer — that is the person’s own question, not the page apologising for its network',
  )
  // And it is answered where the field said to look. `aria-controls` on the input
  // names the grid region, so a sentence sitting outside that region is a sentence
  // a reader following the pointer is never sent to; the live region inside it is
  // what makes the answer arrive rather than merely exist.
  assert.ok(
    noMatch?.closest(`#${searchField()?.getAttribute('aria-controls')}`),
    'the answer lives inside the region the search field says it controls',
  )
  assert.ok(noMatch?.closest('[aria-live="polite"]'), 'and inside a region that is watched, so it is spoken')
  assert.ok(tilesIn(home.host).length > 0, 'and the tiles are still there to leave by')
  search('')

  // ── A query does not outlive the field that typed it ─────────────────────────
  // The field is absent when there are no cards, so the query has to go with it:
  // state outlives the element that edits it, and a feed that emptied and came
  // back would otherwise return to a filter typed against a page that no longer
  // showed the box holding it — cards back, and an instant "no cards match".
  search('playwright')
  act(() => {
    useWorkspaceStore.setState(() => ({ cards: [], cardFeedStatus: 'ready' as const }))
  })
  assert.equal(searchField(), null, 'the field goes with the cards')
  act(() => {
    useWorkspaceStore.setState(() => ({ cards: FEED, cardFeedStatus: 'ready' as const }))
  })
  assert.equal(searchField()?.value, '', 'and the query went with the field')
  assert.equal(
    cardsIn(home.host).length,
    3,
    'so a feed that emptied and refilled comes back whole, not behind a filter nobody can see',
  )

  // ── Loading is a skeleton grid ───────────────────────────────────────────────
  act(() => {
    useWorkspaceStore.setState(() => ({ cards: [], cardFeedStatus: 'loading' as const }))
  })
  const shimmers = [...home.host.querySelectorAll('.skeleton-shimmer')]
  assert.ok(
    shimmers.length > 0,
    'a page with nothing to draw yet draws the shape of what is coming',
  )
  // And the shape is PAINTED. `.skeleton-shimmer` carries the sweep and no ground,
  // and the sweep itself only runs under `prefers-reduced-motion: no-preference` —
  // so a caller that passes no background draws transparent rectangles, and draws
  // nothing whatsoever on a machine that asked for less motion.
  for (const shimmer of shimmers) {
    assert.ok(
      /bg-\[color:var\(--[a-z-]+\)\]/.test(shimmer.getAttribute('class') ?? ''),
      'every skeleton carries the surface colour its own docstring says the caller owns',
    )
  }
  assert.equal(cardsIn(home.host).length, 0, 'and no cards while it waits')
  assert.ok(tilesIn(home.host).length > 0, 'the tiles do not wait on the network')

  // A read that fails behind cards that are already up keeps them: the feed going
  // away must never empty the page (R6).
  act(() => {
    useWorkspaceStore.setState(() => ({
      cards: FEED,
      cardFeedStatus: 'error' as const,
      cardFeedError: 'GitHub was slow',
    }))
  })
  assert.equal(cardsIn(home.host).length, 3, 'a failed re-read leaves the cards alone')
  assert.ok(
    !home.host.textContent?.includes('GitHub was slow'),
    'and the page does not repeat what its own network said',
  )

  home.unmount()
  drawer.unmount()
  console.log('ExtensionsHomeSurface.test.tsx: ok')
}

void main()
