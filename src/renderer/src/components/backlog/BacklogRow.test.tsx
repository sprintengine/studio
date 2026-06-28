import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'

import { BacklogRowContent } from './BacklogRow'
import { createBacklogItem, type BacklogHighlight } from '../../utils/backlog'
import { compareBacklogItems, type BacklogSort } from '../../utils/backlogTriage'

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

// Real hydration path: highlight reaches the row the same way the panel and the
// new-workspace source picker hand it over — from the object record, never
// frontmatter.
function itemWith(highlight?: BacklogHighlight, relativePath = 'backlog/checkout.md') {
  return createBacklogItem({
    path: `/repo/${relativePath}`,
    relativePath,
    sourceContent: '# Checkout flow\n\nRework the payment step.',
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
    object: highlight
      ? { objectId: 'obj_checkout', metadata: {}, links: [], highlight }
      : { objectId: 'obj_checkout', metadata: {}, links: [] },
  })
}

const NOW = 10_000

run('starred row renders the filled --tone-warn star trailing the title, named "Starred"', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={itemWith({ starred: true, color: 'amber' })} now={NOW} />,
  )
  assert.match(markup, /aria-label="Starred"/, 'the star carries its accessible name')
  assert.match(markup, /<title>Starred<\/title>/, 'the svg also carries a title for AT')
  assert.match(markup, /--tone-warn/, 'the star uses the warn tone, matching the sidebar star')
  const titleAt = markup.indexOf('Checkout flow')
  const starAt = markup.indexOf('aria-label="Starred"')
  assert.ok(titleAt >= 0 && starAt > titleAt, 'the star trails the title, not leads it')
})

run('unstarred rows render no star element at all — the mark is earned', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!markup.includes('Starred'), 'no placeholder star, no outline variant')

  const colorOnly = renderToStaticMarkup(
    <BacklogRowContent item={itemWith({ starred: false, color: 'blue' })} now={NOW} />,
  )
  assert.ok(!colorOnly.includes('Starred'), 'a color-only highlight earns no star either')
})

run('the shared row interior keeps its columns with the star present (panel + source picker)', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={itemWith({ starred: true, color: 'pink' })} now={NOW} />,
  )
  // The same interior renders in the Backlog panel list and the new-workspace
  // source picker; every at-rest column must survive the trailing star.
  assert.match(markup, /Checkout flow/, 'title renders')
  assert.match(markup, /aria-label="Size unestimated"/, 'size column intact')
  assert.match(markup, /aria-label="No priority set"/, 'priority column intact')
  assert.match(markup, /Rework the payment step\./, 'excerpt line intact')
})

run('star and color never affect list order — comparator ignores highlight for every sort', () => {
  const plainA = itemWith(undefined, 'backlog/a.md')
  const plainB = itemWith(undefined, 'backlog/b.md')
  const markedA = { ...plainA, highlight: { starred: true, color: 'red' } as BacklogHighlight }
  const sorts: BacklogSort[] = ['recent', 'priority', 'largest', 'smallest']
  for (const sort of sorts) {
    assert.equal(
      compareBacklogItems(markedA, plainB, sort),
      compareBacklogItems(plainA, plainB, sort),
      `starring must not move a row under the '${sort}' sort`,
    )
  }
})

// Source contracts, in the spirit of backlog.test.ts: the panel-side wiring the
// static render above cannot reach (store-bound list + detail surfaces).
const backlogPanelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/BacklogPanel.tsx'),
  'utf8',
)
const sourcePickerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/NewWorkspacePanel.tsx'),
  'utf8',
)
const contextMenuSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogItemContextMenu.tsx'),
  'utf8',
)

run('panel rows resolve the stripe color (manual highlight over derived risk) through the shared swatch', () => {
  assert.match(
    backlogPanelSource,
    /resolveBacklogStripeColor\(item\)/,
    'stripe color resolves via the shared helper so a manual highlight wins over the derived risk heat',
  )
  assert.match(
    backlogPanelSource,
    /getHighlightSwatch\(stripeColor\)/,
    'stripe classes come from utils/highlight, not duplicated hexes',
  )
  assert.match(
    backlogPanelSource,
    /litFill && swatch \? swatch\.bg/,
    'only a hand-set highlight (litFill) lights the full row; a derived risk color tints the stripe alone',
  )
})

