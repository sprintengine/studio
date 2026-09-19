import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { test } from 'vitest'

test('DescribedCheckRow', async () => {
  // DescribedCheckRow — the `--described` variant of the check row
  // (design-system/components/check-row).
  //
  // The assertions are aimed at what separates this row from its sibling, since
  // everything else about it is CheckRow's and tested there:
  //
  //   1. it takes the STANDALONE box spelling — a real <input>, the row as its
  //      <label> — which is what makes Space toggle and what makes eight rows in
  //      a dialog eight ordinary tab stops;
  //   2. so it carries NO `aria-checked` and no `role`: the input is the state,
  //      and announcing it twice is the defect the composite row's `aria-hidden`
  //      box exists to avoid, run in the other direction;
  //   3. the supporting line is wired to the input with `aria-describedby`, so a
  //      screen-reader user is told what granting the row does, not only its name;
  //   4. the whole row is the label — one click target, one accessible name;
  //   5. the list is a plain <ul>, never a listbox: nothing roves here.

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

  async function main(): Promise<void> {
    const React = await import('react')
    const { act } = React
    const { createRoot } = await import('react-dom/client')
    const { DescribedCheckRow, DescribedCheckRowList } = await import('./CheckRow')

    const document = dom.window.document

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

    function scopeRow(overrides: Partial<Parameters<typeof DescribedCheckRow>[0]> = {}): React.ReactElement {
      return (
        <DescribedCheckRowList ariaLabel="Permissions">
          <DescribedCheckRow
            id="scope-terminal-control"
            title="Drive chats & terminals"
            code="terminal:control"
            description="Type into conversations and shells."
            checked={false}
            onChange={() => {}}
            {...overrides}
          />
        </DescribedCheckRowList>
      )
    }

    run('the box is a REAL input, and the row is the label that names it', () => {
      const view = mount(scopeRow())
      const input = view.container.querySelector('input')
      assert.ok(input, 'the standalone spelling puts the kit checkbox in whole — input and all')
      assert.equal(input.getAttribute('type'), 'checkbox')
      assert.equal(
        input.getAttribute('id'),
        'scope-terminal-control',
        'the caller-supplied id is what the label and the description hang off',
      )
      const label = view.container.querySelector('label')
      assert.ok(label, 'the row is a <label>')
      assert.equal(label.getAttribute('for'), 'scope-terminal-control', 'the WHOLE row is the label')
      assert.ok(label.contains(input), 'and the input is inside it, so a click anywhere on the row toggles')
      view.unmount()
    })

    run('the input is the state: no aria-checked and no role anywhere on the row', () => {
      const view = mount(scopeRow({ checked: true }))
      const label = view.container.querySelector('label')
      assert.ok(label)
      assert.equal(label.hasAttribute('aria-checked'), false, 'the input announces it; the row must not repeat it')
      assert.equal(label.hasAttribute('role'), false, 'this is not an option and not a treeitem')
      const input = view.container.querySelector('input')
      assert.ok(input)
      assert.equal(input.checked, true)
      assert.equal(
        input.hasAttribute('aria-hidden'),
        false,
        'the composite row hides its DRAWN box; here the input is real and must be reachable',
      )
      view.unmount()
    })

    run('the supporting line is announced with the row, not left beside it', () => {
      const view = mount(scopeRow())
      const input = view.container.querySelector('input')
      assert.ok(input)
      const describedBy = input.getAttribute('aria-describedby')
      assert.ok(describedBy, 'a scope named but not explained is a scope granted blind')
      const description = view.container.querySelector(`#${describedBy}`)
      assert.ok(description)
      assert.equal(description.textContent, 'Type into conversations and shells.')
      view.unmount()
    })

    run('the mono scope name is a quieter step, never the title', () => {
      const view = mount(scopeRow())
      const label = view.container.querySelector('label')
      assert.ok(label)
      const mono = [...label.querySelectorAll('span')].find((span) =>
        (span.getAttribute('class') ?? '').includes('font-mono'),
      )
      assert.ok(mono, 'the code is set in mono — this is an identifier, not a word')
      assert.equal(mono.textContent, 'terminal:control')
      const classes = mono.getAttribute('class') ?? ''
      assert.match(classes, /text-micro/, 'a step smaller than the title')
      assert.match(classes, /text-\[color:var\(--text-subtle\)\]/, 'and a step quieter')

      const without = mount(scopeRow({ code: undefined }))
      assert.equal(
        [...without.container.querySelectorAll('span')].filter((span) =>
          (span.getAttribute('class') ?? '').includes('font-mono'),
        ).length,
        0,
        'a described row whose subject has no identifier simply has no mono name',
      )
      view.unmount()
      without.unmount()
    })

    run('clicking the row toggles, and a disabled row refuses', () => {
      const seen: boolean[] = []
      const view = mount(scopeRow({ checked: false, onChange: (next) => seen.push(next) }))
      const input = view.container.querySelector('input') as HTMLInputElement
      act(() => {
        input.click()
      })
      assert.deepEqual(seen, [true])

      const off = mount(scopeRow({ disabled: true, onChange: () => seen.push(false) }))
      const disabledInput = off.container.querySelector('input') as HTMLInputElement
      assert.equal(disabledInput.disabled, true)
      act(() => {
        disabledInput.click()
      })
      assert.deepEqual(seen, [true], 'a disabled row sends nothing')
      view.unmount()
      off.unmount()
    })

    run("the focus ring is the ROW's, drawn inward on the input's focus", () => {
      const view = mount(scopeRow())
      const classes = view.container.querySelector('label')?.getAttribute('class') ?? ''
      assert.match(
        classes,
        /has-\[input:focus-visible\]:focus-ring-inset/,
        'the label is the hit target, so ringing the 16px box would mark the smallest part of it',
      )
      assert.ok(!/focus:outline-none/.test(classes), 'never removed, only replaced')
      view.unmount()
    })

    run('the list surface is a plain <ul> with the hairline between rows', () => {
      const view = mount(
        <DescribedCheckRowList ariaLabel="Permissions">
          <DescribedCheckRow
            id="a"
            title="View workspaces"
            code="workspace:read"
            description="Chats and files."
            checked
            onChange={() => {}}
          />
          <DescribedCheckRow
            id="b"
            title="Operate workspaces"
            code="workspace:operate"
            description="Launch agents."
            checked={false}
            onChange={() => {}}
          />
        </DescribedCheckRowList>,
      )
      const list = view.container.firstElementChild as HTMLElement
      assert.equal(list.tagName, 'UL')
      assert.equal(
        list.hasAttribute('role'),
        false,
        'never a listbox: every row here is its own tab stop, so nothing roves',
      )
      assert.equal(list.getAttribute('aria-label'), 'Permissions')
      assert.equal(list.querySelectorAll(':scope > li').length, 2, 'the row brings its own <li>')
      const classes = list.getAttribute('class') ?? ''
      assert.match(classes, /\[&>li\+li\]:border-t/, 'the rule goes BETWEEN rows, never around them')
      assert.match(classes, /overflow-hidden/, "the surface radius clips the first and last row's fill")
      view.unmount()
    })

    if (failures > 0) {
      console.error(`\nDescribedCheckRow.test.tsx: ${failures} failing`)
      process.exit(1)
    }
    console.log('DescribedCheckRow: all checks passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

  await suiteRun
})
