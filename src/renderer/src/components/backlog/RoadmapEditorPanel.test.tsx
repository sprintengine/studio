import assert from 'node:assert/strict'

import { renderToStaticMarkup } from 'react-dom/server'

import { ConfirmDialogProvider } from '../ui'
import { RoadmapEditorPanel } from './RoadmapEditorPanel'
import { createBacklogItem, type BacklogItem } from '../../utils/backlog'

// Render smoke test: exercises the real editor tree (tracks, steps, epic children,
// drift affordance, dangling step, policy bar, per-track frontier) via SSR markup.
// Effects and click handlers don't run under renderToStaticMarkup, so this proves
// the component renders the parsed roadmap without a render-time crash and shows
// the state the panel depends on — the acceptance surfaces made visible.

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

function backlogItem(relativePath: string, sourceContent: string): BacklogItem {
  return createBacklogItem({ path: `/repo/${relativePath}`, relativePath, sourceContent, stats: { modifiedAtMs: 1_000, sizeBytes: 64 } })
}

// Roadmap: epic `auth` snapshotted with ONLY auth-login (live membership also has
// auth-logout → drift), a resolvable loose item (foo), and a dangling ref (ghost).
const ROADMAP_CONTENT = `---
type: roadmap
status: ready
advance: approve
merge: manual
concurrency: 1
---
# Payments roadmap

## Backend
- backlog/foo.md
- backlog/epics/auth.md
  - backlog/auth-login.md

## Frontend
- backlog/ghost.md
`

const roadmapItem = backlogItem('backlog/roadmaps/payments.md', ROADMAP_CONTENT)

const items: BacklogItem[] = [
  roadmapItem,
  backlogItem('backlog/foo.md', '---\nstatus: ready\n---\n# Foo\n'),
  backlogItem('backlog/epics/auth.md', '---\ntype: epic\n---\n# Auth\n'),
  backlogItem('backlog/auth-login.md', '---\nstatus: ready\nepic: auth\n---\n# Login\n'),
  backlogItem('backlog/auth-logout.md', '---\nstatus: ready\nepic: auth\n---\n# Logout\n'),
]

function render(item: BacklogItem = roadmapItem, scan: BacklogItem[] = items): string {
  return renderToStaticMarkup(
    <ConfirmDialogProvider>
      <RoadmapEditorPanel
        roadmapItem={item}
        items={scan}
        onSaved={() => {}}
        onOpenInEditor={() => {}}
        onNavigate={() => {}}
        showBack={false}
        onBack={() => {}}
      />
    </ConfirmDialogProvider>,
  )
}

run('renders the roadmap title and both track names', () => {
  const markup = render()
  assert.match(markup, /value="Payments roadmap"/)
  assert.match(markup, /value="Backend"/)
  assert.match(markup, /value="Frontend"/)
})

run('renders a resolvable step by title', () => {
  assert.match(render(), /Foo/)
})

run('renders an epic entry with its snapshotted child and a done/total count', () => {
  const markup = render()
  assert.match(markup, /Auth/)
  assert.match(markup, /Login/)
  // done/total, not a bare member count (MC-1902): auth-login is `ready`, so none
  // of the one snapshotted member is done yet.
  assert.match(markup, /0\/1 item/)
})

run('an epic member carries its live lifecycle glyph, named for a reader', () => {
  // auth-login is `ready` in the fixture, so the member row shows the ready glyph
  // — item-status truth read straight off the backlog scan (MC-1902).
  assert.match(render(), /aria-label="Ready"/)
})

run('a member that completed reads done, and the step count follows it', () => {
  const completedLogin = backlogItem('backlog/auth-login.md', '---\nstatus: completed\nepic: auth\n---\n# Login\n')
  const markup = renderToStaticMarkup(
    <ConfirmDialogProvider>
      <RoadmapEditorPanel
        roadmapItem={roadmapItem}
        items={items.map((item) => (item.relativePath === 'backlog/auth-login.md' ? completedLogin : item))}
        onSaved={() => {}}
        onOpenInEditor={() => {}}
        onNavigate={() => {}}
        showBack={false}
        onBack={() => {}}
      />
    </ConfirmDialogProvider>,
  )
  assert.match(markup, /1\/1 item/)
  assert.match(markup, /aria-label="Done"/)
})

run('surfaces the static-plan drift affordance when the epic gained members', () => {
  assert.match(render(), /This epic has 1 new item since you added it\./)
})

run('renders a dangling reference as a visible Unknown step, never dropped', () => {
  assert.match(render(), /Unknown · backlog\/ghost\.md/)
})

run('renders the plain-human policy controls', () => {
  const markup = render()
  assert.match(markup, /Ask me first/)
  assert.match(markup, /I merge/)
  // Concurrency has no editing control — the orchestrator does not honor it yet.
  assert.doesNotMatch(markup, /Tracks running at once/)
})

