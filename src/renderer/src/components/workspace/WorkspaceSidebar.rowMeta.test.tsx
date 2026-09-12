import assert from 'node:assert/strict'

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  AttentionPulse,
  fleetMachineNamesOf,
  fleetPanesOf,
  groupKeyOf,
  provenanceMachinesOf,
  TerminalLineView,
  WorkingElapsed,
} from './WorkspaceSidebar'
import type { Workspace } from '../../types/workspace'
import type { TerminalLine } from './terminalLines'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'

// A row's terminal lines (sidebar-lists-every-terminal): one per live
// terminal — mark · branch · ±lines · seat — in place of the head pile and
// the single row-level branch of two-line-session-rows. The terminal's name
// rides on the mark, not the line. Pure props in, markup out — the sidebar's
// own suites cover the tree semantics.

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
  changedFiles: 0,
  files: null,
  diffScope: 'folder',
  activeSubagents: 0,
  pullRequests: [],
  working: false,
  workingSince: null,
  needsInput: false,
  failed: false,
  idleSince: null,
  idleLabel: 'Idle',
  ...over,
})

const NOW = 1_700_000_000_000

function view(
  over: Partial<TerminalLine> = {},
  props: { seatOverlay?: ReactNode; disambiguate?: boolean; dim?: boolean; rowOwnsStatus?: boolean } = {}
) {
  return renderToStaticMarkup(<TerminalLineView line={line(over)} now={NOW} {...props} />)
}

