import assert from 'node:assert/strict'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: the model picker IS the spawner (MC-2122) ──────────────────────────
//
// The spawn surface used to be identity-first — Terminal / General /
// Conversation / one row per specialist — with the model you were actually
// launching hidden a hop deeper, inside each row's engine flyout. That is
// inverted: clicking a MODEL row spawns that model, specialty is a footer
// modifier, and a star taken while a role is set saves the pair.
//
// None of that is reachable from a pure test: the picker composes the real
// store's per-role engine defaults, the favourites store, and the confirm the
// host spawns from. So this suite mounts the real `SpawnPicker` over the real
// store and drives it the way a person does, reading back what the host would
// have been asked to launch.
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

const ROLE_REGISTRY = {
  roles: {
    architect: { id: 'architect', label: 'Architect', description: 'Plans the work.', source: { layer: 'user' } },
    reviewer: { id: 'reviewer', label: 'Reviewer', description: 'Reviews the work.', source: { layer: 'user' } },
  },
}

const CONVERSATION_ROWS = [
  { providerId: 'anthropic', providerLabel: 'Claude', modelId: 'claude-sonnet-5', modelLabel: 'Sonnet 5' },
]

async function main(): Promise<void> {
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  ;(dom.window as unknown as Record<string, unknown>).api = withInertPreloadFallback({
    platform: 'darwin',
    // The footer's "Start in worktree" is offered only inside a repo; this seam
    // has no workspace folder, so it answers null.
    getGitRepoRoot: async () => null,
    // The terminal row is named by the shell the launcher would actually run.
    terminalDefaultShellName: async () => 'zsh',
  })

  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: SpawnPicker } = await import('../renderer/src/components/workspace/agentComposer/SpawnPicker')
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { __resetModelFavouritesForTest } = await import('../renderer/src/components/ui/modelFavourites')

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

  type Confirm = Record<string, unknown>

  type Mounted = {
    rails: () => HTMLElement[]
    rail: (label: string) => HTMLElement
    rows: () => HTMLElement[]
    row: (text: string) => HTMLElement
    star: (rowText: string) => HTMLElement
    footerButton: (label: string) => HTMLElement | null
    menuItem: (text: string) => HTMLElement
    click: (element: Element | null) => Promise<void>
    spawns: () => Confirm[]
    closes: () => number
    unmount: () => void
  }

  // `keepEngineDefaults` reopens against the store the previous spawn wrote —
  // the remembered-default check. Every other mount starts from a clean one.
  async function mountPicker(keepEngineDefaults = false): Promise<Mounted> {
    __resetModelFavouritesForTest()
    dom.window.localStorage.clear()
    const settings = useWorkspaceStore.getState().appSettings
    useWorkspaceStore.setState({
      pluginCatalogStatus: 'ready',
      pluginCatalogEntries: CATALOG_ENTRIES,
      cliAvailabilityStatus: 'ready',
      cliAvailability: null,
      sprintEngineRoleRegistry: ROLE_REGISTRY,
      appSettings: keepEngineDefaults
        ? { ...settings, specialistOrder: [] }
        : { ...settings, specialistCliDefaults: {}, specialistModelDefaults: {}, specialistOrder: [] },
    } as never)

    const spawns: Confirm[] = []
    let closes = 0
    const container = dom.window.document.createElement('div')
    dom.window.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(
        <SpawnPicker
          conversationRows={CONVERSATION_ROWS}
          onSpawn={(confirm) => spawns.push(confirm as unknown as Confirm)}
          permissionPreset="manual"
          debugMode={false}
          onChangeDebugMode={() => {}}
          onClose={() => {
            closes += 1
          }}
        />,
      )
    })
    // Let the shell-name probe settle: the terminal row is named by it.
    await act(async () => {
      await Promise.resolve()
    })

    const click = async (element: Element | null): Promise<void> => {
      assert.ok(element, 'element to click exists')
      await act(async () => {
        element!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
      })
    }
    // Scoped to the PROVIDER radiogroup rather than sweeping every
    // `[role="radio"]` in the surface: the rail is one radiogroup among
    // several a picker can carry, and a bare sweep collects whatever else
    // arrives on the trailing row.
    const rails = (): HTMLElement[] => [
      ...(container.querySelector('[role="radiogroup"][aria-label="Provider"]')?.querySelectorAll<HTMLElement>(
        '[role="radio"]',
      ) ?? []),
    ]
    const rows = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[data-model-row="true"]')]
    return {
      rails,
      rail: (label) => {
        const found = rails().find((entry) => entry.getAttribute('aria-label') === label)
        assert.ok(found, `the rail carries "${label}"`)
        return found!
      },
      rows,
      row: (text) => {
        const found = rows().find((entry) => (entry.textContent ?? '').includes(text))
        assert.ok(found, `a row reading "${text}" is in the list`)
        return found!
      },
      star: (rowText) => {
        const found = rows().find((entry) => (entry.textContent ?? '').includes(rowText))
        const star = found?.querySelector<HTMLElement>('[data-model-star="true"]')
        assert.ok(star, `the "${rowText}" row carries a star`)
        return star!
      },
      footerButton: (label) =>
        [...container.querySelectorAll<HTMLElement>('button')].find((button) => {
          const name = button.getAttribute('aria-label') ?? ''
          // The permissions chip names its own value ("Permissions: Bypass
          // permissions") now that the preset is stored against the model row,
          // so it is matched by prefix; every other footer control has a fixed
          // name.
          return name === label || (label.endsWith(':') && name.startsWith(label))
        }) ?? null,
      menuItem: (text) => {
        // Menus are portaled out of the picker's own container.
        const found = [...dom.window.document.querySelectorAll<HTMLElement>('[data-menu-item="true"]')].find(
          (item) => (item.textContent ?? '').trim() === text,
        )
        assert.ok(found, `the open menu offers "${text}"`)
        return found!
      },
      click,
      spawns: () => spawns,
      closes: () => closes,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await check('SEAM: clicking a model row spawns that model, in one action', async () => {
    const view = await mountPicker()
    assert.equal(
      view.rows().some((row) => /Architect|Reviewer|Terminal/.test(row.textContent ?? '')),
      false,
      'no roster of identities stands in front of the models',
    )
    await view.click(view.row('Fable 5'))
    assert.deepEqual(
      view.spawns(),
      [{ kind: 'general', cli: 'claude-code', model: 'claude-fable-5' }],
      'the click spawned the model that was clicked — no second hop, no role',
    )
    assert.equal(view.closes(), 1, 'and the picker closed behind it')
    view.unmount()
  })

  await check('SEAM: the remembered spawn default is the model last spawned', async () => {
    const view = await mountPicker()
    await view.click(view.row('Opus 5'))
    view.unmount()

    // A second open, against the store the first spawn wrote.
    const reopened = await mountPicker(true)
    const current = reopened.rows().find((row) => row.getAttribute('aria-selected') === 'true')
    assert.match(
      current?.textContent ?? '',
      /Opus 5/,
      'reopening lands on the model that was spawned, not on a roster row',
    )
    reopened.unmount()
  })

  await check('SEAM: Terminal and Chats are rail entries, and the footer leaves with them', async () => {
    const view = await mountPicker()
    const labels = view.rails().map((entry) => entry.getAttribute('aria-label'))
    assert.deepEqual(
      labels.slice(-2),
      ['Terminal', 'Chats'],
      'both sit after the providers, at the end of the rail',
    )
    assert.ok(view.footerButton('Permissions:'), 'the model filters carry the trailing row')

    await view.click(view.rail('Terminal'))
    assert.equal(
      view.rows().length === 1 && (view.rows()[0]?.textContent ?? '').includes('zsh'),
      true,
      'the terminal filter shows one row, named for the login shell — never "Plain terminal"',
    )
    assert.equal(
      view.footerButton('Permissions:'),
      null,
      'nothing the trailing row configures applies to a shell, so no row is shown',
    )
    assert.equal(view.footerButton('Role for the next spawn'), null, 'including the Role control')
    await view.click(view.row('zsh'))
    assert.deepEqual(view.spawns(), [{ kind: 'terminal' }], 'the shell row spawns a terminal')

    await view.click(view.rail('Chats'))
    assert.equal(view.footerButton('Permissions:'), null, 'nor on the conversation filter')
    await view.click(view.row('Claude'))
    assert.deepEqual(
      view.spawns()[1],
      {
        kind: 'conversation',
        provider: { providerId: 'anthropic', modelId: 'claude-sonnet-5', modelLabel: 'Sonnet 5' },
      },
      'a provider row spawns that provider, not a resolved-elsewhere default',
    )
    view.unmount()
  })

  await check('SEAM: a role in the footer makes the next model row a specialist, then resets', async () => {
    const view = await mountPicker()
    await view.click(view.footerButton('Role for the next spawn'))
    await view.click(view.menuItem('Architect'))
    assert.match(
      view.footerButton('Role for the next spawn')?.textContent ?? '',
      /Architect/,
      'the footer states the role the next spawn carries',
    )

    await view.click(view.row('Opus 5'))
    assert.deepEqual(
      view.spawns(),
      [{ kind: 'specialist', specialistId: 'architect', cli: 'claude-code', model: 'claude-opus-5' }],
      'one click spawned the Architect on the model that was clicked',
    )
    assert.match(
      view.footerButton('Role for the next spawn')?.textContent ?? '',
      /None/,
      'role resets after a specialist spawn — starred compositions are what repetition is for',
    )
    view.unmount()
  })

  await check('SEAM: starring with a role set saves the pair, and the ★ row spawns it', async () => {
    const view = await mountPicker()
    await view.click(view.footerButton('Role for the next spawn'))
    await view.click(view.menuItem('Reviewer'))
    await view.click(view.star('Fable 5'))

    // Back to no role: a starred composition must not need the footer.
    await view.click(view.footerButton('Role for the next spawn'))
    await view.click(view.menuItem('None'))
    await view.click(view.rail('Starred'))

    const starredRow = view.row('Fable 5')
    assert.match(starredRow.textContent ?? '', /Reviewer/, 'the ★ row wears the role it composes')
    await view.click(starredRow)
    assert.deepEqual(
      view.spawns(),
      [{ kind: 'specialist', specialistId: 'reviewer', cli: 'claude-code', model: 'claude-fable-5' }],
      'the composition spawned as its own role, whatever the footer says',
    )
    view.unmount()
  })

  await check('SEAM: a plain star and a composition of the same model coexist', async () => {
    const view = await mountPicker()
    await view.click(view.star('Fable 5'))
    await view.click(view.footerButton('Role for the next spawn'))
    await view.click(view.menuItem('Architect'))
    await view.click(view.star('Fable 5'))
    await view.click(view.rail('Starred'))
    const starred = view.rows().map((row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim())
    assert.equal(starred.length, 2, 'the plain model and the pairing are two entries, not one')
    assert.equal(
      starred.filter((text) => /Architect/.test(text)).length,
      1,
      'exactly one of them carries the role',
    )
    view.unmount()
  })

  if (failures > 0) {
    console.error(`spawnPickerSeam.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('spawnPickerSeam.test.tsx: ok')
}

void main()
