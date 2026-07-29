import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'

// The pane's binding to the focused agent, and its freshness contract.
//
// Both are timing behaviours: switching tabs must drop the previous agent's list
// before the new answer lands, and an invalidation must reach the query without
// ever pushing a list into it. The sibling suites here are static
// `renderToStaticMarkup` passes, which run no effects at all and so can assert
// neither. This one stands up a real DOM and drives the switches.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

type Invalidation = { workspaceRoot: string; pluginIds: string[] }

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { useAgentCapabilities } = await import('./useAgentCapabilities')
  type CapabilitySnapshot = import('./skillsPaneModel').CapabilitySnapshot

  // Every call the hook makes, recorded, so the assertions are about what the
  // hook ASKED rather than what it happened to render.
  const asked: { workspaceRoot: string; pluginId: string }[] = []
  const watchStarts: string[] = []
  const watchStops: string[] = []
  let listeners: ((event: Invalidation) => void)[] = []

  anyGlobal.window = dom.window
  ;(dom.window as unknown as { api: unknown }).api = {
    agentCapabilities: (input: { workspaceRoot: string; pluginId: string }) => {
      asked.push(input)
      return Promise.resolve({
        ok: true,
        support: 'native',
        harnessId: input.pluginId,
        // The id names the agent it came from, so a list left over from the
        // previous tab is visible in the assertion rather than plausible.
        skills: [{ id: `skill-for-${input.pluginId}`, name: 'x', description: '', invocation: '', source: 'builtin', pluginIds: [input.pluginId] }],
        servers: [],
        diagnostics: [],
      })
    },
    agentCapabilitiesWatchStart: (input: { workspaceRoot: string }) => {
      watchStarts.push(input.workspaceRoot)
      return Promise.resolve()
    },
    agentCapabilitiesWatchStop: (input: { workspaceRoot: string }) => {
      watchStops.push(input.workspaceRoot)
      return Promise.resolve()
    },
    onAgentCapabilitiesInvalidated: (cb: (event: Invalidation) => void) => {
      listeners.push(cb)
      return () => {
        listeners = listeners.filter((entry) => entry !== cb)
      }
    },
  }

  let latest: ReturnType<typeof useAgentCapabilities> | null = null
  // Every value the pane was handed, in order. Asserting the SEQUENCE is the
  // only way to catch a stale list surviving a tab switch: read the hook after
  // the switch has settled and the intermediate frame the user would have seen
  // is gone.
  //
  // Recorded in an effect, so an entry means a frame that COMMITTED. A
  // render-phase push would also record the passes React discards and re-runs,
  // which never reach the screen — and would fail a hook that is correct.
  const seen: (string | null)[] = []

  function Probe({ pluginId }: { pluginId: string | null }) {
    const state = useAgentCapabilities('/repo', pluginId)
    latest = state
    const shown = state.snapshot?.skills[0]?.id ?? null
    React.useEffect(() => {
      seen.push(shown)
    })
    return null
  }

  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)

  const render = async (pluginId: string | null): Promise<void> => {
    await act(async () => {
      root.render(React.createElement(Probe, { pluginId }))
    })
  }
  const snapshotNow = (): CapabilitySnapshot | null => latest?.snapshot ?? null

  // --- the first agent resolves once -----------------------------------------
  await render('claude-code')
  assert.deepEqual(asked, [{ workspaceRoot: '/repo', pluginId: 'claude-code' }])
  assert.equal(snapshotNow()?.skills[0]?.id, 'skill-for-claude-code')
  assert.deepEqual(watchStarts, ['/repo'], 'the watch is started once for the workspace')

  // --- switching agent tabs re-resolves for the newly focused agent ----------
  await render('codex')
  assert.deepEqual(
    asked,
    [
      { workspaceRoot: '/repo', pluginId: 'claude-code' },
      { workspaceRoot: '/repo', pluginId: 'codex' },
    ],
    'a new focused agent asks the resolver again',
  )
  assert.equal(
    snapshotNow()?.skills[0]?.id,
    'skill-for-codex',
    'the pane describes the newly focused agent, never the previous one',
  )

  // The list must not survive the switch even for a frame: the previous agent's
  // skills under the new tab's name would be live-looking and wrong.
  seen.length = 0
  await render('zai')
  assert.equal(
    seen.includes('skill-for-codex'),
    false,
    'the previous agent’s list is never handed to the pane under the new tab',
  )
  assert.equal(seen[0], null, 'a changed target drops the old answer before the new one lands')
  assert.equal(seen[seen.length - 1], 'skill-for-zai')

  // --- an invalidation refetches through the same query ----------------------
  const before = asked.length
  seen.length = 0
  await act(async () => {
    for (const listener of [...listeners]) listener({ workspaceRoot: '/repo', pluginIds: ['zai'] })
  })
  assert.equal(asked.length, before + 1, 'an invalidation naming this agent re-asks the resolver')
  assert.deepEqual(asked[asked.length - 1], { workspaceRoot: '/repo', pluginId: 'zai' })

  // A refetch of the SAME target keeps the list on screen, so an invalidation
  // moves the pane once instead of flashing a spinner over an identical list.
  assert.equal(snapshotNow()?.skills[0]?.id, 'skill-for-zai')
  assert.equal(seen.includes(null), false, 'a same-target refetch never blanks the list mid-flight')

  // --- another CLI's invalidation is not this pane's business ----------------
  const settled = asked.length
  await act(async () => {
    for (const listener of [...listeners]) listener({ workspaceRoot: '/repo', pluginIds: ['claude-code'] })
  })
  assert.equal(asked.length, settled, 'an invalidation for a different CLI does not refetch')

  await act(async () => {
    for (const listener of [...listeners]) listener({ workspaceRoot: '/other', pluginIds: ['zai'] })
  })
  assert.equal(asked.length, settled, 'an invalidation for a different workspace does not refetch')

  // --- the watch is refcounted in main, so the pane must stop what it started -
  await act(async () => {
    root.unmount()
  })
  assert.deepEqual(watchStops, ['/repo'], 'unmounting stops the watch it started')
  assert.equal(listeners.length, 0, 'the invalidation subscription is released')

  console.log('useAgentCapabilities: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
