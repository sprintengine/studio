import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The corner count on a tab (owner, 2026-09-10): how many things INSIDE this
// tab are waiting on the person, read before the tab is opened.
//
// It is not the tab's `count`, and the difference is the whole point of the
// assertions here. `count` is how many things the tab holds and rides beside
// the label in the reading line; this is how many of them want you, and it sits
// above the words because it is not part of them. A tab can carry both.

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

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { Tabs } = await import('./Tabs')
  type TabItem = import('./Tabs').TabItem

  type Root = ReturnType<typeof createRoot>

  function mount(node: React.ReactNode): { host: HTMLElement; root: Root } {
    const host = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(node))
    return { host, root }
  }

  function unmount(root: Root, host: HTMLElement): void {
    act(() => root.unmount())
    host.remove()
  }

  const strip = (items: TabItem[], iconOnly = false): React.ReactElement => (
    <Tabs ariaLabel="Sources" items={items} value={items[0]!.id} onChange={() => {}} iconOnly={iconOnly} />
  )

  let failures = 0
  function run(name: string, fn: () => void): void {
    try {
      fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  run('a badged tab carries both numbers, and they say different things', () => {
    const { host, root } = mount(
      strip([
        {
          id: 'studio',
          label: 'SprintEngine Studio',
          count: 10,
          badgeCount: 3,
          badgeLabel: 'SprintEngine Studio: 3 updates available',
        },
      ]),
    )
    const tab = host.querySelector('[role="tab"]') as HTMLElement
    const badge = host.querySelector('[role="status"]') as HTMLElement

    assert.ok(badge, 'the corner count renders')
    assert.equal(badge.textContent, '3')
    assert.equal(
      badge.getAttribute('aria-label'),
      'SprintEngine Studio: 3 updates available',
      'named with the tab and what is counted — a bare number docked on a word is not a sentence',
    )
    assert.match(host.textContent ?? '', /10/, 'the holdings count is still in the reading line')

    // A named child inside a button joins the button's name-from-contents, so
    // the tab must name itself explicitly or it announces the badge twice.
    assert.equal(
      tab.getAttribute('aria-label'),
      'SprintEngine Studio: 3 updates available',
      'the tab says its piece once — an explicit name wins over name-from-contents',
    )

    const dock = badge.parentElement as HTMLElement
    assert.match(dock.className, /absolute right-1 top-0\.5/, 'docked top-right of the tab')
    assert.doesNotMatch(
      dock.className,
      /-top-|-right-/,
      'and INSIDE the tab, never overhanging: outside a tab is the scroller’s clip',
    )
    assert.match(tab.className, /pr-6/, 'the tab reserves room, so the badge never reflows the label')
    assert.doesNotMatch(badge.className, /border/, 'no keyline — it covers the band, not a glyph')
    unmount(root, host)
  })

  run('an unbadged tab draws nothing and reserves nothing', () => {
    const { host, root } = mount(strip([{ id: 'installed', label: 'Installed', count: 4 }]))
    assert.equal(host.querySelector('[role="status"]'), null, 'no badge')
    assert.doesNotMatch((host.querySelector('[role="tab"]') as HTMLElement).className, /pr-6/, 'and no reservation')
    unmount(root, host)
  })

  // A tab that reserves trailing room (for the badge, or for a closable tab's
  // close glyph) must not ALSO carry the two-sided `px-3`: both set the right
  // edge, the shorthand won the cascade, and the reservation silently collapsed
  // to 12px — which drew the close glyph over the last letters of the label.
  // Class names are all a Node test can see; the computed padding is the CSS
  // build's, so the rule asserted here is "never both".
  run('a trailing reservation is never emitted beside the two-sided shorthand', () => {
    const badged = mount(strip([{ id: 'updates', label: 'Updates', badgeCount: 3 }]))
    const badgedTab = badged.host.querySelector('[role="tab"]') as HTMLElement
    assert.match(badgedTab.className, /(^|\s)pl-3(\s|$)/, 'leading padding stays')
    assert.doesNotMatch(badgedTab.className, /(^|\s)px-3(\s|$)/, 'and the shorthand that would override pr-6 is gone')
    unmount(badged.root, badged.host)

    const closable = mount(
      <Tabs
        ariaLabel="Documents"
        items={[{ id: 'board', label: 'race', closeLabel: 'Close race' }]}
        value="board"
        onChange={() => {}}
        onCloseItem={() => {}}
      />,
    )
    const closableTab = closable.host.querySelector('[role="tab"]') as HTMLElement
    assert.match(closableTab.className, /(^|\s)pr-8(\s|$)/, 'the close glyph has its reserved room')
    assert.match(closableTab.className, /(^|\s)pl-3(\s|$)/, 'leading padding stays')
    assert.doesNotMatch(closableTab.className, /(^|\s)px-3(\s|$)/, 'and nothing else sets the trailing edge')
    assert.ok(closable.host.querySelector('button[aria-label="Close race"]'), 'the close control is there')
    unmount(closable.root, closable.host)

    const plain = mount(strip([{ id: 'installed', label: 'Installed' }]))
    assert.match(
      (plain.host.querySelector('[role="tab"]') as HTMLElement).className,
      /(^|\s)px-3(\s|$)/,
      'a tab with nothing docked keeps the symmetric shorthand',
    )
    unmount(plain.root, plain.host)
  })

  run('a count of zero is not news', () => {
    const { host, root } = mount(strip([{ id: 'installed', label: 'Installed', badgeCount: 0 }]))
    assert.equal(
      host.querySelector('[role="status"]'),
      null,
      'a counter reading 0 is a counter spent saying there is no news',
    )
    unmount(root, host)
  })

  run('an icon-only strip draws no badge', () => {
    const { host, root } = mount(strip([{ id: 'log', label: 'Log', badgeCount: 5, icon: <svg /> }], true))
    assert.equal(
      host.querySelector('[role="status"]'),
      null,
      'a number pinned to a 30px glyph covers the mark it is badging — the tooltip is that strip’s slot',
    )
    unmount(root, host)
  })

  if (failures > 0) throw new Error(`${failures} Tabs badge assertions failed`)
  process.stdout.write('Tabs badge tests passed\n')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
