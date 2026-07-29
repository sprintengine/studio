import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import {
  HorizonDetailPane,
  resolveStepItem,
  runStripFacts,
  type HorizonDetailPaneProps,
} from './HorizonDetailPane'
import { buildLibraryGroupModels } from './HorizonBacklogSource'
import { createBacklogItem, type BacklogItem } from '../../../utils/backlog'
import { deriveBacklogProjectDerived } from '../../../hooks/useAllProjectsBacklog'
import type { HorizonStepRow } from './horizonPlanModel'
import type { BacklogProjectFeed, BacklogProjectRef } from '../../../hooks/useAllProjectsBacklog'
import type { RoadmapProjectItems } from '../../backlog/roadmapAuthoring'

// The Horizon detail pane (MC-1923). The mounted `BacklogItemDetailPane` arm is
// the Backlog door's own component and is proved by its suites; what is proved
// here is what Horizon ADDS — the run strip's wording, the step→item resolution
// (including the two-projects-one-path trap), and the honest states a step with
// no resolvable item has to reach instead of a blank pane.

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

function backlogItem(root: string, relativePath: string, source: string): BacklogItem {
  return createBacklogItem({
    path: `${root}/${relativePath}`,
    relativePath,
    sourceContent: source,
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
  })
}

function feedOf(name: string, root: string, items: BacklogItem[]): BacklogProjectFeed {
  const project: BacklogProjectRef = { key: name.slice(0, 2).toUpperCase(), name, root, rootKey: root.toLowerCase() }
  return {
    projectKey: project.key,
    projectName: name,
    root,
    rootKey: project.rootKey,
    items: items.map((item) => ({ project, item })),
    derived: deriveBacklogProjectDerived(items),
    loading: false,
  }
}

function step(overrides: Partial<HorizonStepRow> = {}): HorizonStepRow {
  return {
    key: '0:0:backlog/one.md',
    laneIndex: 0,
    entryIndex: 0,
    laneTitle: 'Delivery',
    ref: 'backlog/one.md',
    title: 'One',
    kind: 'item',
    state: 'up_next',
    projectKey: null,
    projectName: 'multicode',
    roster: { label: 'No roles', overridden: false, missing: false },
    unresolved: false,
    projectUnavailable: false,
    ...overrides,
  }
}

function render(overrides: Partial<HorizonDetailPaneProps> = {}): string {
  const props: HorizonDetailPaneProps = {
    step: null,
    resolved: null,
    unresolved: 'missing',
    canOpenRun: true,
    run: null,
    homePath: '/repo',
    now: 2_000,
    actions: {} as HorizonDetailPaneProps['actions'],
    linkProviders: [],
    epicChoices: [],
    dependencyChoices: [],
    onNavigate: () => undefined,
    onReload: () => undefined,
    onPause: () => undefined,
    onResume: () => undefined,
    onApprove: () => undefined,
    onMerge: () => undefined,
    onOpenRun: () => undefined,
    ...overrides,
  }
  return renderToStaticMarkup(<HorizonDetailPane {...props} />)
}

// ── the run strip's wording ──────────────────────────────────────────────────

run('the strip says agents, tasks left and the pull request — and nothing else', () => {
  assert.deepEqual(
    runStripFacts({
      agentsWorking: 6,
      tasksLeft: 3,
      loading: false,
      attention: 'none',
      pullRequestUrl: 'https://github.com/o/r/pull/412',
      pullRequestState: 'open',
    }),
    // design-tokens-allow: a pull-request number, not a colour
    ['6 agents', '3 tasks left', 'PR #412 open'],
  )
})

run('a run with nothing left reads delivered, and its PR says it waits on you', () => {
  assert.deepEqual(
    runStripFacts({
      agentsWorking: 3,
      tasksLeft: 0,
      loading: false,
      attention: 'merge',
      pullRequestUrl: 'https://github.com/o/r/pull/221',
      pullRequestState: 'open',
    }),
    // design-tokens-allow: a pull-request number, not a colour
    ['3 agents', 'delivered', 'PR #221 waiting on you'],
  )
})