run('the Group axis is wired to the filter menu and persisted, defaulting to a flat no-op', () => {
  // The Group control rides the same FilterMenu plumbing as view/sort.
  assert.match(backlogPanelSource, /group=\{group\}/, 'filter menu receives the group axis')
  assert.match(backlogPanelSource, /groupItems=\{GROUP_ITEMS\}/, 'filter menu receives the group options')
  assert.match(backlogPanelSource, /onGroupChange=\{setGroup\}/, 'changing the group updates panel state')
  // group is persisted alongside view/sort, and 'none' is part of the default
  // baseline so an untouched panel never writes a record.
  assert.match(backlogPanelSource, /group: snapshot\.group/, 'group is persisted in the view-state record')
  assert.match(backlogPanelSource, /snapshot\.group === 'none'/, "default baseline keeps group at 'none'")
  // Grouping off ⇒ groupedRows is null ⇒ the flat list path renders unchanged.
  assert.match(
    backlogPanelSource,
    /if \(group !== 'by_epic'\) return null/,
    'group=none short-circuits to the flat (byte-identical) list',
  )
})

run('grouped render and cross-group selection run through the flattened nav order', () => {
  // The list branches to the grouped render only when groupedRows is present.
  assert.match(backlogPanelSource, /groupedRows\s*\n?\s*\?\s*groupedRows\.map/, 'grouped branch renders the flattened rows')
  assert.match(backlogPanelSource, /<BacklogGroupHeaderRow/, 'group headers render as their own rows')
  assert.match(backlogPanelSource, /indented\b/, 'grouped children render the shared option row, indented')
  // One nav order drives both j/k and aria-activedescendant across groups.
  assert.match(
    backlogPanelSource,
    /navOrder\.indexOf\(selectedId\)/,
    'keyboard navigation indexes the flattened header+child order',
  )
  assert.match(
    backlogPanelSource,
    /backlog-opt-\$\{activeIndex\}/,
    'aria-activedescendant points at the active option in the flattened order',
  )
  // Enter on a header collapses; on a leaf it opens detail — selection crosses
  // group boundaries without special-casing the leaves.
  assert.match(
    backlogPanelSource,
    /currentRow\?\.kind === 'header'/,
    'Enter/Arrow toggles a header, otherwise opens the leaf detail',
  )
})

run('row context menu exposes Move to epic — assign, New epic…, and Remove from epic', () => {
  // The flyout lists existing epics (assign) and offers create + remove, hidden
  // on epic rows (no nesting).
  assert.match(contextMenuSource, /label="Move to epic"/, 'context menu has a Move to epic flyout')
  assert.match(contextMenuSource, /!item\.isEpic \?/, 'the flyout is hidden on epic rows (no nesting)')
  assert.match(contextMenuSource, /actions\.setEpic\(item, epic\.slug\)/, 'selecting an epic assigns it by slug')
  assert.match(contextMenuSource, /actions\.createEpic\(item\)/, 'New epic… routes through the create handler')
  assert.match(contextMenuSource, /actions\.setEpic\(item, null\)/, 'Remove from epic clears the field')
  assert.match(contextMenuSource, /item\.epic \?/, 'Remove from epic shows only when the item has an epic')
})