run('renders the per-track frontier (up next) from eligibility', () => {
  // Backend's first step (foo, ready) is the eligible frontier.
  assert.match(render(), /Up next/)
})

// --- Cross-project planning (MC-1690 / T3) ---------------------------------

// A second project's backlog: an epic (sync) with a child, plus a loose item.
const MOBILE_ITEMS: BacklogItem[] = [
  backlogItem('backlog/epics/sync.md', '---\ntype: epic\n---\n# Offline sync\n'),
  backlogItem('backlog/sync-a.md', '---\nstatus: ready\nepic: sync\n---\n# Sync worker\n'),
  backlogItem('backlog/phone.md', '---\nstatus: ready\n---\n# Phone screen\n'),
]

function renderCrossProject(): string {
  const libraryProjects = [
    { projectKey: null, projectName: 'multicode', path: '/repo', items },
    { projectKey: 'mobile', projectName: 'multicode-mobile', path: '/mobile', items: MOBILE_ITEMS },
  ]
  return renderToStaticMarkup(
    <ConfirmDialogProvider>
      <RoadmapEditorPanel
        roadmapItem={roadmapItem}
        items={items}
        libraryProjects={libraryProjects}
        onSaved={() => {}}
        onOpenInEditor={() => {}}
        onNavigate={() => {}}
        showBack
        onBack={() => {}}
      />
    </ConfirmDialogProvider>,
  )
}

run('cross-project: renders the library rail with the cross-project search and both project groups', () => {
  const markup = renderCrossProject()
  assert.match(markup, /Search all backlogs…/)
  assert.match(markup, /multicode-mobile/)
  // The other project's epic and loose item are draggable library rows.
  assert.match(markup, /Offline sync/)
  assert.match(markup, /Phone screen/)
})

run('cross-project: an already-planned library row is dimmed (planned), never dropped', () => {
  // The roadmap fixture plans home backlog/foo.md, so its library row dims.
  assert.match(renderCrossProject(), /opacity-40/)
})

run('cross-project: completed work is hidden by the default Active lens', () => {
  const done = backlogItem('backlog/done-thing.md', '---\nstatus: completed\n---\n# Shipped thing\n')
  const markup = renderToStaticMarkup(
    <ConfirmDialogProvider>
      <RoadmapEditorPanel
        roadmapItem={roadmapItem}
        items={items}
        libraryProjects={[{ projectKey: null, projectName: 'multicode', path: '/repo', items: [...items, done] }]}
        onSaved={() => {}}
        onOpenInEditor={() => {}}
        onNavigate={() => {}}
        showBack={false}
        onBack={() => {}}
      />
    </ConfirmDialogProvider>,
  )
  assert.doesNotMatch(markup, /Shipped thing/)
})

run('autosave replaces the Save button with a quiet state readout', () => {
  const markup = render()
  assert.match(markup, /Saved/)
  assert.doesNotMatch(markup, />Save</)
  assert.doesNotMatch(markup, /Discard/)
})

// MC-1874 renamed the control off "team" (a roster is agent config; "team" is
// the run dir slug). MC-1880 replaced the Select with a roster menu and removed
// the "Last used roster" sentinel — it was the honest name for a dishonest
// default, resolving through whatever the sprint wizard last touched.
run('the per-horizon roster control names its SCOPE, not just "Roster"', () => {
  const markup = render()
  // MC-1882: it is the DEFAULT for steps that do not override it, not a hard
  // setting for the whole horizon — the label has to say so.
  assert.match(markup, /Default roster/)
  assert.doesNotMatch(markup, /Sprint team/)
})

run('the roster control defaults to "No roles", with no last-used sentinel', () => {
  const markup = render()
  assert.match(markup, /No roles/)
  assert.doesNotMatch(markup, /Last used roster/)
  assert.doesNotMatch(markup, /Last used/)
})

// A roster named in frontmatter that no longer exists must keep its name and be
// marked "(not found)" — never silently read as the default. The step start
// then fails loudly (the epic's standing decision). Deleting a roster a horizon
// references must not silently repoint that horizon.
run('a horizon naming a deleted roster shows "(not found)" and does not fall back', () => {
  const missingRosterRoadmap = backlogItem(
    'backlog/roadmaps/missing-roster.md',
    `---
type: roadmap
status: ready
advance: approve
merge: manual
concurrency: 1
roster: Mobile UI
---
# Missing roster

## Backend
- backlog/foo.md
`,
  )
  const markup = render(missingRosterRoadmap, [missingRosterRoadmap, ...items.slice(1)])
  assert.match(markup, /Mobile UI/, 'the named roster keeps its name')
  assert.match(markup, /\(not found\)/, 'and is marked not found')
  // The store has no saved rosters in this harness, so "No roles" must NOT be
  // what the control reads as — that is the silent fallback this forbids.
  assert.doesNotMatch(
    markup,
    /<span class="">No roles<\/span>/,
    'the control does not silently read as the default',
  )
})


