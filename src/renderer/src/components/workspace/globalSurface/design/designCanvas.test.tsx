import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type {
  DesignSystemBundleView,
  DesignSystemComponentView,
} from '../../../../../../shared/design-system/bundle-view'
import { designSystemEntryKey } from '../../../../../../shared/design-system/new-entries'
import type { DesignCanvasTabId } from './DesignCanvas'

// The Design door's canvas, v2 (approved mock-up, 2026-09-08).
//
// The shape the owner ruled for, and the six things about it that are silent
// when they break:
//
//   1. SIX TABS, not a scroll. Colour · Type · Spacing · Components · Patterns ·
//      Glyphs, in the kit's strip, and only for what the bundle actually has.
//      The tab and the page are the DOOR's state, handed in — a canvas that kept
//      them itself would lose them on every re-read and could not be tested at
//      all without driving a click.
//   2. PAGED EIGHT AT A TIME, with the position in words. A pager that hid the
//      total would be the "Show 20 more" idiom it replaced.
//   3. NO DETAIL VIEW. The stage IS the component, at full size; there is
//      nothing to click into and nothing to come back from.
//   4. NO PROSE. No counts line, no spec disclosure, and the demo's own
//      captions removed in composition — asserted on the composed document,
//      because a caption hidden by CSS is still a caption on the page.
//   5. GLYPHS ARE A STRIP: one document, one frame, every cell named by
//      `title`/`aria-label` and nothing printed.
//   6. THE TOKEN TABS PRINT PATHS. The swatch is the hex and the row is drawn at
//      the value; neither is written out.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver

let failures = 0
function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

// ── The fixture: a bundle big enough to page ─────────────────────────────────

const COMPONENT_NAMES = Array.from({ length: 20 }, (_unused, index) => `component-${index + 1}`)

/** A stage as the bundle format writes one: a caption, then the specimens. */
function stageHtml(name: string): string {
  return [
    `<p class="demo-label">Light — ${name}: the tone classifies the row.</p>`,
    `<div class="demo-row"><button class="ds-button">${name}</button></div>`,
  ].join('\n')
}

function component(name: string): DesignSystemComponentView {
  return {
    name,
    css: '.ds-button{border-radius:7px}',
    inlineStyles: [],
    stages: [{ mode: 'light', html: stageHtml(name) }],
    variantCount: 3,
    stateCount: 4,
    doc: {
      anatomy: 'Label.',
      variants: '- primary\n- secondary',
      states: '- rest\n- hover',
      usage: 'One primary per view.',
      accessibility: 'Native button.',
    },
    unresolvedRefs: [],
  }
}

