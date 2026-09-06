import assert from 'node:assert/strict'

import type { ReactNode } from 'react'
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
  TerminalLineView,
  WorkingElapsed,
} from './WorkspaceSidebar'
import type { Workspace } from '../../types/workspace'
import type { TerminalLine } from './terminalLines'

// A row's terminal lines (sidebar-lists-every-terminal): one per live
// terminal — mark · name · branch · ±lines · seat — in place of the head pile
// and the single row-level branch of two-line-session-rows. Pure props in,
// markup out — the sidebar's own suites cover the tree semantics.

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

const line = (over: Partial<TerminalLine> = {}): TerminalLine => ({
  key: 's1',
  kind: 'agent',
  cli: 'claude-code',
  name: 'Conor Kirby',
  machineName: null,
  branch: 'main',
  worktree: false,
  cwd: null,
  removed: false,
  additions: 0,
  deletions: 0,
  diffScope: 'folder',
  working: false,
  workingSince: null,
  needsInput: false,
  failed: false,
  idleSince: null,
  idleLabel: 'Idle',
  ...over,
})

const NOW = 1_700_000_000_000

function view(over: Partial<TerminalLine> = {}, props: { seatOverlay?: ReactNode; disambiguate?: boolean } = {}) {
  return renderToStaticMarkup(<TerminalLineView line={line(over)} now={NOW} {...props} />)
}

run('a line is mark · name · branch · seat, the mark named for its runtime', () => {
  const markup = view()
  assert.match(markup, /role="img" aria-label="Claude Code"/, 'the mark says which runtime')
  assert.match(markup, /Conor Kirby/, 'the agent is named')
  assert.match(markup, />main</, 'and its branch')
  assert.match(markup, /font-mono/, 'the branch reads in the mono voice')
  assert.doesNotMatch(markup, /open terminal/, 'no head pile, no count: the lines are the count')
})

run('a plain shell wears the prompt mark and is called Terminal; a remote pane wears the machine', () => {
  const shell = view({ kind: 'shell', cli: null, name: 'Terminal' })
  assert.match(shell, /aria-label="Terminal"/)
  assert.match(shell, /M2 2\.5L4\.5 5L2 7\.5/, 'the prompt mark, drawn, not typed')
  const pane = view({ kind: 'remote', cli: null, name: null, machineName: 'air.local' })
  assert.match(pane, /aria-label="Remote terminal"/)
  assert.match(pane, /aria-label="Remote: air\.local"/, 'the machine is the glyph’s accessible name')
  assert.doesNotMatch(pane, /air\.local<\/span>/, 'and not line text')
  const local = view()
  assert.doesNotMatch(local, /Remote:/, 'local is the unmarked default')
})

run('a worktree of its own reads at full strength, with the path on hover', () => {
  const markup = view({ branch: 'agent/feature', worktree: true, cwd: '/repo/.claude/worktrees/feature/src' })
  assert.match(markup, /text-\[color:var\(--text-default\)\]"[^>]*>[\s\S]*agent\/feature/, 'the branch lifts to default ink')
  assert.match(markup, /sr-only"> \(worktree\)/, 'said in words too')
  const shared = view({ branch: 'main', cwd: '/repo' })
  assert.doesNotMatch(shared, /\(worktree\)/)
})

run('a removed directory says so instead of a branch', () => {
  const markup = view({ branch: null, removed: true, cwd: '/repo/.claude/worktrees/gone' })
  assert.match(markup, />Removed</)
  assert.doesNotMatch(markup, /font-mono/)
})

run('truncation is an ordered give-way: name first, then branch, never mark / diff / seat', () => {
  const markup = view({ branch: 'feat/a-very-long-branch-name', additions: 4, deletions: 1 })
  assert.match(markup, /min-w-\[3ch\] shrink-\[4\]/, 'the name shrinks first (weight 4) to its floor')
  assert.match(markup, /min-w-\[4ch\] shrink-\[3\]/, 'the branch second (weight 3)')
  assert.match(markup, /size-icon-sm shrink-0/, 'the mark never shrinks')
  assert.match(markup, /inline-flex shrink-0/, 'the diff never shrinks')
  assert.match(markup, /min-w-\[44px\] shrink-0/, 'nor the seat')
  assert.match(markup, /overflow-hidden/, 'the line clips rather than spilling past the gutter')
})

run('each scope claims exactly what its checkout supports', () => {
  const folder = view({ additions: 246, deletions: 94, diffScope: 'folder' })
  assert.match(folder, /246 added, 94 removed in this folder/)
  assert.match(folder, /opacity-60/, 'drawn quieter than attributable work')
  assert.doesNotMatch(folder, /by this terminal/, 'never claims the repo’s numbers as the terminal’s')
  assert.doesNotMatch(folder, /title=/, 'no native title attribute anywhere on the stat')
  const own = view({ additions: 12, deletions: 3, diffScope: 'worktree', worktree: true })
  assert.match(own, /12 added, 3 removed by this terminal/)
  assert.doesNotMatch(own, /opacity-60/)
  const shared = view({ branch: 'feat/y', additions: 40, deletions: 8, diffScope: 'branch' })
  assert.match(shared, /40 added, 8 removed on feat\/y/)
  assert.doesNotMatch(shared, /opacity-60/, 'branch work is not a degraded reading')
  assert.doesNotMatch(shared, /removed by this terminal/, 'a shared checkout never claims sole authorship')
  assert.match(shared, /--tone-good/, 'additions in the good tone')
  assert.match(shared, /--tone-error/, 'deletions in the danger tone')
  const branchless = view({ branch: null, additions: 5, deletions: 1, diffScope: 'branch' })
  assert.match(branchless, /5 added, 1 removed on this branch/)
})

run('the seat is the line’s own: working dots + how long, or how long idle', () => {
  const working = view({ working: true, workingSince: NOW - 4_000 })
  assert.match(working, /aria-label="Agent working"/)
  assert.match(working, /sr-only">Working for 4s/)
  const idle = view({ idleSince: NOW - 2 * 60 * 60_000 })
  assert.match(idle, /2h/, 'the idle time renders where the row put it')
  assert.match(idle, /sr-only">Idle 2h ago/)
  assert.doesNotMatch(idle, /--tone-good/, 'no phantom +0')
  const paused = view({ idleSince: NOW - 60_000, idleLabel: 'Paused' })
  assert.match(paused, /sr-only">Paused 1m ago/)
  const failed = view({ failed: true, idleSince: NOW - 1_000 })
  assert.match(failed, /aria-label="Agent failed"/)
})

run('a waiting line wears the warn dot only when the row has to say which line', () => {
  const alone = view({ needsInput: true })
  assert.doesNotMatch(alone, /aria-label="Needs your input"/, 'one line: the row’s gold surface is the mark')
  assert.match(alone, /sr-only">Needs your input/, 'still said in words')
  const among = view({ needsInput: true }, { disambiguate: true })
  assert.match(among, /aria-label="Needs your input"/)
})

run('the row’s revealed actions ride the first line’s seat, whose content steps aside for them', () => {
  const markup = view({ idleSince: NOW - 60_000 }, { seatOverlay: <span className="absolute">actions</span> })
  assert.match(markup, /group-hover:opacity-0 group-focus-within:opacity-0/, 'the seat content yields on hover')
  assert.match(markup, /actions/)
  assert.doesNotMatch(view({ idleSince: NOW - 60_000 }), /group-hover:opacity-0/, 'a later line keeps its seat')
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

run('fleetPanesOf finds the mounted remote panes, CLI mark when the tab carries one', () => {
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

