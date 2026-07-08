import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'

import { BacklogRowContent } from './BacklogRow'
import { BacklogDependenciesSection } from './BacklogDependenciesSection'
import type { BacklogActions } from './BacklogItemContextMenu'
import { filterBacklogItemSearchOptions } from './BacklogItemSearchPicker'
import { createBacklogItem, type BacklogHighlight, type BacklogItem } from '../../utils/backlog'
import { compareBacklogItems, type BacklogSort } from '../../utils/backlogTriage'
import { deriveBacklogDependencies } from '../../utils/backlogDependencies'

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
  // The excerpt was intentionally dropped from the row — at list width it only
  // showed a few clipped words, so the space now goes to the full-width title.
  assert.ok(!markup.includes('Rework the payment step.'), 'no excerpt on the row anymore')
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

// ---- Waiting badge + detail dependencies (T4) ------------------------------

run('a waiting row renders the non-color-only "Waiting" badge with one accessible name', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} isWaiting />)
  // The word — not color — carries the meaning, and the whole token reads as one
  // accessible name (so a screen reader announces it, not a bare glyph).
  assert.match(markup, /aria-label="Waiting on prerequisites"/, 'the badge carries one accessible name')
  assert.match(markup, />Waiting<\/span>|Waiting/, 'the visible word "Waiting" is present')
})

run('a non-waiting row renders no Waiting badge — the marker is earned', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!markup.includes('Waiting on prerequisites'), 'no badge when isWaiting is unset')
})

// ---- Parent-epic pill (flat-list member badge) -----------------------------

run('a member row given epicMeta renders the epic pill: id label + title tooltip/name', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent
      item={itemWith()}
      now={NOW}
      epicMeta={{ title: 'Module SDK v2', color: 'blue', displayId: 'MC-1493' }}
    />,
  )
  // The visible label is the epic's display id; the full title is the accessible
  // name (and the hover tooltip), so it reads "relates to epic <title>".
  assert.match(markup, /MC-1493/, 'the pill is labelled with the epic display id')
  assert.match(markup, /aria-label="Epic: Module SDK v2"/, 'the epic title is the accessible name')
})

run('the epic pill falls back to the epic title when no display id is allocated', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={itemWith()} now={NOW} epicMeta={{ title: 'Untitled Epic', color: null }} />,
  )
  assert.match(markup, /Untitled Epic/, 'the title stands in as the label when there is no id')
})

run('a row without epicMeta renders no epic pill — the badge is earned', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!markup.includes('aria-label="Epic:'), 'no epic pill when the item has no parent epic')
})

// Build a real BacklogItem with status + dependsOn frontmatter so the detail
// section is exercised against the same derivation the panel uses.
function depItem(relativePath: string, opts: { status?: string; dependsOn?: string[] } = {}): BacklogItem {
  const lines: string[] = []
  if (opts.status) lines.push(`status: ${opts.status}`)
  if (opts.dependsOn?.length) lines.push(`dependsOn: ${opts.dependsOn.join(', ')}`)
  const front = lines.length ? `---\n${lines.join('\n')}\n---\n` : ''
  return createBacklogItem({
    path: `/repo/${relativePath}`,
    relativePath,
    sourceContent: `${front}# ${relativePath}`,
    stats: { modifiedAtMs: 1, sizeBytes: 1 },
  })
}

const noopActions = {} as BacklogActions

