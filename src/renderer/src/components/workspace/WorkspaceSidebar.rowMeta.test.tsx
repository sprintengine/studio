import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { fleetMachineNamesOf, WorkspaceRowMeta } from './WorkspaceSidebar'
import type { Workspace } from '../../types/workspace'

// The two-line session row's second line (remote-sessions-ux /
// two-line-session-rows): agent heads · provenance · branch · diff. Pure
// props in, markup out — the sidebar's own suites cover the tree semantics.

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

function meta(overrides: Partial<Parameters<typeof WorkspaceRowMeta>[0]> = {}) {
  return renderToStaticMarkup(
    <WorkspaceRowMeta
      sessions={[]}
      fleetMachines={[]}
      branch={null}
      additions={0}
      deletions={0}
      idleText=""
      {...overrides}
    />
  )
}

run('open terminals render as an overlapped head stack, capped at three plus an overflow chip', () => {
  const markup = meta({
    sessions: [
      { sessionId: 'a', cli: 'claude-code' },
      { sessionId: 'b' },
      { sessionId: 'c', cli: 'codex' },
      { sessionId: 'd' },
      { sessionId: 'e' },
    ],
  })
  assert.match(markup, /aria-label="5 open terminals"/, 'the stack names the true count')
  assert.match(markup, /\+2/, 'two beyond the cap fold into the overflow chip')
  // The prompt mark is drawn, not typed (the 11px type floor); its chevron
  // path is its signature.
  assert.match(markup, /M2 2\.5L4\.5 5L2 7\.5/, 'a plain terminal wears the prompt mark, not a provider it lacks')
})

run('remote provenance shows the machine; a local row shows no mark at all', () => {
  const remote = meta({ fleetMachines: ['Conal’s MacBook Air'] })
  assert.match(remote, /aria-label="Remote: Conal’s MacBook Air"/)
  const local = meta({ branch: 'main' })
  assert.doesNotMatch(local, /Remote:/, 'local is the unmarked default (epic decision 7)')
})

run('branch is mono; the diff stat holds the trailing edge in tone ink, spoken in words', () => {
  const markup = meta({ branch: 'feat/relay-snapshots', additions: 86, deletions: 12 })
  assert.match(markup, /feat\/relay-snapshots/)
  assert.match(markup, /font-mono/, 'branch reads in the mono voice')
  // No aria-label on generic spans (ignored there): the numbers read
  // visually, and the words ride along for AT in an sr-only span.
  assert.match(markup, /86 added, 12 removed/)
  assert.match(markup, /--tone-good/, 'additions in the good tone')
  assert.match(markup, /--tone-error/, 'deletions in the danger tone')
  assert.match(markup, /ml-auto/, 'the stat is pushed to the trailing edge')
  // Truncation order: the branch is the flexible segment (min-w-0 shrink);
  // the provenance span is capped, not flexible.
  assert.match(markup, /min-w-0 shrink items-center gap-1 font-mono/)
})

run('with a clean tree the trailing edge falls back to idle recency', () => {
  const markup = meta({ branch: 'main', idleText: '2h' })
  assert.match(markup, /2h/)
  assert.doesNotMatch(markup, /--tone-good/, 'no phantom +0')
})

run('fleetMachineNamesOf finds fleet-terminal tabs anywhere in the layout, deduplicated', () => {
  const workspace = {
    layoutModel: {
      layout: {
        type: 'row',
        children: [
          {
            type: 'tabset',
            children: [
              { type: 'tab', component: 'terminal', config: {} },
              { type: 'tab', component: 'fleet-terminal', config: { machineName: 'Air' } },
            ],
          },
          {
            type: 'row',
            children: [
              {
                type: 'tabset',
                children: [{ type: 'tab', component: 'fleet-terminal', config: { machineName: 'Air' } }],
              },
            ],
          },
        ],
      },
    },
  } as unknown as Workspace
  assert.deepEqual(fleetMachineNamesOf(workspace), ['Air'])
})

run('a workspace with no fleet tabs reports no machines', () => {
  const workspace = {
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.deepEqual(fleetMachineNamesOf(workspace), [])
})

if (failures > 0) {
  console.error(`WorkspaceSidebar.rowMeta.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('WorkspaceSidebar.rowMeta.test.tsx: ok')
