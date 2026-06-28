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
