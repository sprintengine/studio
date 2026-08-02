import assert from 'node:assert/strict'
import { buildBacklogSelectionSourcePlan } from './backlogSelectionSourcePlan'
import type { BacklogItem } from '../../utils/backlog'

// MC-2060. The one bundle a multi-selected launch seeds creation with: epics
// expand to their open children exactly as the wizard's epic launch does,
// plain items ride as themselves, plan kinds follow the T3 engine contract
// (`selection`; exactly one epic stays `epic`; exactly one plain item is the
// single-item flow and builds nothing here).

function item(overrides: Partial<BacklogItem> & { relativePath: string }): BacklogItem {
  return {
    id: overrides.relativePath,
    objectId: `obj-${overrides.relativePath}`,
    path: `/project/${overrides.relativePath}`,
    title: overrides.relativePath,
    kind: 'unknown',
    status: 'ready',
    isEpic: false,
    metadata: {},
    links: [],
    excerpt: '',
    modifiedAt: 0,
    createdAtMs: 0,
    size: 0,
    sourceContent: '',
    ...overrides,
  } as BacklogItem
}

const EPIC_AUTH = item({
  relativePath: 'backlog/epics/auth-revamp.md',
  isEpic: true,
  sourceContent: '# Auth revamp\n\nEverything auth.',
})
const CHILD_LOGIN = item({ relativePath: 'backlog/2026-07-01-login.md', epic: 'auth-revamp' })
const CHILD_ARCHIVED = item({
  relativePath: 'backlog/2026-07-02-legacy.md',
  epic: 'auth-revamp',
  status: 'archived',
})
const PLAIN_SEARCH = item({ relativePath: 'backlog/2026-07-03-search.md', title: 'Search' })
const PLAIN_MOCKUP = item({ relativePath: 'backlog/mockups/2026-07-04-screen.html' })
const PROJECT_ITEMS = [EPIC_AUTH, CHILD_LOGIN, CHILD_ARCHIVED, PLAIN_SEARCH, PLAIN_MOCKUP]

// ── a selection of exactly one plain item is the single-item flow ───────────
assert.equal(
  buildBacklogSelectionSourcePlan({
    workspaceRoot: '/project',
    items: [PLAIN_SEARCH],
    projectItems: PROJECT_ITEMS,
  }),
  null,
  'one plain item builds no selection plan — the caller keeps today\'s flow',
)
assert.equal(
  buildBacklogSelectionSourcePlan({ workspaceRoot: '/project', items: [], projectItems: [] }),
  null,
  'an empty selection builds nothing',
)

// ── a selection of exactly one epic is the epic launch, unchanged ───────────
{
  const plan = buildBacklogSelectionSourcePlan({
    workspaceRoot: '/project',
    items: [EPIC_AUTH],
    projectItems: PROJECT_ITEMS,
  })
  assert.ok(plan)
  assert.equal(plan.sourcePlanKind, 'epic', 'exactly one epic stays planKind epic')
  assert.equal(plan.sourceRelativePath, 'backlog/epics/auth-revamp.md', 'the epic is the root')
  assert.equal(plan.goal, 'Auth revamp', 'goal is the epic title')
  assert.deepEqual(
    plan.sourceBundle?.map((entry) => [entry.sourceRelativePath, entry.epicChild ?? false]),
    [['backlog/2026-07-01-login.md', true]],
    'the bundle is the OPEN children, each marked epicChild — archived stay out',
  )
}

// ── a mixed selection seeds one `selection` bundle ───────────────────────────
{
  const plan = buildBacklogSelectionSourcePlan({
    workspaceRoot: '/project',
    items: [PLAIN_SEARCH, EPIC_AUTH, PLAIN_MOCKUP],
    projectItems: PROJECT_ITEMS,
  })
  assert.ok(plan)
  assert.equal(plan.sourcePlanKind, 'selection')
  assert.equal(plan.folderPath, '/project')
  assert.equal(
    plan.sourceRelativePath,
    'backlog/2026-07-03-search.md',
    'the anchor (first selected row) is the root source',
  )
  assert.equal(plan.goal, 'Deliver 3 selected backlog items')
  assert.deepEqual(
    plan.sourceBundle?.map((entry) => ({
      path: entry.sourceRelativePath,
      kind: entry.kind,
      epicChild: entry.epicChild ?? false,
      selectedItem: entry.selectedItem ?? false,
    })),
    [
      // The anchor is selected work like any other — it rides the bundle too.
      { path: 'backlog/2026-07-03-search.md', kind: 'generic_context', epicChild: false, selectedItem: true },
      // A selected epic is a membership scope (kind `epic`), never a work entry…
      { path: 'backlog/epics/auth-revamp.md', kind: 'epic', epicChild: false, selectedItem: false },
      // …and contributes its open children as epicChild work entries.
      { path: 'backlog/2026-07-01-login.md', kind: 'generic_context', epicChild: true, selectedItem: false },
      // A selected mockup file keeps its honest kind; work-ness is the marker.
      { path: 'backlog/mockups/2026-07-04-screen.html', kind: 'html_mockup', epicChild: false, selectedItem: true },
    ],
  )
}

// ── an epic AND its own child selected together dedupe to one entry ─────────
{
  const plan = buildBacklogSelectionSourcePlan({
    workspaceRoot: '/project',
    items: [CHILD_LOGIN, EPIC_AUTH],
    projectItems: PROJECT_ITEMS,
  })
  assert.ok(plan)
  const loginEntries = plan.sourceBundle?.filter(
    (entry) => entry.sourceRelativePath === 'backlog/2026-07-01-login.md',
  )
  assert.equal(loginEntries?.length, 1, 'a doubly-reachable item rides the bundle once')
  assert.equal(
    loginEntries?.[0].selectedItem,
    true,
    'it keeps the marker of its first appearance; init re-settles the flavor from frontmatter',
  )
}

// ── two epics: each is a scope, children never cross ─────────────────────────
{
  const EPIC_BILLING = item({
    relativePath: 'backlog/epics/billing.md',
    isEpic: true,
    sourceContent: '# Billing',
  })
  const CHILD_INVOICE = item({ relativePath: 'backlog/2026-07-05-invoice.md', epic: 'billing' })
  const plan = buildBacklogSelectionSourcePlan({
    workspaceRoot: '/project',
    items: [EPIC_AUTH, EPIC_BILLING],
    projectItems: [...PROJECT_ITEMS, EPIC_BILLING, CHILD_INVOICE],
  })
  assert.ok(plan)
  assert.equal(plan.sourcePlanKind, 'selection', 'two epics are a selection, not an epic launch')
  assert.deepEqual(
    plan.sourceBundle?.map((entry) => entry.sourceRelativePath),
    [
      'backlog/epics/auth-revamp.md',
      'backlog/2026-07-01-login.md',
      'backlog/epics/billing.md',
      'backlog/2026-07-05-invoice.md',
    ],
    'each epic contributes itself then its own open children, in selection order',
  )
}

console.log('backlogSelectionSourcePlan tests passed')
