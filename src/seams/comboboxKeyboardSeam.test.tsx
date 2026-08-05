import assert from 'node:assert/strict'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: one combobox keyboard model, on a picker that is not the primitive ──
//
// MC-2134 ruled the model every filter-over-a-list picker follows: the search
// field IS the combobox and keeps focus, the highlighted row is named by
// `aria-activedescendant` and never focused, keys the caret has a claim on reach
// the list only when the caret cannot use them, and a row that carries its own
// control offers a keyboard path into it. The ruling is written up in
// `design-system/components/combobox/component.md`.
//
// `CliModelPicker` is driven against that contract in its own suite. This seam
// covers the half no unit test reaches: `AgentComposerPopover`, whose rows carry
// a per-row engine chip inside a floating flyout, mounted over the real
// workspace store. The chip is a `tabIndex={-1}` span nested inside the option,
// so before the ruling it had no keyboard path at all — a pointer was the only
// way to change a row's runtime.
//
// Labelled SEAM: per the run-A convention.

const dom = installJsdomEnvironment()

const CATALOG_ENTRIES = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    source: 'bundled',
    kind: 'agent',
    binary: 'claude',
    modelSelection: {
      options: [
        { id: 'claude-fable-5', label: 'Fable 5' },
        { id: 'claude-opus-5', label: 'Opus 5' },
      ],
      allowCustomId: true,
    },
  },
  { id: 'codex', displayName: 'Codex', source: 'bundled', kind: 'agent', binary: 'codex' },
]

async function main(): Promise<void> {
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  ;(dom.window as unknown as Record<string, unknown>).api = withInertPreloadFallback({
    getGitRepoRoot: async () => null,
  })

  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: AgentComposerPopover } = await import(
    '../renderer/src/components/workspace/agentComposer/AgentComposerPopover'
  )
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  type Mounted = {
    search: () => HTMLInputElement
    options: () => HTMLElement[]
    activeOption: () => HTMLElement | null
    flyout: () => HTMLElement | null
    /** How many times the picker asked its host to close. */
    closes: () => number
    key: (element: Element | null, key: string) => Promise<void>
    type: (value: string) => Promise<void>
    unmount: () => void
  }

  async function mountPicker(): Promise<Mounted> {
    const settings = useWorkspaceStore.getState().appSettings
    useWorkspaceStore.setState({
      pluginCatalogStatus: 'ready',
      pluginCatalogEntries: CATALOG_ENTRIES,
      cliAvailabilityStatus: 'ready',
      cliAvailability: null,
      appSettings: settings,
    } as never)

    let closes = 0
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <AgentComposerPopover
          conversationAvailable={false}
          initialSelection={{ kind: 'general' }}
          action={{
            kind: 'spawn',
            onSpawn: () => {},
            permissionPreset: 'default',
            onChangePermissionPreset: () => {},
            debugMode: false,
            onChangeDebugMode: () => {},
          }}
          onClose={() => {
            closes += 1
          }}
        />,
      )
    })
    const search = (): HTMLInputElement => {
      const input = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')
      assert.ok(input, 'the roster has its search field')
      return input!
    }
    return {
      search,
      options: () => [...container.querySelectorAll<HTMLElement>('#agent-composer-pop-roster [role="option"]')],
      activeOption: () => {
        const id = search().getAttribute('aria-activedescendant')
        // Attribute form, not `#id`: a row's id carries its key verbatim.
        return id ? container.querySelector<HTMLElement>(`[id="${id}"]`) : null
      },
      flyout: () => dom.window.document.querySelector<HTMLElement>('[data-chip-popover="true"]'),
      closes: () => closes,
      key: async (element, key) => {
        assert.ok(element, 'element to key exists')
        await act(async () => {
          element!.dispatchEvent(
            new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
          )
        })
      },
      type: async (value) => {
        const input = search()
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            'value',
          )?.set
          setter?.call(input, value)
          input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        })
      },
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await check('SEAM: the field is the combobox and the arrows never take focus off it', async () => {
    const view = await mountPicker()
    const search = view.search()
    assert.equal(search.getAttribute('role'), 'combobox', 'the field carries the role, not the roster')
    assert.equal(search.getAttribute('aria-controls'), 'agent-composer-pop-roster', 'and names the list it filters')
    const opened = view.activeOption()
    assert.ok(opened, 'a row is highlighted on open')
    // The roster opens on the remembered row, which is its last one here, so the
    // walk goes up first and comes back down.
    await view.key(search, 'ArrowUp')
    assert.notEqual(view.activeOption(), opened, 'ArrowUp moved the highlight')
    assert.equal(dom.window.document.activeElement, search, 'and focus stayed in the field')
    await view.key(search, 'ArrowDown')
    assert.equal(view.activeOption(), opened, 'ArrowDown brought it back')
    view.unmount()
  })

  await check('SEAM: Home and End jump the roster only while the caret has no claim on them', async () => {
    const view = await mountPicker()
    const search = view.search()
    await view.key(search, 'End')
    assert.equal(view.activeOption(), view.options().at(-1), 'with nothing typed, End takes the last row')
    await view.key(search, 'Home')
    assert.equal(view.activeOption(), view.options()[0], 'and Home the first')

    await view.type('term')
    const highlighted = view.activeOption()
    await view.key(search, 'End')
    assert.equal(
      view.activeOption(),
      highlighted,
      'with text in the field they belong to the caret — this is a field you type into',
    )
    view.unmount()
  })

  await check('SEAM: ArrowRight opens the highlighted row’s runtime, and Escape peels just that', async () => {
    const view = await mountPicker()
    const search = view.search()
    assert.equal(view.flyout(), null, 'no runtime flyout is open to begin with')

    await view.key(search, 'ArrowRight')
    const flyout = view.flyout()
    assert.ok(flyout, 'the highlighted row’s engine flyout opened — the chip is otherwise pointer-only')
    assert.match(
      flyout!.getAttribute('aria-label') ?? '',
      /^Agent runtime for /,
      'and it is the flyout for a row, not the picker at large',
    )

    await view.key(flyout!.querySelector('input'), 'Escape')
    assert.equal(view.flyout(), null, 'Escape closed the flyout')
    assert.equal(
      dom.window.document.activeElement,
      view.search(),
      'and handed focus back to the field',
    )
    assert.equal(view.closes(), 0, 'rather than tearing the whole picker down with it')
    view.unmount()
  })

  if (failures > 0) {
    console.error(`comboboxKeyboardSeam.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('comboboxKeyboardSeam.test.tsx: ok')
}

void main()