run('a line is mark · branch · seat; the mark names the terminal and its runtime', () => {
  const markup = view()
  assert.match(markup, /role="img" aria-label="Conor Kirby · Claude Code"/, 'the mark says who, and which runtime')
  assert.doesNotMatch(markup, /Conor Kirby<\/span>/, 'the name is the mark’s, not line text')
  assert.match(markup, />main</, 'the line says its branch')
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

run('a background row\'s line recedes with its title — nothing on it outshines the name', () => {
  // Contrast-for-quiet-chats, 2026-09-07: the worktree branch drew at
  // `--text-default`, which on a dimmed row was BRIGHTER than the chat's own
  // name above it — the branch reading as the point of a chat nobody is using.
  const dim = view({ branch: 'agent/perf-review', worktree: true, cwd: '/repo/.wt/perf' }, { dim: true })
  assert.match(dim, /text-\[color:var\(--text-disabled\)\]/, 'the line drops a step below the dimmed title')
  assert.doesNotMatch(dim, /--text-default/, 'and its worktree branch gives up full strength')
  assert.match(dim, /agent\/perf-review/, 'the branch is still there — dimmer, not gone')

  const lit = view({ branch: 'agent/perf-review', worktree: true, cwd: '/repo/.wt/perf' })
  assert.match(lit, /--text-default/, 'a row in use keeps it')
})

run('when the row owns the status, the line stops saying it — once per row, not twice', () => {
  // The flat stream puts the clock and the working dots on the row's project
  // line (all-chats-view). The line under it used to say both again six pixels
  // away, so a working chat read "••• 2m" twice.
  const working = view({ working: true, workingSince: NOW - 120_000 }, { rowOwnsStatus: true })
  assert.doesNotMatch(working, /Agent working/, 'no second set of working dots')
  assert.doesNotMatch(working, /2m/, 'and no second elapsed clock')

  const idle = view({ idleSince: NOW - 600_000, idleLabel: 'Idle' }, { rowOwnsStatus: true })
  assert.doesNotMatch(idle, /10m/, 'no second idle clock either')
  assert.match(view({ idleSince: NOW - 600_000, idleLabel: 'Idle' }), /10m/, 'the tree keeps it on the line')

  // What survives: which terminal is waiting, on a row with more than one.
  const waiting = view({ needsInput: true }, { rowOwnsStatus: true, disambiguate: true })
  assert.match(waiting, /Needs your input/, 'a multi-terminal row still says which line is waiting')
  const lone = view({ needsInput: true }, { rowOwnsStatus: true })
  assert.match(lone, /sr-only[^>]*>Needs your input/, 'a single line says it in words alone — the row wash is the mark')
})

run('a removed directory says so instead of a branch', () => {
  const markup = view({ branch: null, removed: true, cwd: '/repo/.claude/worktrees/gone' })
  assert.match(markup, />Removed</)
  assert.doesNotMatch(markup, /font-mono/)
})

run('truncation is an ordered give-way: the branch yields, never mark / diff / seat', () => {
  const markup = view({ branch: 'feat/a-very-long-branch-name', additions: 4, deletions: 1 })
  assert.match(markup, /min-w-\[4ch\] shrink-\[3\]/, 'the branch shrinks (weight 3) to its floor')
  assert.match(markup, /size-icon-sm shrink-0/, 'the mark never shrinks')
  assert.match(markup, /inline-flex shrink-0/, 'the diff never shrinks')
  assert.match(markup, /min-w-\[44px\] shrink-0/, 'nor the seat')
  assert.match(markup, /overflow-hidden/, 'the line clips rather than spilling past the gutter')
})

// The pull request mark on the line (epic pull-request-marks, decisions 3–6).
// The tooltip itself is portalled on hover and so is not in this markup — its
// words are held in `PullRequestMark.test.tsx`; what is held here is the
// placement, the spoken name, the tone, and the case where nothing is drawn.
const HOUR = 3_600_000

const pullRequest = (over: Partial<BranchPullRequest> & { number: number }): BranchPullRequest => ({
  url: `https://github.com/acme/multicode/pull/${over.number}`,
  repoKey: 'github.com/acme/multicode',
  repoName: 'multicode',
  title: `Pull request ${over.number}`,
  state: 'open',
  isDraft: false,
  openedAt: NOW - HOUR,
  stateAt: NOW,
  onSessionBranch: true,
  ...over,
})

run('the mark sits after the branch and before the ±lines, and opens the pull request', () => {
  const markup = view({
    branch: 'agent/ext-icon-notification',
    additions: 40,
    deletions: 7,
    pullRequests: [pullRequest({ number: 418 })],
  })
  const branchAt = markup.indexOf('agent/ext-icon-notification')
  const markAt = markup.indexOf('data-pull-request-mark')
  const diffAt = markup.indexOf('+40')
  assert.ok(branchAt >= 0 && markAt > branchAt, 'after the branch it belongs to')
  assert.ok(diffAt > markAt, 'and before the ±lines, which keep their place')
  assert.match(
    markup,
    /aria-label="Pull request 418, open. Open it on GitHub"/,
    'the spoken name carries the state and the consequence',
  )
  assert.match(markup, /data-pull-request-mark="https:\/\/github.com\/acme\/multicode\/pull\/418"/)
  assert.match(markup, /color:var\(--accent-primary\)/, 'open inks in the accent')
  assert.doesNotMatch(markup, /<a /, 'a control, never an anchor: nothing here navigates in-app')
})

run('a line with no pull request draws no mark at all — there is no “unknown”', () => {
  const markup = view({ branch: 'agent/nothing-opened', additions: 4, deletions: 1 })
  assert.doesNotMatch(markup, /data-pull-request-mark/)
  assert.doesNotMatch(markup, /Pull request/)
})

run('the mark is the most recent OPEN one, and it inks in that state’s tone', () => {
  const merged = view({
    pullRequests: [
      pullRequest({ number: 420, state: 'merged', openedAt: NOW - HOUR }),
      pullRequest({ number: 411, state: 'closed', openedAt: NOW - 2 * HOUR }),
    ],
  })
  assert.match(merged, /aria-label="Pull request 420, merged\. Earlier: pull request 411, closed\./)
  assert.match(merged, /color:var\(--tone-merged\)/, 'merged takes the landed-branch violet')

  const open = view({
    pullRequests: [
      pullRequest({ number: 420, state: 'merged', openedAt: NOW - HOUR }),
      pullRequest({ number: 411, openedAt: NOW - 2 * HOUR }),
    ],
  })
  assert.match(open, /aria-label="Pull request 411, open\./, 'an older open one beats a newer merged one')
})

run('the mark recedes with a background row rather than shouting over its title', () => {
  const markup = view({ pullRequests: [pullRequest({ number: 418 })] }, { dim: true })
  assert.match(markup, /data-pull-request-mark[^>]*opacity-60|opacity-60[^>]*data-pull-request-mark/)
})

run('each scope claims exactly what its checkout supports, in FILES', () => {
  // Owner decision 2026-09-09: the summary level counts files — "+3 −1" is
  // three files added or updated and one removed. Lines survive only where a
  // single file is in view (the conversation peek's rows, the diff viewer),
  // and the line's own line counts are no longer drawn anywhere on it.
  const folder = view({ additions: 246, deletions: 94, files: { added: 0, updated: 4, removed: 0 }, diffScope: 'folder' })
  assert.match(folder, /4 files updated — uncommitted in this folder/)
  assert.doesNotMatch(folder, /246|94/, 'the line counts are not the summary\u2019s unit any more')
  assert.match(folder, /opacity-60/, 'drawn quieter than attributable work')
  assert.doesNotMatch(folder, /by this terminal/, 'never claims the repo’s numbers as the terminal’s')
  assert.doesNotMatch(folder, /title=/, 'no native title attribute anywhere on the stat')

  const own = view({ files: { added: 2, updated: 1, removed: 1 }, diffScope: 'worktree', worktree: true })
  assert.match(own, /\+3/, 'added and updated are one number on the line')
  assert.match(own, /−1/, 'a true minus sign, and the removals beside it')
  assert.match(own, /2 files added, 1 updated, 1 removed — changed by this terminal/)
  assert.doesNotMatch(own, /opacity-60/)

  const shared = view({ branch: 'feat/y', files: { added: 5, updated: 0, removed: 0 }, diffScope: 'branch' })
  assert.match(shared, /5 files added — changed on feat\/y/)
  assert.doesNotMatch(shared, /opacity-60/, 'branch work is not a degraded reading')
  assert.doesNotMatch(shared, /changed by this terminal/, 'a shared checkout never claims sole authorship')
  assert.match(shared, /--tone-good/, 'what the checkout gained, in the good tone')
  assert.match(shared, /--tone-error/, 'what it lost, in the danger tone')
  assert.match(shared, /tabular-nums/, 'a column of them lines up')

  const branchless = view({ branch: null, files: { added: 1, updated: 0, removed: 0 }, diffScope: 'branch' })
  assert.match(branchless, /1 file added — changed on this branch/, 'one file is one file')

  // The fourth scope (owner ruling 2026-09-09): a branch that has LANDED by
  // squash merge, where the span would still read the whole feature, so the
  // line shows what the checkout still carries and names the pull request that
  // moved it. Attributable work, so it draws at full strength.
  const landed = view({
    branch: 'feat/y',
    changedFiles: 2,
    files: { added: 1, updated: 1, removed: 0 },
    diffScope: 'landed',
    pullRequests: [pullRequest({ number: 418, state: 'merged' })],
  })
  // design-tokens-allow: the literal is a pull request NUMBER in the line's own words, not a colour
  assert.match(landed, /1 file added, 1 updated — uncommitted here since pull request #418 was merged/, 'and the reason is spoken, not only hovered')
  assert.doesNotMatch(landed, /opacity-60/, 'what the checkout still carries is not a degraded reading')
  assert.doesNotMatch(landed, /in this folder|on this branch|by this terminal/, 'it claims the checkout since the merge, nothing else')

  // The chip is gated on the NUMBERS, not on the scope: a landed branch with a
  // clean checkout draws no chip at all, which is the honest drawing of "the
  // work is in, nothing is outstanding".
  const zeros = view({ files: { added: 0, updated: 0, removed: 0 }, diffScope: 'landed' })
  assert.doesNotMatch(zeros, /files added|file added|No files changed/, 'no phantom +0 −0 chip, whatever the scope says')
  assert.match(landed, /file added/, 'and the same view does draw one when files moved')

  // The one that matters most: a summary with LINES but no file breakdown — an
  // older main, a span git could not read, a remote row — draws NOTHING here.
  // Drawing its line counts would put a different unit in the same place.
  const linesOnly = view({ additions: 202, deletions: 122, changedFiles: 9, files: null, diffScope: 'branch' })
  assert.doesNotMatch(linesOnly, /--tone-good/, 'no chip at all without a breakdown to draw')
  assert.doesNotMatch(linesOnly, /202|122/, 'and never the lines in its place')
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
  // Grouped by the PROJECT over there, not by the chat: two chats in one
  // checkout on the Air share a header (owner, 2026-09-11). The repository
  // takes precedence where the machine could name one, so the same repository
  // on two machines is one project; this origin names none.
  assert.equal(groupKeyOf(born), 'remote:c1:/users/me/app', 'grouped by the folder over there, not by the remote workspace id')
  const bornWithRepo = {
    ...born,
    remoteOrigin: {
      ...(born as unknown as { remoteOrigin: Record<string, unknown> }).remoteOrigin,
      repository: { canonicalKey: 'github.com/acme/app', remoteUrl: '', name: 'app' },
    },
  } as unknown as Workspace
  assert.equal(groupKeyOf(bornWithRepo), 'remote-repo:github.com/acme/app', 'a named repository is the project, whatever machine holds it')

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


run('a worktree row groups under the project it was cut from, not under its own slug', () => {
  const parent = { folderPath: '/home/dev/projects/multicode', layoutModel: { layout: { type: 'row', children: [] } } } as unknown as Workspace
  const parentKey = groupKeyOf(parent)
  assert.equal(parentKey, '/home/dev/projects/multicode')

  // The row the Worktree manager writes today: it carries the project it came
  // from explicitly, so no path convention has to be trusted.
  const declared = {
    folderPath: '/home/dev/projects/.multicode-worktrees/multicode/perf-review-wholesale',
    worktree: { branch: 'wt/perf-review-wholesale', repoRoot: '/home/dev/projects/multicode' },
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.equal(groupKeyOf(declared), parentKey, 'the recorded project is the header')

  // A row written before that field existed: the container convention says
  // where it came from — `<parent>/.multicode-worktrees/<repo>/<slug>`.
  const legacyWorktree = {
    folderPath: '/home/dev/projects/.multicode-worktrees/multicode/perf-review-wholesale',
    worktree: { branch: 'wt/perf-review-wholesale' },
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.equal(groupKeyOf(legacyWorktree), parentKey, 'derived from the container path when nothing was recorded')

  // A sprint run's folderPath is ALREADY the parent project (the run keeps its
  // worktree on sprintEngineState.vcs), so nothing about it moves.
  const sprint = {
    folderPath: '/home/dev/projects/multicode',
    sprintEngineState: { vcs: { mode: 'worktree', repos: [{ repoId: 'app', worktreePath: '.multicode-worktrees/multicode/run', branch: 'run/x' }] } },
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.equal(groupKeyOf(sprint), parentKey, 'a sprint run was always filed under its project')

  // And the rows that were never worktrees keep exactly the keys they had.
  const plain = { folderPath: '/Users/me/App/', layoutModel: { layout: { type: 'row', children: [] } } } as unknown as Workspace
  assert.equal(groupKeyOf(plain), '/users/me/app')
  const remote = {
    folderPath: null,
    remoteOrigin: { connectionId: 'c1', machineName: 'Air', workspaceId: 'rw1', workspaceName: 'app', workspaceRoot: '/Users/me/app' },
    layoutModel: { layout: { type: 'row', children: [] } },
  } as unknown as Workspace
  assert.equal(groupKeyOf(remote), 'remote:c1:rw1')
  const fleet = {
    folderPath: null,
    layoutModel: { layout: { type: 'tabset', children: [{ type: 'tab', component: 'fleet-terminal', config: { machineName: 'Mini' } }] } },
  } as unknown as Workspace
  assert.equal(groupKeyOf(fleet), 'remote:mini')

  // A folder of nothing but whitespace is no folder, and has to be no folder
  // to every reader: the project resolver trims it away, so a key that kept it
  // would file the row under a header spelled out of spaces.
  const blank = { folderPath: '   ', layoutModel: { layout: { type: 'row', children: [] } } } as unknown as Workspace
  assert.equal(groupKeyOf(blank), '__no_folder__')
})
