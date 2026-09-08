import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// Pager --inline (design-system/components/pager).
//
// A compression, and compressions are paid for — so the assertions are about
// what the variant is NOT allowed to drop:
//
//   1. the chevrons are DISABLED at the ends, never absent, because removing
//      them reflows the band under the pointer that is clicking them;
//   2. the words sentence is not drawn but is still said, as the position's
//      accessible name;
//   3. there is still exactly one live region;
//   4. the numbered strip and the foot padding are gone — that is the variant.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLButtonElement = dom.window.HTMLButtonElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

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

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { Pager, pagerSteps } = await import('./Pager')

  const document = dom.window.document

  function mount(node: React.ReactNode): { nav: HTMLElement; container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      nav: container.firstElementChild as HTMLElement,
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  function inline(page: number, noun?: string): React.ReactElement {
    return (
      <Pager
        inline
        page={page}
        pageCount={27}
        rangeLabel={`File ${page} of 27`}
        ariaLabel="Files in this commit"
        onPageChange={() => {}}
        inlineNoun={noun}
      />
    )
  }

  run('the stepper draws n/m and two chevrons, and nothing else', () => {
    const view = mount(inline(2))
    const buttons = Array.from(view.nav.querySelectorAll('button'))
    assert.equal(buttons.length, 2, 'no numbered strip: the band has no width for it')
    assert.match(view.nav.textContent ?? '', /^2\/27$/)
    assert.ok(
      !/pt-3/.test(view.nav.getAttribute('class') ?? ''),
      'no foot padding — this is a stepper in a band, not the foot of a list',
    )
    view.unmount()
  })

  run('the sentence is not drawn, but it is still said', () => {
    const view = mount(inline(2))
    const position = view.nav.querySelector('[role="status"]') as HTMLElement
    assert.ok(position)
    assert.equal(position.textContent, '2/27', 'the drawing shrinks')
    assert.equal(position.getAttribute('aria-label'), 'File 2 of 27', 'the announcement does not')
    assert.equal(position.getAttribute('aria-live'), 'polite')
    assert.equal(
      view.nav.querySelectorAll('[aria-live]').length,
      1,
      'still exactly one live region in the pager',
    )
    view.unmount()
  })

  run('the ends disable the chevrons rather than removing them', () => {
    const first = mount(inline(1))
    const firstButtons = Array.from(first.nav.querySelectorAll('button')) as HTMLButtonElement[]
    assert.equal(firstButtons.length, 2, 'removing one would reflow the band under the pointer clicking it')
    assert.equal(firstButtons[0].disabled, true)
    assert.equal(firstButtons[1].disabled, false)

    const last = mount(inline(27))
    const lastButtons = Array.from(last.nav.querySelectorAll('button')) as HTMLButtonElement[]
    assert.equal(lastButtons[0].disabled, false)
    assert.equal(lastButtons[1].disabled, true)

    first.unmount()
    last.unmount()
  })

  run('the chevrons are square at the band\'s own control step', () => {
    const view = mount(inline(2))
    const button = view.nav.querySelector('button') as HTMLElement
    const classes = button.getAttribute('class') ?? ''
    assert.match(classes, /size-control-xs/, 'level with the ToolbarButtons beside it, not a step taller')
    assert.ok(!/h-control-sm/.test(classes))
    view.unmount()
  })

  run('paging is navigation, and it says what it is paging', () => {
    const clicks: number[] = []
    const view = mount(
      <Pager
        inline
        page={2}
        pageCount={27}
        rangeLabel="File 2 of 27"
        ariaLabel="Files in this commit"
        onPageChange={(next) => clicks.push(next)}
      />,
    )
    assert.equal(view.nav.tagName, 'NAV')
    assert.equal(view.nav.getAttribute('aria-label'), 'Files in this commit')
    const buttons = Array.from(view.nav.querySelectorAll('button'))
    act(() => {
      buttons[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      buttons[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(clicks, [3, 1])
    view.unmount()
  })

  run('an optional noun rides after the numbers, and the default is bare n/m', () => {
    const withNoun = mount(inline(2, 'files'))
    assert.equal((withNoun.nav.querySelector('[role="status"]') as HTMLElement).textContent, '2/27 files')
    const bare = mount(inline(2))
    assert.equal((bare.nav.querySelector('[role="status"]') as HTMLElement).textContent, '2/27')
    withNoun.unmount()
    bare.unmount()
  })

  run('the full pager is untouched by the variant', () => {
    const view = mount(
      <Pager
        page={2}
        pageCount={27}
        rangeLabel="Showing 13–24 of 318"
        ariaLabel="Plugins"
        onPageChange={() => {}}
      />,
    )
    assert.match(view.nav.textContent ?? '', /Showing 13–24 of 318/, 'the words sentence is still drawn here')
    assert.match(view.nav.getAttribute('class') ?? '', /pt-3/, 'and it is still the foot of a list')
    assert.ok(view.nav.querySelectorAll('button').length > 2, 'with its numbered strip')
    assert.deepEqual(pagerSteps(2, 27), [1, 2, 3, 4, 'gap', 27], 'and the same window of numbers')
    view.unmount()
  })

  if (failures > 0) {
    console.error(`\nPager.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('Pager --inline: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