function depSection(items: BacklogItem[], selectedPath: string): string {
  const graph = deriveBacklogDependencies(items)
  const selected = items.find((item) => item.relativePath === selectedPath)
  if (!selected) throw new Error(`no item ${selectedPath}`)
  return renderToStaticMarkup(
    <BacklogDependenciesSection
      item={selected}
      node={graph.byItemId.get(selected.id) ?? null}
      dependencyChoices={items.map((item) => ({ id: item.id, slug: item.relativePath.replace(/^.*\//, '').replace(/\.md$/, ''), title: item.title }))}
      actions={noopActions}
      onNavigate={() => {}}
    />,
  )
}

run('detail Prerequisites: an unresolved prerequisite renders its title + status word and is navigable', () => {
  const items = [
    depItem('backlog/a.md', { status: 'in_progress' }),
    depItem('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const markup = depSection(items, 'backlog/b.md')
  assert.match(markup, /Prerequisites/, 'the Prerequisites subsection renders')
  assert.match(markup, /backlog\/a\.md/, 'the prerequisite target title shows')
  assert.match(markup, /In progress/, 'the prerequisite status word shows')
  assert.match(markup, /<button[^>]*>/, 'the prerequisite is a navigable control')
})

run('detail Blocks: an item shows the items it blocks (reverse edge)', () => {
  const items = [
    depItem('backlog/a.md', { status: 'idea' }),
    depItem('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const markup = depSection(items, 'backlog/a.md')
  assert.match(markup, /Blocks/, 'the Blocks subsection renders')
  assert.match(markup, /backlog\/b\.md/, 'the blocked dependent shows')
})

run('detail dangling prerequisite renders as an Unknown note, not silently dropped', () => {
  const items = [depItem('backlog/b.md', { status: 'idea', dependsOn: ['ghost'] })]
  const markup = depSection(items, 'backlog/b.md')
  assert.match(markup, /ghost/, 'the dangling slug is shown')
  assert.match(markup, /Unknown/, 'the dangling prerequisite reads as Unknown')
  assert.match(markup, /role="note"/, 'a dangling slug is a non-actionable note')
})

run('detail cycle warning shows when the selected item is in a dependency cycle', () => {
  const items = [
    depItem('backlog/a.md', { status: 'idea', dependsOn: ['b'] }),
    depItem('backlog/b.md', { status: 'idea', dependsOn: ['a'] }),
  ]
  const markup = depSection(items, 'backlog/a.md')
  assert.match(markup, /dependency cycle/, 'a non-fatal cycle warning renders')
})

run('detail dependency editor offers a "Depends on…" control', () => {
  const items = [
    depItem('backlog/a.md', { status: 'idea' }),
    depItem('backlog/b.md', { status: 'idea' }),
  ]
  const markup = depSection(items, 'backlog/b.md')
  assert.match(markup, /Depends on…/, 'the add/remove editor is reachable from the detail pane')
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
const dependenciesSectionSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogDependenciesSection.tsx'),
  'utf8',
)
const itemSearchPickerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogItemSearchPicker.tsx'),
  'utf8',
)

run('panel rows resolve the row color (highlight ▸ epic ▸ derived risk) through the shared swatch', () => {
  assert.match(
    backlogPanelSource,
    /resolveBacklogRowColor\(item, epicMeta\?\.color \?\? null\)/,
    'row color resolves via the shared helper, factoring the epic identity colour between the manual highlight and the derived risk heat',
  )
  assert.match(
    backlogPanelSource,
    /getHighlightSwatch\(stripeColor\)/,
    'stripe classes come from utils/highlight, not duplicated hexes',
  )
  assert.match(
    backlogPanelSource,
    /litFill && swatch \? swatch\.bg/,
    'a hand-set highlight or an epic colour (litFill) lights the full row; a derived risk color tints the stripe alone',
  )
})

run('the Group axis is wired to the filter menu and is project-scoped, defaulting to a flat no-op', () => {
  // The Group control rides the same FilterMenu plumbing as view/sort.
  assert.match(backlogPanelSource, /group=\{group\}/, 'filter menu receives the group axis')
  assert.match(backlogPanelSource, /groupItems=\{GROUP_ITEMS\}/, 'filter menu receives the group options')
  assert.match(backlogPanelSource, /onGroupChange=\{handleGroupChange\}/, 'changing the group updates panel state')
  // The lens/sort/group are PROJECT-scoped (shared + live-synced across every
  // workspace on the project) via the backlog view store — not persisted in the
  // per-workspace record — so two windows on one project read one backlog.
  assert.match(
    backlogPanelSource,
    /setProjectView\(folderPath, \{ group: next \}\)/,
    'the group change writes to the project-scoped view store',
  )
  assert.match(
    backlogPanelSource,
    /selectBacklogProjectView\(state, folderPath\)/,
    'the lens/sort/group are read from the shared project view store',
  )
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

run('row context menu exposes search-first Move to epic — assign, create, and remove', () => {
  assert.match(contextMenuSource, /label="Move to epic"/, 'context menu has a Move to epic flyout')
  assert.match(contextMenuSource, /!item\.isEpic \?/, 'the flyout is hidden on epic rows (no nesting)')
  assert.match(contextMenuSource, /ariaLabel="Search epics"/, 'the full epic catalogue is replaced by a search field')
  assert.match(contextMenuSource, /actions\.setEpic\(item, epic\.value\)/, 'selecting a real search result assigns it by slug')
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

run('detail triage exposes the same search-first Epic control and handlers', () => {
  assert.match(backlogPanelSource, /ariaLabel="Move to epic"/, 'detail pane has an Epic select')
  assert.match(backlogPanelSource, /ariaLabel="Search epics"/, 'the detail Epic control searches instead of listing every epic')
  assert.match(backlogPanelSource, /actions\.setEpic\(item, epic\.value\)/, 'a real result assigns the epic')
  assert.match(backlogPanelSource, /actions\.createEpic\(item\)/, 'New epic opens the create flow')
  assert.match(backlogPanelSource, /actions\.setEpic\(item, null\)/, 'Remove from epic clears the field')
})

run('the detail More-actions menu carries the Size/Priority/Risk/Status triage flyouts', () => {
  for (const id of ['set-status', 'set-priority', 'set-size', 'set-risk']) {
    assert.match(backlogPanelSource, new RegExp(`id: '${id}'`), `${id} flyout present in the detail menu`)
  }
  assert.match(backlogPanelSource, /kind: 'flyout' as const,/, 'the triage editors are flyout submenus')
  // Each choice routes through the shared BacklogActions setters, then closes the
  // whole overflow menu — the same handlers the row right-click menu uses.
  assert.match(backlogPanelSource, /actions\.setStatus\(selected, status\)\s*\n\s*close\(\)/, 'status choice applies + closes')
  assert.match(backlogPanelSource, /actions\.setDifficulty\(selected, value\)\s*\n\s*close\(\)/, 'size choice applies + closes')
  assert.match(backlogPanelSource, /actions\.setCriticality\(selected, value\)\s*\n\s*close\(\)/, 'priority choice applies + closes')
  assert.match(backlogPanelSource, /actions\.setRisk\(selected, value\)\s*\n\s*close\(\)/, 'risk choice applies + closes')
})

run('the triage editors no longer render as inline body Selects', () => {
  // Size/Priority/Risk moved to the menu; the detail body keeps only the Epic
  // control, so the inline <Select> editors are gone.
  assert.ok(!backlogPanelSource.includes('items={DIFFICULTY_EDIT_ITEMS}'), 'no inline Size select in the body')
  assert.ok(!backlogPanelSource.includes('items={CRITICALITY_EDIT_ITEMS}'), 'no inline Priority select in the body')
  assert.ok(!backlogPanelSource.includes('items={RISK_EDIT_ITEMS}'), 'no inline Risk select in the body')
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
  // In a terminal lens (Completed or Archived) an epic group defaults collapsed
  // so it reads as one rolled-up unit, not N loose finished child rows.
  assert.match(
    backlogPanelSource,
    /\(view === 'archived' \|\| view === 'completed'\) && epicGroup\.kind === 'epic'/,
    'terminal-lens epic groups roll up collapsed by default',
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

run('Dependency order is a whole-list topo branch, not a pairwise comparator', () => {
  // The sort option exists and the filtered memo branches around
  // compareBacklogItems to the full-graph topo order, restricted to visible rows.
  assert.match(backlogPanelSource, /value: 'dependency', label: 'Dependency order'/, 'the sort control gains Dependency order')
  assert.match(backlogPanelSource, /deriveBacklogDependencies\(items\)/, 'the graph derives over the full scan, not the filtered view')
  assert.match(backlogPanelSource, /if \(sort === 'dependency'\)/, 'the panel branches on the dependency sort')
  assert.match(
    backlogPanelSource,
    /dependencyGraph\.order\.filter\(\(item\) => visible\.has\(item\.id\)\)/,
    'dependency order is the topo order kept to the visible rows',
  )
})

run('detail cross-navigation widens the lens so a filtered-out target never dead-clicks', () => {
  // Prerequisite/Blocks activation routes through navigateToBacklogItem, not the
  // plain row-select: the detail `selected` resolves only within `filtered`, so a
  // target hidden by the active lens/search (always for a terminal item — the
  // default Active lens hides completed/archived) would be dropped by the
  // validity effect.
  assert.match(backlogPanelSource, /onNavigate=\{navigateToBacklogItem\}/, 'the detail section navigates through the widening handler')
  assert.match(
    backlogPanelSource,
    /!filtered\.some\(\(item\) => item\.id === id\)/,
    'it only widens when the target is not already visible (preserves the active lens otherwise)',
  )
  assert.match(
    backlogPanelSource,
    /setProjectView\(folderPath, \{ view: lensForItemStatus\(target\.status\) \}\)/,
    'a hidden target widens to a lens that contains it (Completed/Archived for terminal items, else Active)',
  )
  assert.match(backlogPanelSource, /setSearch\(''\)/, 'the search is cleared so the navigated row stays visible')
  // Epic <-> child links are cross-navigation too: a completed child under the
  // Active lens (or the parent epic of a filtered row) sits outside `filtered`,
  // so both must route through the same widening handler — a plain row-select
  // dead-clicks back to the bare list.
  assert.match(backlogPanelSource, /onClick=\{\(\) => onNavigate\(parentEpic\.id\)\}/, 'the child -> parent-epic crumb navigates through the widening handler')
  assert.match(backlogPanelSource, /onClick=\{\(\) => onNavigate\(child\.id\)\}/, 'the epic -> child roll-up rows navigate through the widening handler')
  assert.ok(!backlogPanelSource.includes('onSelectItem'), 'the detail pane has no plain-select escape hatch; all its cross-navigation widens')
})

run('the row waiting badge is derived (never persisted) and wired through the list', () => {
  assert.match(backlogPanelSource, /node\.isWaiting/, 'the waiting map reads the derived isWaiting flag')
  assert.match(backlogPanelSource, /isWaiting=\{waitingById\?\.get\(item\.id\)\}/, 'rows receive their derived waiting state')
  // Never a frontmatter/object field — purely derived, like runGlyphById.
  assert.ok(!/updateBacklog\w*[Ww]aiting/.test(backlogPanelSource), 'waiting is never persisted')
})

run('prerequisites persist only through the dependsOn frontmatter IPC, never items.json', () => {
  assert.match(backlogPanelSource, /window\.api\.updateBacklogDependencies\(\{/, 'setDependencies mutates through the update-dependencies IPC')
  assert.match(
    backlogPanelSource,
    /setDependencies: \(item, slugs\) => void setItemDependencies\(item, slugs\)/,
    'setDependencies sits in BacklogActions so the menu and detail share one path',
  )
})

run('context menu exposes a search-first multi-select "Depends on…" flyout', () => {
  assert.match(contextMenuSource, /label="Depends on…"/, 'context menu has a Depends on… flyout')
  assert.match(contextMenuSource, /candidate\.id !== item\.id/, 'the item itself is excluded from candidates')
  assert.match(contextMenuSource, /ariaLabel="Search prerequisite items"/, 'opening the flyout does not render the full Backlog')
  assert.match(contextMenuSource, /toggleDependencySlug\(dependsOn, candidate\.value\)/, 'only a real search result can toggle one slug')
  assert.match(contextMenuSource, /selectedValues=\{dependsOn\}/, 'current prerequisites are passed to the shared picker')
})

run('detail dependencies use the shared search picker and exclude self', () => {
  assert.match(dependenciesSectionSource, /Depends on…/, 'the detail editor mirrors the menu affordance')
  assert.match(dependenciesSectionSource, /candidate\.id !== item\.id/, 'the editor excludes the item itself')
  assert.match(dependenciesSectionSource, /ariaLabel="Search prerequisite items"/, 'the detail editor is search-first too')
  assert.match(dependenciesSectionSource, /selectedValues=\{dependsOn\}/, 'the editor reflects current prerequisites through the picker')
  assert.match(itemSearchPickerSource, /aria-selected=\{resultRole === 'listbox' \? checked : undefined\}/, 'dialog-hosted search results expose selected prerequisites accessibly')
  assert.match(dependenciesSectionSource, /const \{ prerequisites, blocks, inCycle \} = node/, 'the section renders the derived prerequisites, blocks, and cycle flag')
  assert.match(dependenciesSectionSource, /dependency cycle/, 'a non-fatal cycle warning is rendered from inCycle')
})

run('relationship search requires a query and matches human-facing Backlog IDs', () => {
  const choices = [
    { id: 'a', value: 'checkout', title: 'Checkout flow', displayId: 'MC-1434' },
    { id: 'b', value: 'billing', title: 'Billing cleanup', displayId: 'MC-1435' },
  ]
  assert.deepEqual(filterBacklogItemSearchOptions(choices, ''), [], 'an empty query never dumps the full Backlog')
  assert.deepEqual(filterBacklogItemSearchOptions(choices, 'mc-1434').map((choice) => choice.id), ['a'])
  assert.deepEqual(filterBacklogItemSearchOptions(choices, 'billing').map((choice) => choice.id), ['b'])
  assert.deepEqual(filterBacklogItemSearchOptions(choices, 'MC-9999'), [], 'an unknown code cannot create a free-form relationship')
})

run('row context menu reuses module-contributed Sprint actions', () => {
  assert.match(backlogPanelSource, /externalActionsForItem\(menuItem\)/, 'the exact row is resolved through the shared module action registry')
  assert.match(contextMenuSource, /itemActions\.map\(\(itemAction\)/, 'visible module actions render in the row menu')
  assert.match(contextMenuSource, /itemAction\.run\(\)/, 'activation uses the existing action run path')
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