// ---------------------------------------------------------------------------
// Per-step roster on the rows (MC-1882)
// ---------------------------------------------------------------------------

// NOTE on the fixture: this harness renders through renderToStaticMarkup, and
// zustand v5 serves SSR reads from `getInitialState()` — so seeding saved
// rosters with `setState` has NO effect here and every NAMED roster resolves as
// "(not found)". The tone fixture therefore uses the built-in "No roles", which
// is never missing, which also makes the sharper point: the row tone is decided
// by inherited-vs-override, NEVER by the label. A step that deliberately picks
// the same roster the horizon uses is still an override and must still read as
// one.
const PER_STEP_ROADMAP = backlogItem(
  'backlog/roadmaps/staffed.md',
  `---
type: roadmap
status: ready
advance: approve
merge: manual
---
# Staffed roadmap

## Backend
- backlog/foo.md
- backlog/epics/auth.md  @roster=No roles
  - backlog/auth-login.md
`,
)

// Row controls only — the policy-bar control names the whole horizon.
const ROW_ROSTER_LABELS = /aria-label="Roster for (?!every sprint)[^"]*"/g

function renderPerStep(): string {
  return render(PER_STEP_ROADMAP, [PER_STEP_ROADMAP, ...items.slice(1)])
}

run('every step row carries a roster control in the tab order (no hover required)', () => {
  const markup = renderPerStep()
  // Two steps → two row controls, each a real <button> (keyboard reachable and
  // operable without a pointer), plus the policy-bar control.
  const rowTriggers = markup.match(ROW_ROSTER_LABELS) ?? []
  assert.equal(rowTriggers.length, 2, 'one roster control per step row')
  assert.ok(rowTriggers.some((label) => label.includes('Foo')))
  assert.ok(rowTriggers.some((label) => label.includes('Auth')))
})

run('inherited reads QUIETLY, an override stays visible — from the override, not the name', () => {
  const markup = renderPerStep()
  // Both rows resolve to the SAME roster name ("No roles"), so anything that
  // distinguishes them must come from whether the step overrides.
  const rowTriggers = markup.match(ROW_ROSTER_LABELS) ?? []
  assert.ok(rowTriggers.every((label) => label.includes('No roles')))
  // The inherited row is quiet until hover or focus (the MC-1924 density pass),
  // but stays in the tab order — opacity, never `display`.
  assert.match(markup, /text-\[color:var\(--text-subtle\)\] opacity-0/)
  // The override is always visible, so overrides are scannable straight down the
  // track WITHOUT hovering, and it carries no `opacity-0`.
  const override = (markup.match(/class="[^"]*text-\[color:var\(--text-muted\)\][^"]*"/g) ?? []).join(' ')
  assert.ok(override.length > 0, 'the overriding row renders at full strength')
})

run('an inherited row NAMES the horizon roster it falls back to', () => {
  const inheriting = backlogItem(
    'backlog/roadmaps/inheriting.md',
    `---
type: roadmap
status: ready
advance: approve
merge: manual
roster: General agents
---
# Staffed roadmap

## Backend
- backlog/foo.md
`,
  )
  const markup = render(inheriting, [inheriting, ...items.slice(1)])
  const rowTriggers = markup.match(ROW_ROSTER_LABELS) ?? []
  assert.equal(rowTriggers.length, 1)
  assert.match(rowTriggers[0], /General agents/, 'the row shows what it inherits, not a blank')
})

run('an epic step\u2019s children draw no roster control of their own', () => {
  const markup = renderPerStep()
  // The child (Login) is rendered, but only the two STEP rows have controls —
  // the sprint is created per step, not per child.
  assert.match(markup, /Login/)
  assert.equal((markup.match(ROW_ROSTER_LABELS) ?? []).length, 2)
  assert.doesNotMatch(markup, /aria-label="Roster for Login:/)
})

run('a step naming a deleted roster reads "(not found)" on the row itself', () => {
  const deleted = backlogItem(
    'backlog/roadmaps/deleted-step-roster.md',
    `---
type: roadmap
status: ready
advance: approve
merge: manual
---
# Staffed roadmap

## Backend
- backlog/foo.md  @roster=Ghost roster
`,
  )
  const markup = render(deleted, [deleted, ...items.slice(1)])
  assert.match(markup, /Ghost roster/, 'the named roster keeps its name')
  assert.match(markup, /\(not found\)/, 'and the row says so')
  // A DEFINED token: `--status-danger` was never declared in the stylesheet, so
  // the marker that must never read as the default rendered with no colour at all.
  assert.match(markup, /text-\[color:var\(--tone-warn\)\]/)
})

if (failures > 0) {
  console.error(`\n${failures} render smoke checks failed`)
  process.exit(1)
}