run('a merged pull request says merged, whatever the track is waiting on', () => {
  assert.deepEqual(
    runStripFacts({
      agentsWorking: 0,
      tasksLeft: 0,
      loading: false,
      attention: 'merge',
      pullRequestUrl: 'https://github.com/o/r/pull/9',
      pullRequestState: 'merged',
    }),
    ['delivered', 'PR #9 merged'],
  )
})

run('a projection still loading never claims the run delivered', () => {
  assert.deepEqual(runStripFacts({ agentsWorking: 0, tasksLeft: 0, loading: true, attention: 'none' }), [])
})

run('no seat holding a task is not "0 agents" — the count is simply not claimed', () => {
  assert.deepEqual(
    runStripFacts({ agentsWorking: 0, tasksLeft: 4, loading: false, attention: 'none' }),
    ['4 tasks left'],
  )
})

run('one agent and one task read singular', () => {
  assert.deepEqual(
    runStripFacts({ agentsWorking: 1, tasksLeft: 1, loading: false, attention: 'none' }),
    ['1 agent', '1 task left'],
  )
})

// ── resolving a step to its item ─────────────────────────────────────────────

const HOME = feedOf('multicode', '/repo/multicode', [
  backlogItem('/repo/multicode', 'backlog/one.md', '---\nstatus: ready\n---\n# One in multicode\n'),
])
const MOBILE = feedOf('multicode-mobile', '/repo/mobile', [
  backlogItem('/repo/mobile', 'backlog/one.md', '---\nstatus: ready\n---\n# One in mobile\n'),
])

run('a step resolves inside its OWN project, never by path across all of them', () => {
  // Both projects hold `backlog/one.md`. Matching across feeds would pick either.
  const home = resolveStepItem([HOME, MOBILE], '/repo/multicode', 'backlog/one.md')
  const mobile = resolveStepItem([HOME, MOBILE], '/repo/mobile', 'backlog/one.md')
  assert.equal(home?.item.title, 'One in multicode')
  assert.equal(mobile?.item.title, 'One in mobile')
})

run('resolution normalizes separators and a trailing slash on the root', () => {
  assert.ok(resolveStepItem([HOME], '/repo/multicode/', 'backlog\\one.md'))
})

run('an unresolvable project or a missing file resolves to null, never a wrong item', () => {
  assert.equal(resolveStepItem([HOME, MOBILE], null, 'backlog/one.md'), null)
  assert.equal(resolveStepItem([HOME, MOBILE], '/repo/unknown', 'backlog/one.md'), null)
  assert.equal(resolveStepItem([HOME, MOBILE], '/repo/multicode', 'backlog/gone.md'), null)
})

// ── the states a step with no item has to reach ──────────────────────────────

run('nothing selected says what the pane is for', () => {
  assert.match(render(), /Pick a step on the left/)
})

run('a draft says what a draft is, instead of growing a layout of its own', () => {
  const markup = render({
    step: null,
    emptySelection: { title: 'Draft horizon', body: 'Nothing runs until you make it active.' },
  })
  assert.match(markup, /Draft horizon/)
  assert.match(markup, /Nothing runs until you make it active/)
})

run('a step in an unresolvable project names the project and the fix', () => {
  const markup = render({
    step: step({ state: 'unknown_project', projectName: 'multicode-mobile', ref: 'mobile:backlog/one.md' }),
  })
  assert.match(markup, /multicode-mobile isn’t open/)
  assert.match(markup, /re-map the alias/)
  assert.match(markup, /mobile:backlog\/one\.md/, 'the ref, so the horizon file can be found')
})

run('a step whose backlog file is gone says so, and says the track will park', () => {
  const markup = render({ step: step(), resolved: null, unresolved: 'missing' })
  assert.match(markup, /backlog item is missing/)
  assert.match(markup, /parks here rather than skipping it/)
})

