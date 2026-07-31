import assert from 'node:assert/strict'

import { installJsdomEnvironment, withInertPreloadFallback } from './jsdomEnvironment'

// ── Seam: the roleless agent row is named by the engine it launches (MC-2059) ─
//
// The owner picked Fable 5 on the picker's roleless row and the row still read
// "General agent": the icon repainted, the label was a constant. Naming is a
// render of store state, so the only place the bug is visible is a mounted
// surface — the pure naming helper and the source contract cannot show a label
// that fails to follow the store.
//
// This suite mounts the real picker over the real store and reads the row's
// text back: the model that was picked, the CLI when no model is, and — the
// trap the icon already solved — the row holding its own name while another
// row is highlighted.
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
        { id: 'claude-opus-5[1m]', label: 'Opus (latest, 1M context)' },
      ],
      allowCustomId: true,
    },
  },
  { id: 'codex', displayName: 'Codex', source: 'bundled', kind: 'agent', binary: 'codex' },
]

async function main(): Promise<void> {
  const anyGlobal = globalThis as unknown as Record<string, unknown>
  anyGlobal.window = dom.window
  // The picker focuses its search field on the next frame; jsdom carries the
  // timers on `window`, and React calls the effect against the global.
  anyGlobal.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  anyGlobal.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window)
  ;(dom.window as unknown as Record<string, unknown>).api = withInertPreloadFallback({
    // The picker probes the workspace folder for a git repo to decide whether
    // to offer "+ Worktree"; this seam has no workspace, so it answers null.
    getGitRepoRoot: async () => null,
  })

  const React = (await import('react')).default
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { default: AgentComposerPopover } = await import(
    '../renderer/src/components/workspace/agentComposer/AgentComposerPopover'
  )
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { GENERAL_AGENT_ENGINE_KEY } = await import('../renderer/src/specialists/specialistActions')

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

  // The remembered engine for the roleless row, written exactly where the
  // picker writes it: its own reserved key in the per-agent defaults.
  function rememberEngine(cli: string, model: string | null): void {
    const settings = useWorkspaceStore.getState().appSettings
    useWorkspaceStore.setState({
      pluginCatalogStatus: 'ready',
      pluginCatalogEntries: CATALOG_ENTRIES,
      cliAvailabilityStatus: 'ready',
      cliAvailability: null,
      appSettings: {
        ...settings,
        specialistCliDefaults: { [GENERAL_AGENT_ENGINE_KEY]: cli },
        specialistModelDefaults: model ? { [GENERAL_AGENT_ENGINE_KEY]: { cli, model } } : {},
      },
    } as never)
  }

  type Mounted = {
    rolelessLabel: () => string
    hoverTerminalRow: () => Promise<void>
    unmount: () => void
  }

  async function mountPicker(): Promise<Mounted> {
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
          onClose={() => {}}
        />,
      )
    })
    const row = (key: string): HTMLElement => {
      const el = container.querySelector<HTMLElement>(`#agent-composer-pop-option-${key}`)
      assert.ok(el, `the ${key} row is in the roster`)
      return el
    }
    return {
      rolelessLabel: () => (row('general').textContent ?? '').trim(),
      hoverTerminalRow: async () => {
        await act(async () => {
          row('terminal').dispatchEvent(new dom.window.MouseEvent('mouseenter', { bubbles: false }))
        })
      },
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  await check('SEAM: the roleless row reads back the model picked on it', async () => {
    rememberEngine('claude-code', 'claude-fable-5')
    let view = await mountPicker()
    assert.equal(view.rolelessLabel(), 'Fable 5', 'picking Fable 5 names the row Fable 5')
    view.unmount()

    rememberEngine('claude-code', 'claude-opus-5[1m]')
    view = await mountPicker()
    assert.equal(
      view.rolelessLabel(),
      'Opus (latest, 1M context)',
      'a different model renames the row — the label is not a constant',
    )
    view.unmount()
  })

  await check('SEAM: with no model picked, the CLI names the row', async () => {
    rememberEngine('codex', null)
    const view = await mountPicker()
    assert.equal(view.rolelessLabel(), 'Codex', 'a CLI running its own default model names the row')
    view.unmount()
  })

  await check('SEAM: highlighting another row never repaints this one', async () => {
    // The trap the icon already solved and the label had to solve again: the
    // row's name comes from the ROW's engine, not from whatever is highlighted.
    rememberEngine('claude-code', 'claude-fable-5')
    const view = await mountPicker()
    assert.equal(view.rolelessLabel(), 'Fable 5', 'the row opens on its own engine')
    await view.hoverTerminalRow()
    assert.equal(view.rolelessLabel(), 'Fable 5', 'hovering Terminal leaves the roleless row named as it was')
    view.unmount()
  })

  await check('SEAM: "General agent" is nowhere on the picker', async () => {
    rememberEngine('claude-code', 'claude-fable-5')
    const view = await mountPicker()
    const body = dom.window.document.body.textContent ?? ''
    assert.equal(/General agent/.test(body), false, 'the retired name is not rendered anywhere')
    assert.equal(/general-purpose/.test(body), false, 'nor is the agent described as general-purpose')
    view.unmount()
  })

  if (failures > 0) {
    console.error(`rolelessRowLabelSeam.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('rolelessRowLabelSeam.test.tsx: ok')
}

void main()
