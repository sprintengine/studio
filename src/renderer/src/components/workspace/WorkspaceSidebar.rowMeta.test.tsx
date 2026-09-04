import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  AttentionPulse,
  deriveUnseenCompletions,
  doneRowClass,
  fleetMachineNamesOf,
  fleetPanesOf,
  groupKeyOf,
  isHookSettledSession,
  provenanceMachinesOf,
  WorkingElapsed,
  WorkspaceRowMeta,
} from './WorkspaceSidebar'
import type { Workspace } from '../../types/workspace'

// The two-line session row's second line (remote-sessions-ux /
// two-line-session-rows): agent heads · provenance · branch · diff, with the
// status seat on the trailing edge since the owner ruling of 2026-09-04. Pure
// props in, markup out — the sidebar's own suites cover the tree semantics.

// The diff stat now hangs off the kit's Tooltip, whose useLayoutEffect is a
// no-op under the static renderer; React says so once per render, and that
// warning is the one line of noise this suite filters.
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
  consoleError(...args)
}

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
})

run('truncation is an ordered give-way: branch first, then machine, never heads / diff / seat', () => {
  // 2026-09-04 review: the machine name used to be a fixed 45% cap beside
  // shrink-0 segments, which overflowed the gutter at narrow widths.
  const markup = meta({
    sessions: [{ sessionId: 'a', cli: 'claude-code' }],
    fleetMachines: ['Conal’s MacBook Air'],
    branch: 'feat/a-very-long-branch-name',
    additions: 4,
    deletions: 1,
    trailing: <span className="ml-auto shrink-0">seat</span>,
  })
  assert.match(markup, /min-w-\[3ch\] shrink-\[3\] items-center gap-1 font-mono/, 'the branch shrinks first (weight 3) to its floor')
  assert.match(markup, /min-w-\[5ch\] shrink items-center gap-1/, 'the machine name shrinks after it (weight 1) to its own floor')
  assert.doesNotMatch(markup, /max-w-\[45%\]/, 'no fixed cap on the machine name')
  assert.match(markup, /flex shrink-0 items-center" role="img" aria-label="1 open terminal"/, 'heads never shrink')
  assert.match(markup, /inline-flex shrink-0/, 'the diff never shrinks')
  assert.match(markup, /overflow-hidden/, 'line 2 clips rather than spilling past the gutter')
})

run('each scope claims exactly what its checkout supports', () => {
  // `folder` — a shared checkout level with the default branch. The numbers are
  // the repo's uncommitted state. They still show, which is the honest thing to
  // say, but quieter, and both the tooltip and the spoken label say whose.
  const folder = meta({ branch: 'main', additions: 246, deletions: 94, diffScope: 'folder' })
  assert.match(folder, /246 added, 94 removed in this folder/)
  assert.match(folder, /opacity-60/, 'drawn quieter than attributable work')
  assert.doesNotMatch(folder, /by this chat/, 'never claims the repo’s numbers as the chat’s')
  // The kit's Tooltip — content rendered on hover, never a native title.
  assert.doesNotMatch(folder, /title=/, 'no native title attribute anywhere on the stat')

  // `worktree` — its own checkout, so the work is this chat's and says so.
  const own = meta({ branch: 'feat/x', additions: 12, deletions: 3, diffScope: 'worktree' })
  assert.match(own, /12 added, 3 removed by this chat/)
  assert.doesNotMatch(own, /opacity-60/)
  assert.doesNotMatch(own, /this folder/)

  // `branch` — attributable to the BRANCH, not to this chat alone. Full
  // strength, because it is real branch work, with the qualification carried in
  // the words rather than in the ink.
  const shared = meta({ branch: 'feat/y', additions: 40, deletions: 8, diffScope: 'branch' })
  assert.match(shared, /40 added, 8 removed on feat\/y/)
  assert.doesNotMatch(shared, /opacity-60/, 'branch work is not a degraded reading')
  assert.doesNotMatch(shared, /removed by this chat/, 'a shared checkout never claims sole authorship')
})

run('a branch-scoped row with no branch name still reads', () => {
  // scope `branch` implies a branch, but the row must not render "on null" if a
  // read ever disagrees with itself.
  const markup = meta({ branch: null, additions: 5, deletions: 1, diffScope: 'branch' })
  assert.match(markup, /5 added, 1 removed on this branch/)
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
  // Visible number + sr-only sentence, like the diff stat; no aria-label on a
  // generic span (ignored there — the pattern the row's review rejected).
  assert.match(seconds, /sr-only">Working for 4s/, 'the duration says what it measures, in words AT will read')
  assert.doesNotMatch(seconds, /aria-label/)
  assert.match(seconds, /--accent-primary/, 'accent ink binds it to the dots beside it')
  const minutes = renderToStaticMarkup(<WorkingElapsed since={now - 5 * 60_000} />)
  assert.match(minutes, /5m/, 'past a minute it joins the sidebar\'s usual scale')
})

run('the attention flash is one-shot: nothing on first paint, and never on the way out', () => {
  // The first render never pulses — a row that is ALREADY waiting when the
  // sidebar paints must not flash; motion means "just changed".
  assert.equal(renderToStaticMarkup(<AttentionPulse active resetKey="w1" />), '')
  assert.equal(renderToStaticMarkup(<AttentionPulse active={false} resetKey="w1" />), '')
  // The green twin obeys the same rule.
  assert.equal(renderToStaticMarkup(<AttentionPulse active resetKey="w1" tone="good" />), '')
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

run('fleet panes are heads: one chip per remote terminal, CLI mark if the tab carries one, else neutral', () => {
  const workspace = {
    layoutModel: {
      layout: {
        type: 'tabset',
        children: [
          { type: 'tab', id: 'fleet-terminal:c1:s1', component: 'fleet-terminal', config: { machineName: 'Air', remoteSessionId: 's1', cli: 'codex' } },
          { type: 'tab', id: 'fleet-terminal:c1:s2', component: 'fleet-terminal', config: { machineName: 'Air', remoteSessionId: 's2' } },
        ],
      },
    },
  } as unknown as Workspace
  const panes = fleetPanesOf(workspace)
  assert.deepEqual(panes, [
    { tabId: 'fleet-terminal:c1:s1', machineName: 'Air', cli: 'codex' },
    { tabId: 'fleet-terminal:c1:s2', machineName: 'Air' },
  ])
  const markup = meta({
    sessions: panes.map((pane) => ({ sessionId: pane.tabId, cli: pane.cli, remote: true })),
    fleetMachines: ['Air'],
  })
  assert.match(markup, /aria-label="2 open terminals"/, 'a remote-born row no longer shows the machine over an empty stack')
  assert.match(markup, /size-1\.5 rounded-full/, 'a pane with no CLI wears the neutral chip')
  assert.doesNotMatch(markup, /M2 2\.5L4\.5 5L2 7\.5/, 'and not the local shell’s prompt mark')
})

run('provenance comes from remoteOrigin first; the layout walk covers legacy rows and mounted panes', () => {
  const born = {
    folderPath: null,
    remoteOrigin: { connectionId: 'c1', machineName: 'Air', workspaceId: 'rw1', workspaceName: 'app', workspaceRoot: '/Users/me/app' },
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.deepEqual(provenanceMachinesOf(born), ['Air'], 'a closed pane never loses the mark')
  assert.equal(groupKeyOf(born), 'remote:c1:rw1', 'grouped by machine + remote workspace, not "No folder"')

  const legacy = {
    folderPath: null,
    layoutModel: { layout: { type: 'tabset', children: [{ type: 'tab', component: 'fleet-terminal', config: { machineName: 'Mini' } }] } },
  } as unknown as Workspace
  assert.deepEqual(provenanceMachinesOf(legacy), ['Mini'])
  assert.equal(groupKeyOf(legacy), 'remote:mini')

  const local = { folderPath: '/Users/me/App/', layoutModel: { layout: { type: 'row', children: [] } } } as unknown as Workspace
  assert.deepEqual(provenanceMachinesOf(local), [], 'local is the unmarked default')
  assert.equal(groupKeyOf(local), '/users/me/app', 'local grouping is the folder key it always was')
  const mounted = { ...local, layoutModel: legacy.layoutModel } as unknown as Workspace
  assert.equal(groupKeyOf(mounted), '/users/me/app', 'a local workspace with a mounted pane keeps its folder')
  assert.deepEqual(provenanceMachinesOf(mounted), ['Mini'], 'but still says where the pane lives')
})

run('the green row marks a hook-reported turn that finished while the row was not active', () => {
  const settled = new Set(['w1', 'w2', 'w3'])
  // w1 and w2 stopped; w2 is the active row so the person saw it; w3 is still
  // working; w4 stopped but no hook-settled session is left (killed).
  const next = deriveUnseenCompletions({
    previous: new Set(),
    workingSinceBefore: { w1: 100, w2: 100, w3: 100, w4: 100 },
    workingSinceNow: { w1: null, w2: null, w3: 100, w4: null },
    settledWorkspaceIds: settled,
    activeWorkspaceId: 'w2',
  })
  assert.deepEqual([...next].sort(), ['w1'])
  // Opening w1 clears it; a row that vanished is dropped.
  const cleared = deriveUnseenCompletions({
    previous: next,
    workingSinceBefore: { w1: null },
    workingSinceNow: { w1: null },
    settledWorkspaceIds: settled,
    activeWorkspaceId: 'w1',
  })
  assert.equal(cleared.size, 0)
  // Back to work clears it too — a parked model that its background agent
  // re-invoked is not finished — and the mark is earned again at the real end.
  const resumed = deriveUnseenCompletions({
    previous: next,
    workingSinceBefore: { w1: null },
    workingSinceNow: { w1: 500 },
    settledWorkspaceIds: settled,
    activeWorkspaceId: 'w2',
  })
  assert.equal(resumed.size, 0, 'a row that resumed work is no longer finished')
  const finishedAgain = deriveUnseenCompletions({
    previous: resumed,
    workingSinceBefore: { w1: 500 },
    workingSinceNow: { w1: null },
    settledWorkspaceIds: settled,
    activeWorkspaceId: 'w2',
  })
  assert.deepEqual([...finishedAgain], ['w1'], 'and earns the mark again when that turn ends')
  // Hooks only: a lifecycle stamp is not a settled turn, and a dead process is not either.
  assert.equal(isHookSettledSession({ processAlive: true, agentState: { phase: 'idle', source: 'hook' } }), true)
  assert.equal(isHookSettledSession({ processAlive: true, agentState: { phase: 'idle', source: 'lifecycle' } }), false)
  assert.equal(isHookSettledSession({ processAlive: false, agentState: { phase: 'idle', source: 'hook' } }), false)

  // The mark is the row's whole surface in the good tone — fill, ring and
  // title ink, the needs-input treatment in green — not a chip on line 2.
  const resting = doneRowClass(false)
  assert.match(resting, /--tone-good-faint/, 'the 10% wash, one notch under the gold row\'s soft fill')
  assert.doesNotMatch(resting, /--tone-good-soft/, 'never the chip-strength fill on a whole row')
  assert.match(resting, /ring-1 ring-inset ring-\[color:var\(--tone-good-edge\)\]/, 'ring at edge strength, not full tone')
  assert.match(resting, /--tone-good-on-tint/, 'title in good ink that clears AA over the fill')
  assert.match(doneRowClass(true), /ring-2 ring-inset/, 'the selected row keeps the heavier edge')
  assert.doesNotMatch(meta({}), />Done</, 'line 2 no longer carries a chip')
})

if (failures > 0) {
  console.error(`WorkspaceSidebar.rowMeta.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('WorkspaceSidebar.rowMeta.test.tsx: ok')