run('a step in a project this Multicode has no feed for is not reported "missing"', () => {
  // The file may be perfectly present — we simply cannot see that project.
  const markup = render({ step: step(), resolved: null, unresolved: 'project_unavailable' })
  assert.match(markup, /isn’t open/)
  assert.doesNotMatch(markup, /backlog item is missing/)
})

run('an unresolved step before the scan reports reads as loading, not as missing', () => {
  const markup = render({ step: step(), resolved: null, unresolved: 'loading' })
  assert.match(markup, /Loading this step…/)
  assert.doesNotMatch(markup, /missing/)
})

// ── the backlog you drag from ────────────────────────────────────────────────

function projectItems(items: BacklogItem[]): RoadmapProjectItems {
  return { projectKey: null, projectName: 'multicode', path: '/repo/multicode', items }
}

run('placed work is dimmed, not dropped — and an epic dims its members with it', () => {
  const items = [
    backlogItem('/repo/multicode', 'backlog/epics/auth.md', '---\ntype: epic\nstatus: ready\n---\n# Auth\n'),
    backlogItem('/repo/multicode', 'backlog/auth-login.md', '---\nstatus: ready\nepic: auth\n---\n# Login\n'),
    backlogItem('/repo/multicode', 'backlog/loose.md', '---\nstatus: ready\n---\n# Loose\n'),
  ]
  const models = buildLibraryGroupModels(
    projectItems(items),
    new Set(['backlog/epics/auth.md']),
    '',
    'active',
    'best',
  )
  const epicGroup = models.find((model) => model.headerRef === 'backlog/epics/auth.md')
  assert.ok(epicGroup, 'the placed epic is still listed')
  assert.equal(epicGroup.headerPlanned, true)
  assert.ok(
    epicGroup.children.every((child) => child.planned),
    'a member of a placed epic rides that step, so it dims with it',
  )
  const loose = models.flatMap((model) => model.children).find((child) => child.item.title === 'Loose')
  assert.equal(loose?.planned, false)
})

run('horizon files never appear as work you can plan', () => {
  const items = [
    backlogItem('/repo/multicode', 'backlog/roadmaps/next.md', '---\ntype: roadmap\nstatus: ready\n---\n# Next\n'),
    backlogItem('/repo/multicode', 'backlog/loose.md', '---\nstatus: ready\n---\n# Loose\n'),
  ]
  const models = buildLibraryGroupModels(projectItems(items), new Set(), '', 'active', 'best')
  const titles = models.flatMap((model) => model.children.map((child) => child.item.title))
  assert.deepEqual(titles, ['Loose'])
})

run('the default Active lens hides completed work', () => {
  const items = [
    backlogItem('/repo/multicode', 'backlog/done.md', '---\nstatus: completed\n---\n# Done\n'),
    backlogItem('/repo/multicode', 'backlog/loose.md', '---\nstatus: ready\n---\n# Loose\n'),
  ]
  const active = buildLibraryGroupModels(projectItems(items), new Set(), '', 'active', 'best')
  assert.deepEqual(active.flatMap((m) => m.children.map((c) => c.item.title)), ['Loose'])
  const all = buildLibraryGroupModels(projectItems(items), new Set(), '', 'all', 'best')
  assert.equal(all.flatMap((m) => m.children).length, 2)
})

run('a cross-project row carries its project-qualified ref, so a drop stays resolvable', () => {
  const items = [backlogItem('/repo/mobile', 'backlog/relay.md', '---\nstatus: ready\n---\n# Relay\n')]
  const models = buildLibraryGroupModels(
    { projectKey: 'mobile', projectName: 'multicode-mobile', path: '/repo/mobile', items },
    new Set(),
    '',
    'active',
    'best',
  )
  assert.equal(models.flatMap((m) => m.children)[0].ref, 'mobile:backlog/relay.md')
})

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('horizon detail pane: all checks passed')
