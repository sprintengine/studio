import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// SegmentedControl --icon-only (design-system/components/segmented-control).
//
// The variant's one risk is the whole reason the "no glyphs-as-labels" line
// needed a carve-out rather than a deletion: a segment that drops its word and
// keeps nothing is a blank button. So the assertions are about the word STILL
// BEING THERE — as the accessible name and as the tooltip — and about the
// square matching the toolbar items beside it.

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
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver

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
  const { SegmentedControl } = await import('./SegmentedControl')

  const document = dom.window.document
  const glyph = <svg viewBox="0 0 16 16" />

  function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  const items = [
    { value: 'split', label: 'Side by side', icon: glyph },
    { value: 'unified', label: 'Unified', icon: glyph },
  ]

  function iconStrip(value = 'split'): React.ReactElement {
    return (
      <SegmentedControl
        ariaLabel="Diff layout"
        iconOnly
        items={items}
        value={value}
        onChange={() => {}}
      />
    )
  }

  run('the label does not disappear — it becomes the accessible name', () => {
    const view = mount(iconStrip())
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'))
    assert.equal(radios.length, 2)
    assert.deepEqual(
      radios.map((radio) => radio.getAttribute('aria-label')),
      ['Side by side', 'Unified'],
      'a segment with no label and no tooltip is a blank button — the one thing this variant can get wrong',
    )
    assert.equal(radios[0].textContent, '', 'and the word is not also drawn')
    view.unmount()
  })

  run('the name is identical to the labelled variant\'s', () => {
    const labelled = mount(
      <SegmentedControl ariaLabel="Diff layout" items={items} value="split" onChange={() => {}} />,
    )
    const labelledRadio = labelled.container.querySelector('[role="radio"]') as HTMLElement
    assert.equal(labelledRadio.textContent, 'Side by side')
    assert.equal(labelledRadio.getAttribute('aria-label'), null, 'the visible word IS the name there')

    const icons = mount(iconStrip())
    const iconRadio = icons.container.querySelector('[role="radio"]') as HTMLElement
    assert.equal(
      iconRadio.getAttribute('aria-label'),
      labelledRadio.textContent,
      'one string, drawn in one variant and labelled in the other',
    )
    labelled.unmount()
    icons.unmount()
  })

  run('the glyph is hidden from assistive tech, so the name is read once', () => {
    const view = mount(iconStrip())
    const radio = view.container.querySelector('[role="radio"]') as HTMLElement
    const holder = radio.querySelector('span')
    assert.equal(holder?.getAttribute('aria-hidden'), 'true')
    assert.ok(radio.querySelector('svg'), 'the icon is drawn')
    view.unmount()
  })

  run('segments are square at the toolbar\'s own control step', () => {
    const view = mount(iconStrip())
    const radio = view.container.querySelector('[role="radio"]') as HTMLElement
    const classes = radio.getAttribute('class') ?? ''
    assert.match(classes, /size-control-xs/, 'the strip sits level with the button --icon items beside it')
    assert.match(classes, /px-0/)
    assert.ok(!/h-control-sm/.test(classes), 'never the 30px form-control step in a 30px band')
    view.unmount()
  })

  run('selection stays neutral, and the radiogroup contract is untouched', () => {
    const view = mount(iconStrip('unified'))
    const radios = Array.from(view.container.querySelectorAll('[role="radio"]'))
    assert.deepEqual(radios.map((r) => r.getAttribute('aria-checked')), ['false', 'true'])
    assert.deepEqual(radios.map((r) => (r as HTMLButtonElement).tabIndex), [-1, 0], 'one tab stop, on the selection')
    const checked = radios[1].getAttribute('class') ?? ''
    assert.match(checked, /bg-\[color:var\(--bg-selected\)\]/)
    assert.ok(!/bg-\[color:var\(--accent-primary\)\]/.test(checked), 'a selected segment is a state display, not the primary action')
    assert.equal(view.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label'), 'Diff layout')
    view.unmount()
  })

  run('the tooltip wrapper does not become a child of the radiogroup', () => {
    const view = mount(iconStrip())
    const group = view.container.querySelector('[role="radiogroup"]') as HTMLElement
    for (const child of Array.from(group.children)) {
      if (child.getAttribute('role') === 'radio') continue
      assert.equal(
        child.getAttribute('role'),
        'presentation',
        'a radiogroup\'s children are its radios; the tooltip\'s span is a rendering detail',
      )
    }
    view.unmount()
  })

  if (failures > 0) {
    console.error(`\nSegmentedControl.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('SegmentedControl --icon-only: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
