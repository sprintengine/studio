import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { AttentionPulse, fleetMachineNamesOf, WorkingElapsed, WorkspaceRowMeta } from './WorkspaceSidebar'
import type { Workspace } from '../../types/workspace'

// The two-line session row's second line (remote-sessions-ux /
// two-line-session-rows): agent heads · provenance · branch · diff, with the
// status seat on the trailing edge since the owner ruling of 2026-09-04. Pure
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

run('branch is mono; the diff stat sits against it in tone ink, spoken in words', () => {
  const markup = meta({ branch: 'feat/relay-snapshots', additions: 86, deletions: 12 })
  assert.match(markup, /feat\/relay-snapshots/)
  assert.match(markup, /font-mono/, 'branch reads in the mono voice')
  // No aria-label on generic spans (ignored there): the numbers read
  // visually, and the words ride along for AT in an sr-only span.
  assert.match(markup, /86 added, 12 removed/)
  assert.match(markup, /--tone-good/, 'additions in the good tone')
  assert.match(markup, /--tone-error/, 'deletions in the danger tone')
  // Owner ruling 2026-09-04: the trailing edge belongs to the status seat, so
  // the diff no longer claims it — it sits with the branch it describes.
  assert.doesNotMatch(markup, /ml-auto/, 'the stat no longer pushes to the edge')
  // Truncation order: the branch is the flexible segment (min-w-0 shrink);
  // the provenance span is capped, not flexible.
  assert.match(markup, /min-w-0 shrink items-center gap-1 font-mono/)
})

run('a folder-scoped reading never claims to be the agent’s work', () => {
  // No turn has closed in this chat yet, so the numbers are the repo's. They
  // still show — that is the honest thing to say — but quieter, and both the
  // tooltip and the spoken label say whose they are.
  const folder = meta({ branch: 'main', additions: 246, deletions: 94, diffScope: 'folder' })
  assert.match(folder, /246 added, 94 removed in this folder/)
  assert.match(folder, /opacity-60/, 'drawn quieter than the agent’s own work')
  assert.match(folder, /no completed turns yet/)

  const own = meta({ branch: 'main', additions: 12, deletions: 3, diffScope: 'workspace' })
  assert.match(own, /12 added, 3 removed by this chat/)
  assert.doesNotMatch(own, /opacity-60/)
  assert.doesNotMatch(own, /this folder/)
})

run('the trailing seat rides line 2, and coexists with the diff rather than replacing it', () => {
  const markup = meta({
    branch: 'main',
    additions: 4,
    deletions: 1,
    trailing: <span className="ml-auto">2h</span>,
  })
  assert.match(markup, /2h/, 'the seat renders where the row put it')
  assert.match(markup, /\+4/, 'and the diff still reads beside the branch')
})

run('with a clean tree the seat is all the trailing edge carries', () => {
  const markup = meta({ branch: 'main', trailing: <span className="ml-auto">2h</span> })
  assert.match(markup, /2h/)
  assert.doesNotMatch(markup, /--tone-good/, 'no phantom +0')
})

run('the working counter counts seconds first, then relaxes to the coarse scale', () => {
  const now = Date.now()
  const seconds = renderToStaticMarkup(<WorkingElapsed since={now - 4_000} />)
  assert.match(seconds, /4s/, 'a four-second turn reads in seconds, not as a blank')
  assert.match(seconds, /aria-label="Working for 4s"/, 'the duration says what it measures')
  assert.match(seconds, /--accent-primary/, 'accent ink binds it to the dots beside it')
  const minutes = renderToStaticMarkup(<WorkingElapsed since={now - 5 * 60_000} />)
  assert.match(minutes, /5m/, 'past a minute it joins the sidebar\'s usual scale')
})

run('the attention flash is one-shot: nothing on first paint, and never on the way out', () => {
  // The first render never pulses — a row that is ALREADY waiting when the
  // sidebar paints must not flash; motion means "just changed".
  assert.equal(renderToStaticMarkup(<AttentionPulse active resetKey="w1" />), '')
  assert.equal(renderToStaticMarkup(<AttentionPulse active={false} resetKey="w1" />), '')
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
