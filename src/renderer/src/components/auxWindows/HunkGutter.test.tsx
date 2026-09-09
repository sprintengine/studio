import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

import type { GlyphMarginWidget } from './HunkGutter'

// The gutter's Monaco wiring (git-commit-window T7), driven against a fake
// glyph-margin host so the assertions are about THIS file rather than about
// Monaco. Four things it is easy to get wrong, and each of them is a bug a
// person would meet:
//
//   1. a widget left behind on unmount — the boxes leak into the next file;
//   2. a widget rebuilt on every render — the box flickers as you scroll;
//   3. a widget NOT rebuilt when its hunk moves — after staging one hunk the
//      remaining boxes are drawn beside the wrong lines;
//   4. an editor disposed under the cleanup — a file switch throws.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
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

void main()

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { HunkGutter } = await import('./HunkGutter')
  const { hunkBoxes } = await import('./hunkGutterModel')
  const document = dom.window.document

  /** A glyph margin that keeps its widgets in a map and mounts their nodes,
   *  which is all Monaco does that matters here. */
  function fakeEditor(): {
    host: { addGlyphMarginWidget(w: GlyphMarginWidget): void; removeGlyphMarginWidget(w: GlyphMarginWidget): void }
    margin: HTMLElement
    widgets: Map<string, GlyphMarginWidget>
    adds: number
    lineOf(id: string): number | undefined
  } {
    const margin = document.createElement('div')
    document.body.appendChild(margin)
    const widgets = new Map<string, GlyphMarginWidget>()
    const state = {
      margin: margin as unknown as HTMLElement,
      widgets,
      adds: 0,
      lineOf: (id: string) => widgets.get(id)?.getPosition().range.startLineNumber,
      host: {
        addGlyphMarginWidget(widget: GlyphMarginWidget) {
          state.adds += 1
          widgets.set(widget.getId(), widget)
          margin.appendChild(widget.getDomNode())
        },
        removeGlyphMarginWidget(widget: GlyphMarginWidget) {
          widgets.delete(widget.getId())
          widget.getDomNode().remove()
        },
      },
    }
    return state
  }

  function boxesFor(lines: number[], included = false, override = null as null | { index: number; checked: boolean }) {
    return hunkBoxes({
      hunks: lines.map((line, index) => ({
        index,
        scope: included ? ('staged' as const) : ('unstaged' as const),
        oldStart: line,
        oldLines: 1,
        newStart: line,
        newLines: 1,
        fingerprint: `h${index}`,
        included,
      })),
      key: 'unstaged:/repo/a.ts',
      override: override
        ? {
            fileKey: 'unstaged:/repo/a.ts',
            // A box is named by its hunk's body, never by the slot it was read
            // in — the gutter draws the union of two diffs, and including one
            // hunk renumbers the rest.
            hunkKey: `${included ? 'staged' : 'unstaged'}\nh${override.index}`,
            checked: override.checked,
            afterRevision: 0,
          }
        : null,
      relativePath: 'a.ts',
    })
  }

  function mount(node: React.ReactNode): { container: HTMLElement; render: (next: React.ReactNode) => void; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => root.render(node))
    return {
      container: container as unknown as HTMLElement,
      render: (next) => act(() => root.render(next)),
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  run('one widget per hunk, at the hunk\'s own line on the modified side', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4, 19])} onToggle={() => {}} />)
    assert.equal(editor.widgets.size, 2)
    assert.equal(editor.lineOf('multicode.hunk-include.unstaged.0'), 4)
    assert.equal(editor.lineOf('multicode.hunk-include.unstaged.1'), 19)
    // The lane is the centre one, and every widget asks for the same one.
    assert.deepEqual(
      [...editor.widgets.values()].map((widget) => widget.getPosition().lane),
      [2, 2],
    )
    view.unmount()
  })

  run('the box is a checkbox with a name, and the drawn square is hidden', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4])} onToggle={() => {}} />)
    const box = editor.margin.querySelector('[role="checkbox"]') as HTMLElement
    assert.ok(box, 'the widget node holds the control')
    assert.equal(box.getAttribute('aria-checked'), 'false')
    assert.equal(box.getAttribute('aria-label'), 'Include the change at line 4 of a.ts')
    assert.equal(box.getAttribute('tabindex'), '0')
    // The picture is met once, through the control's own name.
    assert.ok(box.querySelector('span[aria-hidden="true"]'), 'CheckboxBox draws the square')
    assert.equal(editor.margin.querySelectorAll('input').length, 0)
    view.unmount()
  })

  run('a click and a Space both toggle, and each names one hunk', () => {
    const editor = fakeEditor()
    const toggled: string[] = []
    const view = mount(
      <HunkGutter editor={editor.host} boxes={boxesFor([4, 19])} onToggle={(key) => toggled.push(key)} />,
    )
    const boxes = editor.margin.querySelectorAll('[role="checkbox"]')
    act(() => {
      boxes[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      boxes[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    })
    assert.deepEqual(toggled, ['unstaged\nh1', 'unstaged\nh0'])
    view.unmount()
  })

  run('a busy box refuses a second click while the first is in flight', () => {
    const editor = fakeEditor()
    const toggled: string[] = []
    const view = mount(
      <HunkGutter
        editor={editor.host}
        boxes={boxesFor([4], false, { index: 0, checked: true })}
        onToggle={(key) => toggled.push(key)}
      />,
    )
    const box = editor.margin.querySelector('[role="checkbox"]') as HTMLElement
    assert.equal(box.getAttribute('aria-checked'), 'true', 'the pending click is already drawn')
    assert.equal(box.getAttribute('aria-disabled'), 'true')
    act(() => {
      box.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })
    assert.deepEqual(toggled, [], 'a write is already in flight for this hunk')
    view.unmount()
  })

  run('a state change is a React update, not a widget churn', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4, 19])} onToggle={() => {}} />)
    const created = editor.adds
    // Same lines, different state — the optimistic tick a click leaves behind,
    // which is the state change that happens BEFORE git has answered. Monaco
    // must not be touched, or the box would flicker on every click.
    view.render(
      <HunkGutter
        editor={editor.host}
        boxes={boxesFor([4, 19], false, { index: 0, checked: true })}
        onToggle={() => {}}
      />,
    )
    assert.equal(editor.adds, created, 'the widgets are the same widgets')
    assert.equal(
      (editor.margin.querySelector('[role="checkbox"]') as HTMLElement).getAttribute('aria-checked'),
      'true',
      'and the portal repainted them',
    )
    view.unmount()
  })

  run('a hunk that MOVED is redrawn where it moved to', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4, 19])} onToggle={() => {}} />)
    // Staging the first hunk shortens the file above the second one. Nothing
    // here caches an offset: new lines, new widgets.
    view.render(<HunkGutter editor={editor.host} boxes={boxesFor([4, 16])} onToggle={() => {}} />)
    assert.equal(editor.lineOf('multicode.hunk-include.unstaged.1'), 16)
    assert.equal(editor.widgets.size, 2, 'and the old widget did not stay behind')
    view.unmount()
  })

  run('unmounting takes every widget with it', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4, 19, 30])} onToggle={() => {}} />)
    assert.equal(editor.widgets.size, 3)
    view.unmount()
    assert.equal(editor.widgets.size, 0, 'a leftover widget is the next file\'s boxes')
    assert.equal(editor.margin.children.length, 0)
  })

  run('losing the editor clears the boxes rather than drawing them nowhere', () => {
    const editor = fakeEditor()
    const view = mount(<HunkGutter editor={editor.host} boxes={boxesFor([4])} onToggle={() => {}} />)
    view.render(<HunkGutter editor={null} boxes={boxesFor([4])} onToggle={() => {}} />)
    assert.equal(editor.widgets.size, 0)
    view.unmount()
  })

  run('an editor disposed under the cleanup does not take the unmount down', () => {
    const editor = fakeEditor()
    let removals = 0
    const disposed = {
      addGlyphMarginWidget: editor.host.addGlyphMarginWidget,
      removeGlyphMarginWidget: () => {
        removals += 1
        throw new Error('Editor is disposed')
      },
    }
    const view = mount(<HunkGutter editor={disposed} boxes={boxesFor([4, 19])} onToggle={() => {}} />)
    assert.equal(editor.margin.querySelectorAll('[role="checkbox"]').length, 2)
    view.unmount()
    // Both widgets were asked to go, not just the one before the throw: a
    // cleanup that stopped at the first refusal would leave the rest behind.
    assert.equal(removals, 2)
    assert.equal(view.container.isConnected, false, 'and the React tree came down')
  })

  if (failures > 0) {
    console.error(`${failures} failing`)
    process.exit(1)
  }
  console.log('HunkGutter.test.tsx: ok')
}
