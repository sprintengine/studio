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

function render(): string {
  return renderToStaticMarkup(
    <ConfirmDialogProvider>
      <RoadmapEditorPanel
        roadmapItem={roadmapItem}
        items={items}
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

run('renders an epic entry with its snapshotted child and item count', () => {
  const markup = render()
  assert.match(markup, /Auth/)
  assert.match(markup, /Login/)
  assert.match(markup, /1 item/)
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

if (failures > 0) {
  console.error(`\n${failures} render smoke checks failed`)
  process.exit(1)
}
