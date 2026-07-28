import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

// The inline reasoning-effort picker (MC-1884) lives on the SELECTED model row's
// right edge, and everything that matters about it is behaviour a static markup
// snapshot cannot reach: opening a menu, checking a level, re-picking the checked
// level to clear it. So this suite stands up a real DOM and drives the listbox
// the way a person does, and only falls back to source contracts for the host
// wiring a single mounted listbox cannot observe.

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
// TruncatedText (every row's label) observes its own box to decide whether to
// show a tooltip; jsdom ships no ResizeObserver, so mounting a row throws
// without this. Never firing is correct here — nothing in this suite depends on
// the overflow measurement.
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
;(dom.window as unknown as Record<string, unknown>).ResizeObserver = NoopResizeObserver

let failures = 0
function run(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`)
    })
    .catch((error) => {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    })
}

// Codex's real manifest shape: six levels with `ultra` costliest, and a declared
// default that is deliberately NOT the picker's at-rest state — blank is.
const CODEX_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
]

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { CliModelListbox, meaningfulModelId } = await import('./CliModelListbox')
  const { costliestReasoningLevel } = await import('../workspace/agentComposer/agentSpawnShared')

  type ListboxProps = Parameters<typeof CliModelListbox>[0]

  // Codex (levels, two models) + Kimi (a CLI whose manifest declares no
  // reasoningSelection at all, so it must never show a picker).
  const OPTIONS: ListboxProps['options'] = [
    {
      value: 'codex' as ListboxProps['currentCli'],
      label: 'Codex',
      modelSelection: {
        options: [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
          { id: 'gpt-5.5', label: 'GPT-5.5' },
        ],
      } as ListboxProps['options'][number]['modelSelection'],
      reasoningSelection: { levels: CODEX_LEVELS, default: 'medium' },
    },
    {
      value: 'kimi' as ListboxProps['currentCli'],
      label: 'Kimi Code',
      modelSelection: {
        options: [{ id: 'kimi-k3', label: 'Kimi K3' }],
      } as ListboxProps['options'][number]['modelSelection'],
    },
  ]

  type Mounted = {
    container: HTMLElement
    rows: () => HTMLElement[]
    pickers: () => HTMLButtonElement[]
    menuItems: () => HTMLButtonElement[]
    click: (element: Element | undefined | null) => Promise<void>
    key: (element: Element | undefined | null, key: string) => Promise<void>
    unmount: () => void
  }

  function mount(overrides: Partial<ListboxProps>): Mounted {
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    const props = {
      ariaLabel: 'Agent runtime',
      options: OPTIONS,
      currentCli: 'codex',
      effectiveModelFor: () => 'gpt-5.6-sol',
      effectiveReasoningFor: () => undefined,
      onSelectReasoning: () => {},
      onSelectCli: () => {},
      onSelectModel: () => {},
      ...overrides,
    } as unknown as ListboxProps
    act(() => {
      root.render(React.createElement(CliModelListbox, props))
    })
    const query = <T extends Element>(selector: string): T[] =>
      // The menu is portaled to <body>, so it is never inside `container`.
      [...dom.window.document.body.querySelectorAll(selector)] as unknown as T[]
    return {
      container: container as unknown as HTMLElement,
      rows: () => [...container.querySelectorAll('[data-cli-model-row="true"]')] as unknown as HTMLElement[],
      pickers: () => query<HTMLButtonElement>('[data-reasoning-picker="true"]'),
      menuItems: () => query<HTMLButtonElement>('[data-reasoning-option="true"]'),
      click: async (element) => {
        assert.ok(element, 'expected the control to exist before clicking it')
        await act(async () => {
          element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        })
      },
      key: async (element, key) => {
        assert.ok(element, 'expected the control to exist before pressing a key on it')
        await act(async () => {
          element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true }))
        })
      },
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await run('the picker renders on the selected row only', () => {
    const view = mount({})
    assert.equal(view.pickers().length, 1, 'exactly one picker exists across the whole listbox')
    const rows = view.rows()
    const selected = rows.filter((row) => row.getAttribute('aria-selected') === 'true')
    assert.equal(selected.length, 1, 'one row is selected')
    assert.ok(
      selected[0].querySelector('[data-reasoning-picker="true"]'),
      'the picker sits inside the selected row',
    )
    for (const row of rows) {
      if (row === selected[0]) continue
      assert.equal(
        row.querySelector('[data-reasoning-picker="true"]'),
        null,
        'an unselected row carries no picker — not a greyed one, not an empty one',
      )
    }
    view.unmount()
  })

  await run('the bare-CLI header row carries the picker when it is the selection', () => {
    // No model chosen => the CLI header row is the selection.
    const view = mount({ effectiveModelFor: () => undefined })
    const rows = view.rows()
    const header = rows[0]
    assert.equal(header.getAttribute('aria-selected'), 'true', 'the header row is the selection')
    assert.ok(
      header.querySelector('[data-reasoning-picker="true"]'),
      'the header row shows the picker like any other selected row',
    )
    assert.equal(view.pickers().length, 1, 'still exactly one picker')
    view.unmount()
  })

  await run('a CLI with no reasoningSelection renders no picker anywhere', () => {
    const view = mount({ currentCli: 'kimi', effectiveModelFor: () => 'kimi-k3' })
    assert.equal(view.pickers().length, 0, 'Kimi declares no levels, so no control is offered at all')
    view.unmount()
  })

  await run('a host wiring neither accessor renders no picker, even for a CLI with levels', () => {
    const view = mount({ effectiveReasoningFor: undefined, onSelectReasoning: undefined })
    assert.equal(view.pickers().length, 0, 'effort stays opt-in on BOTH accessors')
    view.unmount()
  })

  await run('blank when no level is stored; the menu opens with every level as menuitemradio', async () => {
    const view = mount({})
    const trigger = view.pickers()[0]
    assert.equal(trigger.getAttribute('aria-label'), 'Reasoning effort', 'blank names only the control')
    assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'the menu starts closed')
    assert.equal(view.menuItems().length, 0, 'no menu rows before it opens')

    await view.click(trigger)
    const items = view.menuItems()
    assert.equal(items.length, CODEX_LEVELS.length, 'every declared level is offered')
    for (const item of items) {
      assert.equal(item.getAttribute('role'), 'menuitemradio', 'menu rows are menuitemradio')
      assert.equal(item.getAttribute('aria-checked'), 'false', 'nothing is checked while the level is blank')
    }
    view.unmount()
  })

  await run('picking a level writes it; re-picking the checked level clears it to blank', async () => {
    const writes: Array<[string, string | null]> = []
    const view = mount({ onSelectReasoning: (cli: string, reasoning: string | null) => writes.push([cli, reasoning]) })
    await view.click(view.pickers()[0])
    await view.click(view.menuItems().find((item) => item.textContent?.includes('High')))
    assert.deepEqual(writes, [['codex', 'high']], 'the picked level is written for the row’s own CLI')
    view.unmount()

    // Now with `high` already stored: the same gesture clears it.
    const cleared: Array<[string, string | null]> = []
    const stored = mount({
      effectiveReasoningFor: () => 'high',
      onSelectReasoning: (cli: string, reasoning: string | null) => cleared.push([cli, reasoning]),
    })
    const trigger = stored.pickers()[0]
    assert.equal(
      trigger.getAttribute('aria-label'),
      'Reasoning effort: High',
      'a stored level rides the accessible name',
    )
    await stored.click(trigger)
    const checked = stored.menuItems().filter((item) => item.getAttribute('aria-checked') === 'true')
    assert.equal(checked.length, 1, 'exactly the stored level is checked')
    assert.match(checked[0].textContent ?? '', /High/, 'and it is the stored one')
    await stored.click(checked[0])
    assert.deepEqual(cleared, [['codex', null]], 're-selecting the checked level clears back to blank')
    stored.unmount()
  })

  await run('the costliest level carries the warn tone inside the menu, before it is chosen', async () => {
    assert.equal(costliestReasoningLevel(CODEX_LEVELS), 'ultra', 'Codex’s costliest level is ultra')
    assert.equal(
      costliestReasoningLevel([{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }]),
      'max',
      'claude-code’s costliest level is max',
    )
    const view = mount({})
    await view.click(view.pickers()[0])
    const items = view.menuItems()
    const ultra = items.find((item) => item.textContent?.includes('Ultra'))
    assert.ok(ultra, 'the costliest level is listed')
    assert.match(ultra.className, /tone-warn/, 'it is toned warn in the menu, visible before choosing')
    const low = items.find((item) => item.textContent?.includes('Low'))
    assert.ok(!low?.className.includes('tone-warn'), 'ordinary levels are untoned')
    view.unmount()
  })

  await run('zero explanatory text: the control names nothing and explains nothing', async () => {
    const view = mount({})
    await view.click(view.pickers()[0])
    // Every visible string the control puts on screen: the trigger's own text
    // plus each menu row's label.
    const visible = [
      view.pickers()[0].textContent ?? '',
      ...view.menuItems().map((item) => item.textContent ?? ''),
    ].join(' ')
    for (const banned of [
      'Reasoning effort',
      'Effort',
      'optional',
      'Optional',
      'default',
      'Default',
      'CLI default',
      'None',
      'none',
    ]) {
      assert.ok(
        !visible.includes(banned),
        `the rendered control must not carry the caption/helper copy "${banned}" — the blank state explains itself`,
      )
    }
    // Only the level names and the blank glyph are ever drawn.
    assert.equal(view.pickers()[0].textContent?.replace(/[▾\s]/g, ''), '—', 'blank draws an em-dash and a caret, nothing more')
    view.unmount()
  })

  await run('the mono id renders only when it adds information the label does not', () => {
    assert.equal(meaningfulModelId('opus[1m]', 'Opus'), 'opus[1m]', 'the 1M variant is not in the name')
    assert.equal(meaningfulModelId('gpt-5.5', 'GPT-5.5'), undefined, 'the name already spells the id')
    assert.equal(meaningfulModelId('gpt-5.6-sol', 'GPT-5.6 Sol'), undefined, 'separators and case do not count')
    assert.equal(
      meaningfulModelId('claude-opus-5[1m]', 'Opus 5 (1M context)'),
      'claude-opus-5[1m]',
      'the exact launch id is kept when the friendly name paraphrases it',
    )
    assert.equal(meaningfulModelId('opus[1m]', undefined), undefined, 'an unlabelled model already renders as its id')

    const view = mount({})
    const text = view.container.textContent ?? ''
    assert.ok(!text.includes('gpt-5.5 '), 'GPT-5.5 does not repeat its own id beside itself')
    view.unmount()
  })

  await run('every row stays exactly one line tall, whatever it carries', () => {
    const view = mount({
      effectiveReasoningFor: () => 'ultra',
      // A stale persisted model adds the "Not listed" note to a row that also
      // carries the picker and the check — the densest row the listbox can make.
      effectiveModelFor: () => 'gpt-5.9-unlisted',
    })
    for (const row of view.rows()) {
      assert.match(row.className, /items-center/, 'cells are centred on one line')
      assert.ok(!row.className.includes('flex-wrap'), 'a row may never wrap onto a second line')
      assert.ok(!row.className.includes('flex-col'), 'a row is never stacked')
      assert.ok(!row.className.includes('h-auto'), 'no row opts out of the single-line height')
      // Only the label flexes; every trailing cell holds its intrinsic width, so
      // adding the id/note/picker cannot push the row into a second line.
      for (const cell of [...row.children].slice(1)) {
        const className = (cell as HTMLElement).className ?? ''
        assert.ok(
          typeof className !== 'string' || className.includes('shrink-0') || className.includes('flex-1'),
          `trailing cell "${className}" must be shrink-0 so it cannot force a wrap`,
        )
      }
    }
    assert.equal(view.pickers().length, 1, 'the stale-model row still gets exactly one picker')
    view.unmount()
  })

  await run('the menu escapes the listbox scroll clamp and flips near the bottom edge', async () => {
    const view = mount({})
    assert.match(
      (view.container.firstElementChild as HTMLElement).className,
      /max-h-\[280px\]/,
      'the listbox keeps its scroll clamp',
    )
    await view.click(view.pickers()[0])
    const menu = dom.window.document.body.querySelector('[role="menu"]') as HTMLElement | null
    assert.ok(menu, 'the menu renders')
    assert.ok(
      !view.container.contains(menu),
      'the menu is portaled to <body>, so the clamped, overflow-y-auto listbox can never clip or scroll it',
    )
    assert.equal(menu.style.position, 'fixed', 'it is positioned against the viewport, not the scroll container')
    view.unmount()
  })

  await run('a row near the bottom edge opens its menu upward', async () => {
    // Two mounts, identical but for where the trigger sits in the viewport.
    // Anything else staying equal is what makes the flip attributable.
    const openAt = async (top: number): Promise<CSSStyleDeclaration> => {
      const view = mount({})
      const trigger = view.pickers()[0]
      trigger.getBoundingClientRect = () =>
        ({ top, bottom: top + 18, left: 100, right: 220, width: 120, height: 18, x: 100, y: top }) as DOMRect
      await view.click(trigger)
      const menu = dom.window.document.body.querySelector('[role="menu"]') as HTMLElement
      const style = menu.style
      view.unmount()
      return style as unknown as CSSStyleDeclaration
    }

    const roomy = await openAt(40)
    assert.ok(roomy.top && !roomy.bottom, 'with room below, the menu hangs off the trigger’s bottom edge')

    // jsdom's viewport is 768 tall, so a trigger at 758 has no room beneath it.
    const cramped = await openAt(dom.window.innerHeight - 10)
    assert.ok(
      cramped.bottom && !cramped.top,
      'against the bottom edge it anchors by its own bottom instead — it opens upward rather than off-screen or into a scroll',
    )
  })

  await run('rows and the picker are keyboard operable', async () => {
    const picked: Array<string | null> = []
    const view = mount({ onSelectModel: (_cli: string, model: string | null) => picked.push(model) })
    const rows = view.rows()
    const selected = rows.find((row) => row.getAttribute('aria-selected') === 'true')
    assert.ok(selected, 'a row is selected')
    assert.equal(selected.getAttribute('tabindex'), '0', 'the checked row is the listbox tab stop')
    assert.ok(
      rows.filter((row) => row.getAttribute('tabindex') === '0').length === 1,
      'roving tabindex: exactly one tab stop',
    )

    // Enter selects the focused row.
    await view.key(rows[0], 'Enter')
    assert.equal(picked.length, 1, 'Enter on a row selects it')

    // Arrows rove between rows.
    rows[0].focus()
    await view.key(rows[0], 'ArrowDown')
    assert.equal(dom.window.document.activeElement, rows[1], 'ArrowDown moves to the next row')
    await view.key(rows[1], 'ArrowUp')
    assert.equal(dom.window.document.activeElement, rows[0], 'ArrowUp moves back')

    // ArrowRight reaches the picker on the selected row, and it opens.
    selected.focus()
    await view.key(selected, 'ArrowRight')
    assert.equal(dom.window.document.activeElement, view.pickers()[0], 'ArrowRight focuses the row’s picker')
    await view.click(view.pickers()[0])
    assert.equal(view.pickers()[0].getAttribute('aria-expanded'), 'true', 'the picker opens')
    assert.equal(
      dom.window.document.activeElement,
      view.menuItems()[0],
      'opening lands focus in the menu so it is immediately operable',
    )
    view.unmount()
  })

  // The picker's menu is portaled to <body>, which puts it OUTSIDE the surface
  // of any popover hosting the listbox. Popover dismisses on a mousedown its
  // surface does not contain, so without a guard the parent would close on the
  // way down and the click would never reach the level — the pick silently
  // lost. CliModelPickerButton is that exact composition, so it is tested
  // through the real wrapper rather than a mock of it.
  await run('picking a level inside a hosting popover does not dismiss the popover', async () => {
    const { CliModelPickerButton } = await import('./CliModelListbox')
    const written: Array<string | null> = []
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        React.createElement(CliModelPickerButton, {
          ariaLabel: 'Agent runtime',
          options: OPTIONS,
          cli: 'codex',
          effectiveModelFor: () => 'gpt-5.6-sol',
          effectiveReasoningFor: () => undefined,
          onSelectReasoning: (_cli: string, reasoning: string | null) => written.push(reasoning),
          onSelectCli: () => {},
          onSelectModel: () => {},
        } as never),
      )
    })
    const press = async (element: Element) => {
      // mousedown and click in SEPARATE act() flushes, because that is how a
      // browser delivers them: both are discrete events, so React commits the
      // dismissal from mousedown before the click is dispatched. Batching the
      // pair into one act() hides exactly the bug this test exists to catch.
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
      })
      await act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    }

    await press(container.querySelector('button') as Element)
    const listbox = dom.window.document.body.querySelector('[role="listbox"]')
    assert.ok(listbox, 'the runtime popover is open')

    const trigger = dom.window.document.body.querySelector('[data-reasoning-picker="true"]') as HTMLElement
    assert.ok(trigger, 'the selected row carries the picker')
    await press(trigger)
    assert.ok(
      dom.window.document.body.querySelector('[role="listbox"]'),
      'opening the effort menu must not dismiss the runtime popover underneath it',
    )

    const high = [...dom.window.document.body.querySelectorAll('[data-reasoning-option="true"]')].find((item) =>
      item.textContent?.includes('High'),
    )
    await press(high as Element)
    assert.deepEqual(written, ['high'], 'the level is actually written — the pick is not swallowed by dismissal')

    act(() => root.unmount())
    container.remove()
  })

  await run('no hard-coded color is introduced — every color is a theme token', () => {
    for (const path of [
      'src/renderer/src/components/ui/CliModelListbox.tsx',
      'src/renderer/src/components/workspace/agentComposer/agentSpawnShared.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      const literals = source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []
      assert.deepEqual(literals, [], `${path} must state colors as var(--…) tokens, never literals`)
    }
  })

  // Host wiring: a single mounted listbox cannot observe that each spawn surface
  // passes BOTH accessors, so the call sites are asserted at the source.
  await run('the composer surfaces wire both effort accessors to the store seam', () => {
    const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')
    const panel = read('src/renderer/src/components/workspace/agentComposer/AgentComposer.tsx')
    const popover = read('src/renderer/src/components/workspace/agentComposer/AgentComposerPopover.tsx')
    const hook = read('src/renderer/src/components/workspace/agentComposer/useAgentComposer.ts')
    for (const [name, source] of [['panel', panel], ['popover', popover]] as const) {
      assert.match(source, /effectiveReasoningFor=\{/, `the ${name} passes effectiveReasoningFor`)
      assert.match(source, /onSelectReasoning=\{/, `the ${name} passes onSelectReasoning`)
    }
    assert.match(
      hook,
      /resolveCliReasoning\(cli, specialistModelDefaults\[/,
      'reads go through the per-CLI guard, so a Codex level never surfaces on Claude',
    )
    assert.match(
      hook,
      /setSpecialistReasoningDefault\(key, cli, reasoning\)/,
      'writes go through MC-1870’s existing setter — this task adds no state of its own',
    )
  })

  await run('the superseded segmented control is gone, not left dead beside the picker', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/CliModelListbox.tsx'), 'utf8')
    assert.ok(!source.includes('ReasoningSegment'), 'the SegmentedControl shape is removed')
    assert.ok(!source.includes('SegmentedControl'), 'and its import with it')
  })

  if (failures > 0) {
    console.error(`CliModelListbox.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('CliModelListbox.test.tsx: ok')
}

void main()