run('epic assignment mutates only the child frontmatter via update/create-epic, not items.json', () => {
  // setEpic → backlog:update-epic (frontmatter only); create → create-epic writer
  // then assign. items.json is never written for epic membership.
  assert.match(backlogPanelSource, /window\.api\.updateBacklogEpic\(\{/, 'setEpic mutates through the update-epic IPC')
  assert.match(backlogPanelSource, /window\.api\.createBacklogEpic\(\{ workspaceRoot: folderPath, title \}\)/, 'New epic uses the create-epic writer')
  assert.match(
    backlogPanelSource,
    /epic: created\.slug/,
    'a freshly created epic is then assigned to the item by its returned slug',
  )
  assert.match(
    backlogPanelSource,
    /setEpic: \(item, slug\) => void setItemEpic\(item, slug\)/,
    'setEpic sits in BacklogActions so the menu and detail share one path',
  )
})

run('detail triage exposes an Epic control wired to the same assign/create/remove handlers', () => {
  assert.match(backlogPanelSource, /ariaLabel="Move to epic"/, 'detail pane has an Epic select')
  assert.match(backlogPanelSource, /value === EPIC_NEW_SENTINEL/, 'the New epic… sentinel opens the create flow')
  assert.match(
    backlogPanelSource,
    /actions\.setEpic\(item, value === EPIC_NONE_VALUE \? null : value\)/,
    'No epic clears the field; an epic value assigns it',
  )
})

run('archive epic rolls up children: menu + overflow swap Archive→Archive epic for epic items', () => {
  // Context menu: epic rows get "Archive epic", leaves keep "Archive".
  assert.match(contextMenuSource, /item\.isEpic \? \(/, 'the Archive item branches on isEpic')
  assert.match(contextMenuSource, /actions\.archiveEpic\(item\)/, 'epic rows archive via the rollup handler')
  // Detail overflow: same epic-aware swap.
  assert.match(
    backlogPanelSource,
    /selected\.isEpic\s*\n?\s*\?\s*\[\{ id: 'archive-epic', label: 'Archive epic'/,
    'detail overflow offers Archive epic for an epic',
  )
})

run('archiveEpicRollup archives children then the epic via the plan + shared archive-move, re-pointing on collision', () => {
  // childrenOfEpic gives the rollup set; planEpicArchive resolves collision-safe
  // targets + the re-point decision; each member moves through the one shared
  // moveItemToArchive helper (no new archive mechanism).
  assert.match(
    backlogPanelSource,
    /childrenOfEpic\(items, epicSlug\(epic\)\)\.filter\(\(child\) => child\.status !== 'archived'\)/,
    'the rollup set is the epic’s active children',
  )
  assert.match(
    backlogPanelSource,
    /planEpicArchive\(epic, children, archivedRelativePaths\(\)\)/,
    'the collision-safe targets + re-point plan come from the pure planner',
  )
  assert.match(
    backlogPanelSource,
    /if \(move\.repointEpic !== null\)/,
    'on a collision rename, each child is re-pointed to the epic’s new stem before its move',
  )
  assert.match(
    backlogPanelSource,
    /await moveItemToArchive\(move\.item, move\.archivedRel\)/,
    'each child uses the shared archive-move helper',
  )
  assert.match(
    backlogPanelSource,
    /await moveItemToArchive\(epic, plan\.epicArchivedRel\)/,
    'the epic is archived last (children first → recoverable on mid-batch failure)',
  )
  assert.match(backlogPanelSource, /archiveEpic: \(item\) => void archiveEpicRollup\(item\)/, 'archiveEpic sits in shared BacklogActions')
  // In the Archived lens an epic group defaults collapsed so it reads as one
  // rolled-up unit, not N loose archived child rows.
  assert.match(
    backlogPanelSource,
    /view === 'archived' && epicGroup\.kind === 'epic'/,
    'archived epic groups roll up collapsed by default',
  )
})

run('detail overflow menu carries Star/Unstar through the persisted highlight handler', () => {
  assert.match(
    backlogPanelSource,
    /selected\.highlight\?\.starred \? 'Unstar' : 'Star'/,
    'menu label flips with the persisted starred state',
  )
  assert.match(
    backlogPanelSource,
    /window\.api\.updateBacklogHighlight\(/,
    'the handler mutates through the backlog:update-highlight IPC, not renderer state',
  )
  assert.match(
    backlogPanelSource,
    /setHighlight: \(item, highlight\) => void setItemHighlight\(item, highlight\)/,
    'setHighlight sits in BacklogActions so the context-menu task can reuse it',
  )
})

run('the new-workspace source picker renders the same shared row interior', () => {
  assert.match(
    sourcePickerSource,
    /<BacklogRowContent item=\{item\} now=\{now\} \/>/,
    'the picker composes BacklogRowContent, so the marks flow in without a fork',
  )
})

if (failures > 0) {
  console.error(`BacklogRow.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('BacklogRow.test.tsx: ok')
