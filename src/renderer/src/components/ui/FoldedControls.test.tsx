import { JSDOM } from 'jsdom'
import { expect, test } from 'vitest'

// The fold moves controls, it never drops them: unfolded they sit in the row
// with no wrapper, folded they are one chevron away, and a fold with nothing in
// it draws no chevron at all.
test('FoldedControls keeps every control reachable, and only folds when told to', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  })
  const previous = Object.getOwnPropertyDescriptors(globalThis)
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  try {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { FoldedControls, useMeasuredFold } = await import('./FoldedControls')
    const document = dom.window.document

    function mount(node: React.ReactNode) {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => root.render(node))
      return {
        container,
        unmount: () => {
          act(() => root.unmount())
          container.remove()
        },
      }
    }

    const controls = (
      <>
        <span data-control="worktree">Worktree</span>
        <span data-control="skills">Skills</span>
      </>
    )

    // Unfolded: the controls are the row's own children, in order, unwrapped.
    const open = mount(
      <div data-row="">
        <FoldedControls folded={false} ariaLabel="More launch settings">
          {controls}
        </FoldedControls>
      </div>,
    )
    const row = open.container.querySelector('[data-row]')
    expect(Array.from(row?.children ?? []).map((child) => child.getAttribute('data-control'))).toEqual([
      'worktree',
      'skills',
    ])
    expect(open.container.querySelector('[aria-label="More launch settings"]')).toBeNull()
    open.unmount()

    // Folded: one raised chip names the fold, and pressing it shows the same
    // controls.
    const folded = mount(
      <FoldedControls folded ariaLabel="More launch settings">
        {controls}
      </FoldedControls>,
    )
    expect(folded.container.querySelector('[data-control]')).toBeNull()
    const trigger = folded.container.querySelector<HTMLButtonElement>('button[aria-label="More launch settings"]')
    expect(trigger).not.toBeNull()
    expect(trigger?.className).toContain('control-edge')
    act(() => trigger?.click())
    expect(document.body.querySelector('[data-control="worktree"]')).not.toBeNull()
    expect(document.body.querySelector('[data-control="skills"]')).not.toBeNull()
    folded.unmount()

    // Nothing to fold is no chevron, not one that opens an empty popover.
    const empty = mount(
      <FoldedControls folded ariaLabel="More launch settings">
        {null}
        {false}
      </FoldedControls>,
    )
    expect(empty.container.querySelector('button')).toBeNull()
    empty.unmount()

    // A row jsdom cannot lay out measures 0px, which is "not laid out yet",
    // never "0px wide": the unfolded row is what it gets.
    let measured: boolean | null = null
    function Probe() {
      const [isFolded, ref] = useMeasuredFold(520)
      measured = isFolded
      return <div ref={ref} />
    }
    const probe = mount(<Probe />)
    expect(measured).toBe(false)
    probe.unmount()
  } finally {
    for (const key of Object.keys(globalThis)) {
      if (!(key in previous)) Reflect.deleteProperty(globalThis, key)
    }
    Object.defineProperties(globalThis, previous)
  }
})