const view = {
  identity: {
    path: '/work/brand/design-system',
    name: 'multicode',
    version: '2.4.0',
    summary: 'The in-house system.',
    // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
    accent: { light: '#2f6a4a', dark: '#4daf7d' },
  },
  manifest: {
    schemaVersion: 1,
    name: 'multicode',
    version: '2.4.0',
    summary: 'The in-house system.',
    modes: ['light', 'dark'],
    namingGrammar: {},
    contents: {
      components: COMPONENT_NAMES,
      patterns: ['patterns/context-rail.html'],
      glyphs: ['check', 'close'],
    },
    derived: {},
    provenance: {},
  },
  specimen: {
    // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
    tokensCss: ':root{--sem-color-bg-app:#08080c}',
    ramp: [
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      { path: 'ref.color.ink-900', light: '#101418', dark: '#e7ecf1' },
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      { path: 'ref.color.ink-800', light: '#20262c', dark: '#cfd6dd' },
      // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
      { path: 'ref.color.green-500', light: '#2f6a4a', dark: '#4daf7d' },
    ],
    fontFamilyUi: 'Inter, system-ui',
    fontFamilyMono: null,
    tokens: {
      fontSize: [
        { path: 'sem.font.size.meta', light: '12px', dark: '12px' },
        { path: 'sem.font.size.title', light: '18px', dark: '18px' },
      ],
      fontWeight: [{ path: 'sem.font.weight.emphasis', light: '600', dark: '600' }],
      fontLine: [{ path: 'sem.font.line.body', light: '1.5', dark: '1.5' }],
      fontTracking: [{ path: 'sem.font.tracking.wide', light: '0.02em', dark: '0.02em' }],
      space: [{ path: 'sem.space.md', light: '10px', dark: '10px' }],
      size: [{ path: 'sem.size.control.sm', light: '30px', dark: '30px' }],
      radius: [{ path: 'sem.radius.control', light: '7px', dark: '7px' }],
      shadow: [
        {
          path: 'sem.shadow.popover',
          // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
          light: '0 1px 3px rgba(16, 20, 24, 0.06)',
          // design-tokens-allow: a PREVIEWED bundle's own tokens are content under test, not app chrome — the point is that they are not ours.
          dark: '0 8px 24px -12px rgba(0, 0, 0, 0.6)',
        },
      ],
    },
    problems: [],
  },
  groups: [
    { key: 'components', label: 'Components', entries: COMPONENT_NAMES, count: COMPONENT_NAMES.length },
    { key: 'patterns', label: 'Patterns', entries: ['patterns/context-rail.html'], count: 1 },
    { key: 'glyphs', label: 'Glyphs', entries: ['check', 'close'], count: 2 },
  ],
  components: COMPONENT_NAMES.map(component),
  patterns: [
    {
      name: 'context-rail',
      html: `<p class="demo-label">The rail beside a canvas.</p>\n<div class="demo-pane">rail</div>`,
      inlineStyles: [],
      unresolvedRefs: [],
    },
  ],
  glyphs: [
    { name: 'check', svg: '<svg viewBox="0 0 16 16"><path d="M3 8l3 3 7-7"/></svg>' },
    { name: 'close', svg: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8"/></svg>' },
  ],
  assetBudgetExhausted: false,
} as unknown as DesignSystemBundleView

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { DesignCanvas, designCanvasTabs, pageWindow } = await import('./DesignCanvas')

  const container = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(container)
  const root = createRoot(container)

  const changed: Array<[string, number | string]> = []

  function mount(options: {
    tab?: DesignCanvasTabId | null
    pages?: Partial<Record<DesignCanvasTabId, number>>
    mode?: 'light' | 'dark'
    newEntries?: ReadonlySet<string>
  }): void {
    act(() => {
      root.render(
        <DesignCanvas
          view={view}
          mode={options.mode ?? 'light'}
          newEntries={options.newEntries}
          tab={options.tab ?? null}
          onTabChange={(next) => changed.push(['tab', next])}
          pages={options.pages ?? {}}
          onPageChange={(tab, page) => changed.push([`page:${tab}`, page])}
        />,
      )
    })
  }

  const text = (): string => container.textContent ?? ''
  const frames = (): HTMLIFrameElement[] => Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[]
  const tabs = (): Element[] => Array.from(container.querySelectorAll('[role="tab"]'))

  // ── The band ───────────────────────────────────────────────────────────────

  mount({})

  run('the canvas is the six tabs, in order, and opens on the components', () => {
    assert.deepEqual(
      tabs().map((tab) => (tab.textContent ?? '').replace(/\d+$/, '')),
      ['Colour', 'Type', 'Spacing', 'Components', 'Patterns', 'Glyphs'],
    )
    const selected = tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')
    assert.equal(selected.length, 1, 'exactly one tab is selected')
    assert.equal((selected[0].textContent ?? '').replace(/\d+$/, ''), 'Components')
    // The tab's own count keeps the total visible even while a page hides most
    // of it: 20 components behind a page of 8.
    assert.match(selected[0].textContent ?? '', /20$/)
  })

  run('a tab a bundle has nothing for is not drawn', () => {
    const bare = {
      ...view,
      groups: view.groups.filter((group) => group.key === 'components'),
      patterns: [],
      glyphs: [],
      specimen: { ...view.specimen, ramp: [] },
    } as unknown as DesignSystemBundleView
    assert.deepEqual(
      designCanvasTabs(bare).map((item) => item.id),
      ['type', 'spacing', 'components'],
      'the manifest decides, not us — an empty group gets no tab at all',
    )
  })

  run('the tab is the door’s state: the strip reports, it does not decide', () => {
    changed.length = 0
    const glyphTab = tabs().find((tab) => (tab.textContent ?? '').startsWith('Glyphs'))
    act(() => {
      ;(glyphTab as HTMLElement).click()
    })
    assert.deepEqual(changed, [['tab', 'glyphs']], 'the click is reported upward')
    assert.equal(
      (tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? '').replace(/\d+$/, ''),
      'Components',
      'and nothing moved until the door said so',
    )
  })

  // ── Components ─────────────────────────────────────────────────────────────

  run('components are paged eight at a time, and the pager states where you are', () => {
    mount({ tab: 'components' })
    assert.match(text(), /Showing 1–8 of 20/)
    assert.equal(frames().length, 8, 'eight live documents, not twenty')
    assert.deepEqual(
      Array.from(container.querySelectorAll('h3')).map((heading) => heading.textContent),
      COMPONENT_NAMES.slice(0, 8),
      'page one is the first eight, in the reader’s order',
    )
    assert.deepEqual(pageWindow(20, 3), { page: 3, pageCount: 3, from: 16, to: 20 })
    // A page number outlives the list it was taken on.
    assert.equal(pageWindow(20, 99).page, 3, 'a page past the end clamps')
    assert.equal(pageWindow(20, 0).page, 1)
  })

  run('the second page is the second eight, and paging is reported upward', () => {
    mount({ tab: 'components', pages: { components: 2 } })
    assert.match(text(), /Showing 9–16 of 20/)
    assert.deepEqual(
      Array.from(container.querySelectorAll('h3')).map((heading) => heading.textContent),
      COMPONENT_NAMES.slice(8, 16),
      'page one is gone, not merely scrolled past',
    )
    changed.length = 0
    const next = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Next page',
    )
    assert.ok(next, 'the pager offers the next page')
    act(() => {
      ;(next as HTMLElement).click()
    })
    assert.deepEqual(changed, [['page:components', 3]])
  })

  run('a specimen is a name, a chip and a demo — no counts line, no spec, no detail view', () => {
    mount({
      tab: 'components',
      newEntries: new Set([designSystemEntryKey('components', 'component-2')]),
    })
    const headings = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent ?? '')
    assert.ok(headings.includes('component-1'), 'the name is the section heading')
    // The fixture declares 3 variants and 4 states, and neither is drawn.
    assert.ok(!/variants?/i.test(text()), 'no counts line')
    assert.ok(!/states?/i.test(text()), 'and no state count')
    assert.equal(container.querySelectorAll('details').length, 0, 'no spec disclosure')
    assert.ok(!text().includes('Anatomy'), 'and none of component.md on the canvas')
    // Nothing to click into: the only buttons on the page are the pager's.
    const buttons = Array.from(container.querySelectorAll('button')).filter(
      (button) => button.closest('[role="tablist"]') === null && button.closest('nav') === null,
    )
    assert.equal(buttons.length, 0, 'a specimen is not a control')
    assert.ok(!text().includes('All components'), 'and there is nothing to come back from')
    // The New chip lands on the entry the door marked, and only that one.
    assert.match(text(), /New/, 'the marked component wears the chip')
    const marked = Array.from(container.querySelectorAll('section')).filter((section) =>
      (section.textContent ?? '').includes('New'),
    )
    assert.equal(marked.length, 1, 'exactly one specimen is marked')
    assert.match(marked[0].textContent ?? '', /component-2/)
  })

  run('the demo’s captions are removed from the document, not hidden in it', () => {
    mount({ tab: 'components' })
    const srcDoc = frames()[0]?.getAttribute('srcdoc') ?? ''
    assert.ok(srcDoc.length > 0, 'the specimen composes a document')
    assert.ok(!srcDoc.includes('demo-label'), 'the caption element is gone')
    assert.ok(!srcDoc.includes('the tone classifies the row'), 'and so is its sentence')
    assert.match(srcDoc, /demo-row/, 'everything else is exactly as authored')
    assert.match(srcDoc, /ds-button/)
    assert.match(srcDoc, /data-mode="light"/, 'and it paints the mode the app is in')
  })

  run('the frame carries the mode the app is in', () => {
    mount({ tab: 'components', mode: 'dark' })
    assert.match(frames()[0]?.getAttribute('srcdoc') ?? '', /data-mode="dark"/)
  })

  // ── Patterns and glyphs ────────────────────────────────────────────────────

  run('patterns render exactly like components', () => {
    mount({ tab: 'patterns' })
    assert.match(text(), /Showing 1–1 of 1/)
    const srcDoc = frames()[0]?.getAttribute('srcdoc') ?? ''
    assert.ok(!srcDoc.includes('demo-label'), 'captions go here too')
    assert.match(srcDoc, /demo-pane/)
    assert.deepEqual(
      Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
      ['context-rail'],
      'the pattern is named once, as a heading',
    )
  })

  run('glyphs are ONE strip: one document, every cell named, nothing printed', () => {
    mount({ tab: 'glyphs' })
    assert.equal(frames().length, 1, 'one frame for the whole strip, not one per glyph')
    const srcDoc = frames()[0]?.getAttribute('srcdoc') ?? ''
    for (const name of ['check', 'close']) {
      assert.ok(srcDoc.includes(`title="${name}"`), `${name} names itself on hover`)
      assert.ok(srcDoc.includes(`aria-label="${name}"`), `${name} names itself to a reader`)
    }
    assert.match(srcDoc, /glyph-strip/)
    assert.match(srcDoc, /var\(--sem-icon-size-lg\)/, 'drawn at the kit’s icon step')
    // No heading per glyph and no caption under one: the names live in the
    // attributes, and the app-side markup prints none of them.
    assert.equal(container.querySelectorAll('h3').length, 0, 'no section per glyph')
    assert.ok(!text().includes('check'), 'and no name printed beside the mark')
  })

  // ── The token tabs ─────────────────────────────────────────────────────────

  run('colour is swatch rows: the path printed, the hex only on hover', () => {
    mount({ tab: 'colour' })
    assert.match(text(), /ref\.color\.ink-900/, 'the token path is the row')
    // design-tokens-allow: asserting the ABSENCE of the previewed bundle's own hex on the page.
    assert.ok(!text().includes('#101418'), 'the swatch IS the hex; it is never printed')
    const swatch = container.querySelector('[role="img"][title="ref.color.ink-900"]')
    assert.ok(swatch, 'the swatch names itself on hover')
    assert.equal(swatch?.getAttribute('aria-label'), 'ref.color.ink-900', 'and to a reader')
    // Grouped by family, so a 42-colour ramp reads as families rather than a list.
    assert.deepEqual(
      Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
      ['ink', 'green'],
    )
  })

  run('the swatch is painted in the mode the app is in', () => {
    mount({ tab: 'colour', mode: 'dark' })
    const swatch = container.querySelector('[title="ref.color.ink-900"]') as HTMLElement | null
    // jsdom normalises a hex to `rgb()`, exactly as a browser does.
    assert.match(swatch?.getAttribute('style') ?? '', /rgb\(231, 236, 241\)/)
  })

  run('type sets each token’s own name in its own step, and prints no value', () => {
    mount({ tab: 'type' })
    assert.match(text(), /sem\.font\.size\.title/)
    assert.ok(!text().includes('18px'), 'the row is drawn at the size; the size is not written out')
    const title = Array.from(container.querySelectorAll('[title="sem.font.size.title"]')).at(-1)
    assert.match((title as HTMLElement)?.getAttribute('style') ?? '', /font-size:\s*18px/)
    const weight = container.querySelector('[title="sem.font.weight.emphasis"]') as HTMLElement | null
    assert.match(weight?.getAttribute('style') ?? '', /font-weight:\s*600/)
    // Leading only exists between lines, so the leading row sets its name more
    // than once and lets it wrap.
    const line = container.querySelector('[title="sem.font.line.body"]')
    assert.equal((line?.textContent ?? '').split('sem.font.line.body').length - 1, 3)
    // The family section is gone with the second face: one face on the page
    // means a family specimen shows the reader the same thing twice.
    assert.ok(!text().includes('sem.font.family'))
  })

  run('spacing draws the shape at the token’s value, and prints only the path', () => {
    mount({ tab: 'spacing' })
    assert.deepEqual(
      Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
      ['Space', 'Size', 'Radius', 'Shadow'],
    )
    assert.match(text(), /sem\.space\.md/)
    assert.ok(!text().includes('10px'), 'the square IS the value')
    const square = container.querySelector('[title="sem.space.md"]') as HTMLElement | null
    assert.match(square?.getAttribute('style') ?? '', /width:\s*10px/)
    const radius = container.querySelector('[title="sem.radius.control"]') as HTMLElement | null
    assert.match(radius?.getAttribute('style') ?? '', /border-radius:\s*7px/)
    // A shadow is the one family that really differs by mode.
    const shadow = container.querySelector('[title="sem.shadow.popover"]') as HTMLElement | null
    assert.match(shadow?.getAttribute('style') ?? '', /rgba\(16, 20, 24, 0\.06\)/)
    mount({ tab: 'spacing', mode: 'dark' })
    const dark = container.querySelector('[title="sem.shadow.popover"]') as HTMLElement | null
    assert.match(dark?.getAttribute('style') ?? '', /rgba\(0, 0, 0, 0\.6\)/)
  })

  // ── The door's own chrome ──────────────────────────────────────────────────

  run('one font, and the folder is the only provenance on the band', () => {
    mount({ tab: 'components' })
    const classes = new Set<string>()
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const token of (element.getAttribute('class') ?? '').split(/\s+/)) {
        if (token) classes.add(token)
      }
    }
    assert.ok(!classes.has('font-mono'), 'nothing in the door is set in mono')
    for (const element of Array.from(container.querySelectorAll('[style]'))) {
      assert.ok(!/font-family/i.test(element.getAttribute('style') ?? ''), 'and no element states a face of its own')
    }
    assert.match(text(), /\/work\/brand\/design-system/, 'the folder rides the band')
    assert.ok(!text().includes('multicode'), 'the name is the door bar’s, and only the door bar’s')
  })

  run('every frame is inert, and the measured ones are the only same-origin ones', () => {
    mount({ tab: 'components' })
    for (const frame of frames()) {
      const sandbox = frame.getAttribute('sandbox') ?? ''
      assert.ok(!sandbox.includes('allow-scripts'), 'scripts are off in every preview')
      assert.match(frame.getAttribute('srcdoc') ?? '', /default-src 'none'/)
      assert.ok(frame.getAttribute('title'), 'a frame without a name is an unlabelled landmark')
    }
  })

  act(() => {
    root.unmount()
  })

  if (failures > 0) {
    throw new Error(`${failures} design canvas contract(s) failed`)
  }
  console.log('designCanvas.test.tsx: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
