import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'

import { BacklogRowContent, BacklogRowHoverCard } from './BacklogRow'
import { backlogRowPaintClass } from './backlogRowPaint'
import { getHighlightSwatch } from '../../utils/highlight'
import { BacklogDependenciesSection } from './BacklogDependenciesSection'
import { BacklogMockupsSection } from './BacklogMockupsSection'
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

// The epic ordering mark (MC-2137). The row is where an epic whose ordering was
// never declared finished becomes visible, before any sprint dialog is opened.
function orderingEpicItem(frontmatter: string[], status = 'ready'): BacklogItem {
  return createBacklogItem({
    path: '/repo/backlog/epics/auth.md',
    relativePath: 'backlog/epics/auth.md',
    sourceContent: `---\ntype: epic\nstatus: ${status}\n${frontmatter.join('\n')}\n---\n# Auth revamp`,
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
  })
}

run('an epic that never declared its ordering done carries the small unordered mark', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={orderingEpicItem([])} now={NOW} />)
  assert.match(markup, /Order not planned/, 'the words carry the meaning, never colour alone')
  assert.match(markup, /a sprint from this epic plans first/, 'the mark says what it changes')
  assert.match(markup, /--text-muted/, 'muted metadata, deliberately not a status tone')
})

run('a marked epic, a leaf item, and a finished epic carry no mark', () => {
  const marked = renderToStaticMarkup(
    <BacklogRowContent item={orderingEpicItem(['dependenciesPlanned: true'])} now={NOW} />,
  )
  assert.ok(!marked.includes('Order not planned'), 'the marked epic is simply ready')

  const leaf = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!leaf.includes('Order not planned'), 'ordering is an epic question only')

  for (const status of ['completed', 'archived']) {
    const done = renderToStaticMarkup(<BacklogRowContent item={orderingEpicItem([], status)} now={NOW} />)
    assert.ok(!done.includes('Order not planned'), `a ${status} epic has no ordering left to plan`)
  }
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
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={itemWith()} now={NOW} dependencyState="waiting" />,
  )
  // The word — not color — carries the meaning, and the whole token reads as one
  // accessible name (so a screen reader announces it, not a bare glyph).
  assert.match(markup, /aria-label="Waiting on prerequisites"/, 'the badge carries one accessible name')
  assert.match(markup, />Waiting<\/span>|Waiting/, 'the visible word "Waiting" is present')
})

run('a non-waiting row renders no Waiting badge — the marker is earned', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!markup.includes('Waiting on prerequisites'), 'no badge when dependencyState is unset')
  assert.ok(!markup.includes('Blocked by prerequisites'), 'no blocked badge either')
})

run('a blocked row presents as Blocked, never Ready: glyph, tooltip word, and badge', () => {
  // A stored `ready` gated by unresolved prerequisites: the readiness claim is
  // falsified, so nothing on the row may say Ready.
  const ready = createBacklogItem({
    path: '/repo/backlog/gated.md',
    relativePath: 'backlog/gated.md',
    sourceContent: '---\nstatus: ready\ndependsOn: other\n---\n# Gated item',
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
  })
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={ready} now={NOW} dependencyState="blocked" />,
  )
  assert.match(markup, /aria-label="Blocked by prerequisites"/, 'the badge carries one accessible name')
  assert.match(markup, /Blocked/, 'the visible word "Blocked" is present')
  assert.ok(!markup.includes('>Ready<'), 'the status tooltip no longer claims Ready')
  assert.ok(!markup.includes('Waiting on prerequisites'), 'blocked replaces the softer waiting badge')
  // The hover card agrees with the row.
  const card = renderToStaticMarkup(<BacklogRowHoverCard item={ready} dependencyState="blocked" />)
  assert.match(card, /Blocked/, 'the hover card shows Blocked')
  assert.ok(!card.includes('Ready'), 'the hover card never claims Ready')
})

run('a live run glyph outranks blocked — the runner state wins, waiting badge degrades in', () => {
  const ready = itemWith(undefined, 'backlog/gated.md')
  const markup = renderToStaticMarkup(
    <BacklogRowContent
      item={ready}
      now={NOW}
      dependencyState="blocked"
      runGlyph={{ state: 'in_progress', live: true, label: 'Running' }}
    />,
  )
  // The runner's spinner glyph renders (its label lives in the lazy tooltip);
  // the blocked presentation must not fight the observed run state.
  assert.match(markup, /lifecycle-spin/, 'the live runner glyph renders, not the blocked ring')
  assert.ok(!markup.includes('Blocked by prerequisites'), 'no blocked badge against a live run')
  assert.match(markup, /aria-label="Waiting on prerequisites"/, 'the softer waiting badge remains')
})

run('an epic with a partial blocked rollup shows the granular count, not a blocked status', () => {
  const epic = createBacklogItem({
    path: '/repo/backlog/epics/auth.md',
    relativePath: 'backlog/epics/auth.md',
    sourceContent: '---\ntype: epic\nstatus: ready\n---\n# Auth revamp',
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
  })
  const markup = renderToStaticMarkup(
    <BacklogRowContent
      item={epic}
      now={NOW}
      epicProgress={{ done: 1, total: 4 }}
      epicBlocked={{ remaining: 3, blocked: 2 }}
    />,
  )
  assert.match(markup, /2 blocked/, 'the visible count token renders')
  assert.match(
    markup,
    /aria-label="2 of 3 remaining items blocked by prerequisites"/,
    'the count spells out the fraction accessibly',
  )
  assert.ok(!markup.includes('>Blocked<'), 'a partially blocked epic does not read Blocked')
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

// ---- Epic row banner (status glyph + true completion meter) -----------------

function epicItem(status: string) {
  return createBacklogItem({
    path: '/repo/backlog/epics/single-owner.md',
    relativePath: 'backlog/epics/single-owner.md',
    sourceContent: `---\ntype: epic\nstatus: ${status}\n---\n# Single-owner tasks`,
    stats: { modifiedAtMs: 1_000, sizeBytes: 64 },
  })
}

run('an epic row leads with its status glyph (static without a live run) and keeps the layers mark', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent
      item={epicItem('in_progress')}
      now={NOW}
      epicMeta={{ title: 'Single-owner tasks', color: 'red' }}
      epicProgress={{ done: 9, total: 12 }}
    />,
  )
  // The lifecycle glyph is back on epic rows: the in_progress quarter arc —
  // but STATIC, because the spinner means "an agent is working right now" and
  // a bare in_progress status has no live run attached.
  assert.match(markup, /M8 3a5 5 0 0 1 5 5/, 'the in-progress quarter arc renders')
  assert.ok(!markup.includes('lifecycle-spin'), 'no spinner without a live run glyph')
  assert.match(markup, /aria-label="Epic"/, 'the layers identity mark still names the container')
  assert.match(markup, /font-semibold/, 'the epic title sits heavier than a leaf row')
})

run('a row with a LIVE run glyph spins; without one, in_progress stays static', () => {
  const base = { ...itemWith(), status: 'in_progress' as const }
  const liveMarkup = renderToStaticMarkup(
    <BacklogRowContent
      item={base}
      now={NOW}
      runGlyph={{ state: 'in_progress', label: 'Running', live: true }}
    />,
  )
  assert.match(liveMarkup, /lifecycle-spin/, 'a live runner earns the spinner')
  const idleMarkup = renderToStaticMarkup(<BacklogRowContent item={base} now={NOW} />)
  assert.ok(!idleMarkup.includes('lifecycle-spin'), 'no agent attached → no spin')
})

run('an epic row shows its true completion as a meter: fraction + accessible name, no triage tokens', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent item={epicItem('in_progress')} now={NOW} epicProgress={{ done: 9, total: 12 }} />,
  )
  assert.match(markup, /aria-label="9 of 12 complete"/, 'the meter carries one accessible name')
  assert.match(markup, /9\/12/, 'the visible fraction is the signal, never colour alone')
  // An epic is a container, not a work item — no size/priority dashes.
  assert.ok(!markup.includes('aria-label="Size unestimated"'), 'no size token on an epic row')
  assert.ok(!markup.includes('aria-label="No priority set"'), 'no priority token on an epic row')
})

run('an epic row given its OWN identity as epicMeta never pills itself', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowContent
      item={epicItem('completed')}
      now={NOW}
      epicMeta={{ title: 'Single-owner tasks', color: 'red', displayId: 'MC-1544' }}
      epicProgress={{ done: 12, total: 12 }}
    />,
  )
  assert.ok(!markup.includes('aria-label="Epic:'), 'the member pill is for parents only')
})

// ---- Row hover card ---------------------------------------------------------

run('the row hover card carries the full title, status word, id, and path', () => {
  const item = { ...itemWith(), displayId: 'MC-1500' }
  const markup = renderToStaticMarkup(<BacklogRowHoverCard item={item} />)
  assert.match(markup, /Checkout flow/, 'the full (unclipped) title leads the card')
  assert.match(markup, /Idea/, 'the status word is on the card')
  assert.match(markup, /MC-1500/, 'the display id is on the card')
  assert.match(markup, /backlog\/checkout\.md/, 'the path (the old native title) survives on the card')
})

// On a cross-project list the project rides HERE — the rows themselves stay a
// title and its meta, with no column of the same project name repeated down the
// page. Inside one project's panel the card is handed no project at all: the
// panel is the answer.
run('the hover card names the project when rows come from several backlogs', () => {
  const item = { ...itemWith(), displayId: 'MC-1500' }
  const mixed = renderToStaticMarkup(<BacklogRowHoverCard item={item} projectName="multicode" />)
  assert.match(mixed, /MC-1500 · multicode/, 'the project follows the id on the card')
  const single = renderToStaticMarkup(<BacklogRowHoverCard item={item} />)
  assert.doesNotMatch(single, /multicode/, 'with no project passed the card names none')
})

run('an epic hover card adds its true completion fraction', () => {
  const markup = renderToStaticMarkup(
    <BacklogRowHoverCard item={epicItem('in_progress')} epicProgress={{ done: 9, total: 12 }} />,
  )
  assert.match(markup, /9\/12 complete/, 'the fraction reads on the card')
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

// ---- Detail mockups section (MC-1485) --------------------------------------

// Build a real BacklogItem carrying a body-prose mockup link so the detected
// (read-only) row path is exercised through the same collectBacklogMockups the
// panel uses. renderToStaticMarkup does not run effects, so the async existence
// check never fires — the row renders optimistically, which is what we assert.
function mockupItem(opts: { mockups?: string[]; body?: string } = {}): BacklogItem {
  const lines: string[] = ['type: feature']
  if (opts.mockups?.length) lines.push(`mockups: ${opts.mockups.join(', ')}`)
  const body = opts.body ?? '# Design item'
  return createBacklogItem({
    path: '/repo/backlog/design.md',
    relativePath: 'backlog/design.md',
    sourceContent: `---\n${lines.join('\n')}\n---\n${body}`,
    stats: { modifiedAtMs: 1, sizeBytes: 1 },
  })
}

function mockupsSection(item: BacklogItem): string {
  return renderToStaticMarkup(
    <BacklogMockupsSection
      item={item}
      folderPath="/repo"
      onOpenMockup={() => {}}
      onSetMockups={() => {}}
    />,
  )
}

run('detail Mockups: the section renders its title and the Attach mockup… action', () => {
  const markup = mockupsSection(mockupItem())
  assert.match(markup, /Mockups/, 'the Mockups section header renders')
  assert.match(markup, /Attach mockup…/, 'the attach editor is reachable from the detail pane')
})

// MC-2047: the empty state IS the reachable control. The old assertion pinned
// the sentence "No mockups attached. Use “Attach mockup…” to add one." — copy
// that named and explained the control sitting on the same row, which the
// standing ruling forbids (if a control needs a sentence, the control is wrong).
// Assert the affordance, not the prose, so the test cannot re-encode the ruling
// this change removed — the trap that bit MC-1816's rail tests.
run('detail Mockups: an empty item offers the attach control and no explanatory copy', () => {
  const markup = mockupsSection(mockupItem())
  assert.match(markup, /Attach mockup…/, 'the attach control is reachable with nothing attached')
  assert.ok(
    !/No mockups attached/.test(markup),
    'the empty section explains nothing — the control is the whole empty state',
  )
})

run('detail Mockups: a body-prose mockup link lights up as a read-only detected row', () => {
  const markup = mockupsSection(mockupItem({ body: '# Design\n\nMockup: [main](../mockups/main.html)' }))
  assert.match(markup, /Found in this item/, 'a detected reference is labelled read-only')
  assert.match(markup, /mockups\/main\.html/, 'the detected path is shown')
})

run('detail Mockups: an attached mockup renders a removable row (no read-only caption)', () => {
  const markup = mockupsSection(mockupItem({ mockups: ['backlog/mockups/a.html'] }))
  assert.match(markup, /aria-label="Remove mockup backlog\/mockups\/a\.html"/, 'attached rows carry a remove control')
  assert.ok(!markup.includes('Found in this item'), 'an attached row is not captioned as detected')
})

// Source contracts, in the spirit of backlog.test.ts: the panel-side wiring the
// static render above cannot reach (store-bound list + detail surfaces).
const backlogPanelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/BacklogPanel.tsx'),
  'utf8',
)
// The Backlog door retired 2026-09-05 (the workspace pane's Backlog tab is the
// one Backlog surface now), so the panel is the only list these contracts read.
// The wizard's backlog source picker died with the sprint flow (MC-2062); the
// New sprint dialog is the creation surface that composes the shared row now.
const sourcePickerSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/newSprint/NewSprintDialog.tsx'),
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
  // The row surface paints through the one seam, so the paint order below
  // cannot drift from it.
  for (const [surface, source] of [
    ['panel', backlogPanelSource],
  ] as const) {
    assert.match(
      source,
      /backlogRowPaintClass\(\{ color(: \w+)?, litFill, selected \}\)/,
      `the ${surface} list paints its rows through the shared paint-order seam, not its own ternary`,
    )
    assert.ok(
      !/swatch\.bg/.test(source),
      `the ${surface} list no longer paints the lit identity fill over the selection fill`,
    )
    // Epic group headers are rows in the same list and select the same way. The
    // door's header used to fill with --accent-primary-soft, which is the one
    // thing selection may never be (design-system/patterns/selection.html).
    assert.ok(
      !source.includes('bg-[color:var(--accent-primary-soft)]'),
      `the ${surface} list never paints the accent as a row fill`,
    )
    assert.match(
      source,
      /backlogRowPaintClass\(\{\s*color: (group|row\.group)\.color,\s*litFill: false,/,
      `the ${surface} list paints its epic group headers through the same seam`,
    )
  }
})

// Paint order, measured on the helper rather than on a regex: selection owns the
// row background, identity owns the bar and the unselected tint. An epic-member
// row used to keep its tint when selected, so the click left no visible mark.
// A hand-set highlight and an epic identity hue are the same `litFill` case by
// the time the row is painted — resolveBacklogRowColor collapses them to one
// {color, litFill} (its own precedence test above) — so the rule below covers
// both, and cannot be satisfied for epic rows alone.
const purple = getHighlightSwatch('purple')

run('paint order: selection outranks the identity tint on a lit row', () => {
  const selected = backlogRowPaintClass({ color: 'purple', litFill: true, selected: true })
  assert.match(selected, /bg-\[color:var\(--bg-selected\)\]/, 'selection owns the row background')
  assert.ok(
    !selected.includes(purple.bg) && !selected.includes(purple.dimBg),
    'no identity tint survives over the selection fill',
  )
  assert.ok(!selected.includes(purple.border), 'no identity bar: the epic dot carries identity (ruled 2026-09-02)')
})

run('paint order: an unselected lit row keeps the full identity tint', () => {
  const resting = backlogRowPaintClass({ color: 'purple', litFill: true, selected: false })
  assert.ok(resting.includes(purple.dimBg), 'the epic/highlight tint reads across an unpicked row')
  assert.ok(!resting.includes(purple.border), 'no identity bar in either state (ruled 2026-09-02)')
  assert.ok(!resting.includes('var(--bg-selected)'), 'an unselected row is never selection-painted')
})

run('paint order: derived risk heat never tints the row, and has no stripe to tint', () => {
  const heat = backlogRowPaintClass({ color: 'red', litFill: false, selected: false })
  assert.ok(!heat.includes(getHighlightSwatch('red').border), 'derived heat paints no stripe; the priority glyph carries it')
  assert.ok(!heat.includes('highlight-bg'), 'an unearned fill never lights the row')
})

run('paint order: a plain row and a lit row select to the same fill', () => {
  const fills = (value: string) => value.split(' ').filter((c) => c.startsWith('bg-') || c.includes('highlight-bg'))
  assert.deepEqual(
    fills(backlogRowPaintClass({ color: null, litFill: false, selected: true })),
    fills(backlogRowPaintClass({ color: 'green', litFill: true, selected: true })),
    'the selected step is the same magnitude whatever colour the row carries',
  )
  assert.doesNotMatch(
    backlogRowPaintClass({ color: null, litFill: false, selected: true }),
    /border-l/,
    'no row reserves a bar width any more',
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

run('epic completion derives from the FULL scan and threads to rows + group headers', () => {
  assert.match(
    backlogPanelSource,
    /epicProgressBySlug\(items\)/,
    'the progress map derives over the full scan, never the filtered view',
  )
  assert.match(
    backlogPanelSource,
    /epicProgressBySlug\.get\(epicSlug\(item\)\)/,
    'flat epic rows read their true completion',
  )
  assert.match(
    backlogPanelSource,
    /epicProgressBySlug\.get\(row\.group\.slug\)/,
    'group headers read the same full-scan map, so a lens that hides children can no longer zero the fraction',
  )
})

run('panel rows wrap in the hover card and suppress the clipped-title tooltip', () => {
  assert.match(backlogPanelSource, /<BacklogRowHoverCard\s+item=\{item\}/, 'each list row carries the hover card')
  assert.match(backlogPanelSource, /plainTitle/, 'the row content skips its own clipped-title tooltip (no stacked popovers)')
  assert.ok(!backlogPanelSource.includes('title={item.relativePath}'), 'the native path title attribute is retired for rows')
})

run('the detail More-actions menu carries the shared Send-to-agent flyout', () => {
  // The same choice list as the row's right-click menu (AgentTargetMenuItems),
  // with the same liveness refresh-on-open, so an item can be handed to an
  // agent from inside its detail without returning to the list.
  assert.match(backlogPanelSource, /id: 'send-to-agent'/, 'the detail menu has a Send to agent flyout')
  assert.match(backlogPanelSource, /<AgentTargetMenuItems/, 'it renders the shared agent choice list')
  assert.match(backlogPanelSource, /if \(open\) onAgentFlyoutOpen\(\)/, 'opening the flyout refreshes session liveness')
  assert.match(backlogPanelSource, /onSendToAgent\(selected, sessionId\)/, 'a pick sends the SELECTED item through the shared send path')
  assert.match(contextMenuSource, /<AgentTargetMenuItems/, 'the row context menu renders the same shared list (no drift)')
})

run('the Epics lens renders flat epic rows, never childless group headers', () => {
  assert.match(
    backlogPanelSource,
    /if \(view === 'epics'\) return null/,
    'by-epic grouping is a no-op under the Epics lens (every group would be an arrow that expands to nothing)',
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

run('the row dependency markers are derived (never persisted) and wired through the list', () => {
  assert.match(backlogPanelSource, /backlogDependencyState\(/, 'the marker map reads the shared derivation helper')
  assert.match(
    backlogPanelSource,
    /dependencyState=\{dependencyStateById\?\.get\(item\.id\) \?\? null\}/,
    'rows receive their derived dependency state',
  )
  assert.match(
    backlogPanelSource,
    /epicBlocked=\{item\.isEpic \? epicBlockedBySlug\?\.get\(epicSlug\(item\)\) : undefined\}/,
    'epic rows receive the granular blocked rollup',
  )
  // The status/best sorts demote blocked items via the derived signal.
  assert.match(
    backlogPanelSource,
    /compareBacklogItems\(a, b, sort, \(entry\) => blockedPaths\.has\(entry\.relativePath\)\)/,
    'the comparator receives the blocked accessor',
  )
  // Never a frontmatter/object field — purely derived, like runGlyphById.
  assert.ok(!/updateBacklog\w*[Ww]aiting/.test(backlogPanelSource), 'waiting is never persisted')
  assert.ok(!/updateBacklog\w*[Bb]locked/.test(backlogPanelSource), 'blocked is never persisted')
})

run('prerequisites persist only through the dependsOn frontmatter IPC, never items.json', () => {
  assert.match(backlogPanelSource, /window\.api\.updateBacklogDependencies\(\{/, 'setDependencies mutates through the update-dependencies IPC')
  assert.match(
    backlogPanelSource,
    /setDependencies: \(item, slugs\) => void setItemDependencies\(item, slugs\)/,
    'setDependencies sits in BacklogActions so the menu and detail share one path',
  )
})

run('the detail pane renders the Mockups section above Links, exempting only type: mockup items', () => {
  // The section leads the metadata stack (above Links) and renders for epics +
  // leaf items alike; a `type: mockup` item is the mockup itself, so it is exempt.
  assert.match(backlogPanelSource, /<BacklogMockupsSection/, 'the detail pane renders the Mockups section')
  assert.match(backlogPanelSource, /selected\.type !== 'mockup' \?/, 'only a type: mockup item is exempt from the section')
  const mockupsAt = backlogPanelSource.indexOf('<BacklogMockupsSection')
  const linksAt = backlogPanelSource.indexOf('<BacklogLinksSection')
  assert.ok(mockupsAt >= 0 && linksAt > mockupsAt, 'Mockups renders above Links')
})

run('mockup attachments persist only through the mockups frontmatter IPC, never items.json', () => {
  assert.match(backlogPanelSource, /window\.api\.updateBacklogMockups\(\{/, 'setMockups mutates through the update-mockups IPC')
  assert.match(
    backlogPanelSource,
    /setMockups: \(item, mockups\) => void setItemMockups\(item, mockups\)/,
    'setMockups sits in BacklogActions so the section routes through the shared path',
  )
})

run('opening a mockup swaps the detail pane to the shared FilePreviewPane with the sandboxed frame', () => {
  assert.match(backlogPanelSource, /if \(previewedMockup\) \{/, 'a previewed mockup replaces the item content')
  assert.match(backlogPanelSource, /<FilePreviewPane/, 'the preview reuses the shared FilePreviewPane chrome')
  assert.match(backlogPanelSource, /<HtmlArtifactFrame/, 'HTML mockups render through the sandboxed frame')
  assert.match(backlogPanelSource, /enableSourceView/, 'the frame keeps its source toggle')
  // Selection change clears the preview so it never bleeds across items.
  assert.match(backlogPanelSource, /setPreviewedMockup\(null\)\s*\n\s*\}, \[selectedId\]\)/, 'the preview clears on selection change')
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
  // The row is `ui/MenuOption` now, which emits the state attribute its ROLE
  // takes — `aria-selected` for a listbox option, `aria-checked` for the
  // checkable ones — so the picker states the role and the selection, not the
  // attribute.
  assert.match(
    itemSearchPickerSource,
    /role=\{resultRole === 'listbox' \? 'option' : 'menuitemcheckbox'\}/,
    'dialog-hosted search results are listbox options',
  )
  assert.match(
    itemSearchPickerSource,
    /selected=\{checked\}/,
    'dialog-hosted search results expose selected prerequisites accessibly',
  )
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

run('row context menu lists module-contributed actions through the shared grouping helper', () => {
  // The optional second argument is the whole multi-selection (MC-2060); the
  // single-row path still resolves through the same shared registry call.
  assert.match(backlogPanelSource, /externalActionsForItem\(menuItem, menuSelectionItems \?\? undefined\)/, 'the exact row is resolved through the shared module action registry')
  assert.match(contextMenuSource, /<BacklogModuleActionMenuItems/, 'visible module actions render in the row menu')
  assert.match(contextMenuSource, /itemAction\.run\(\)/, 'activation uses the existing action run path')
})

run('the New sprint dialog source picker renders the same shared row interior', () => {
  assert.match(
    sourcePickerSource,
    /<BacklogRowContent item=\{item\} now=\{Date\.now\(\)\} selected=\{picked\} plainTitle \/>/,
    'the picker composes BacklogRowContent — with its own selection flag, so the picked row lifts its ink like every other Tier 1 row',
  )
})

// MC-1697: a mockup an item names but that resolves to no file on disk is shown
// as a row warning, never dropped. The badge reads on the word + warn tone, and
// its accessible name spells out which refs and how to fix.
run('a row whose item has danglingMockups renders the Missing-mockup warning badge', () => {
  const item: BacklogItem = { ...itemWith(), danglingMockups: ['mockups/gone.html'] }
  const markup = renderToStaticMarkup(<BacklogRowContent item={item} now={NOW} />)
  assert.match(markup, /Missing mockup/, 'the word carries the meaning, not colour alone')
  assert.match(markup, /--tone-warn/, 'a dangling reference is a defect, so it uses the warn tone')
  assert.match(
    markup,
    /aria-label="Missing mockup: mockups\/gone\.html was not found on disk[^"]*"/,
    'the accessible name names the ref and the fix',
  )
})

run('a row with two dangling mockups pluralizes and names both refs', () => {
  const item: BacklogItem = {
    ...itemWith(),
    danglingMockups: ['mockups/a.html', 'mockups/b.html'],
  }
  const markup = renderToStaticMarkup(<BacklogRowContent item={item} now={NOW} />)
  assert.match(markup, /2 missing mockups/, 'the visible count pluralizes')
  assert.match(markup, /mockups\/a\.html, mockups\/b\.html/, 'the accessible name lists every ref')
})

run('a row with no dangling mockups renders no Missing-mockup badge — the warning is earned', () => {
  const markup = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} />)
  assert.ok(!markup.includes('Missing mockup'), 'no placeholder warning on a clean row')
})

// T25 / review I1 + R3: selection on a Backlog row is two channels, fill and
// ink, and both have to rest together when the row's pane is not the one
// holding focus. The fill is measured live on the door; these pin the ink and
// the wiring the two surfaces share, which is the half a live pass on one door
// cannot prove for the other.
run('an unselected Backlog row title sits at --text-default, and selection lifts it to --text-strong', () => {
  for (const plain of [true, false]) {
    const idle = renderToStaticMarkup(<BacklogRowContent item={itemWith()} now={NOW} plainTitle={plain} />)
    const picked = renderToStaticMarkup(
      <BacklogRowContent item={itemWith()} now={NOW} plainTitle={plain} selected />,
    )
    assert.match(idle, /text-\[color:var\(--text-default\)\]/, `unselected title is one rung down (plainTitle=${plain})`)
    assert.ok(
      !idle.includes('text-[color:var(--text-strong)]'),
      `an unselected title never sits at the lifted ink (plainTitle=${plain})`,
    )
    assert.match(picked, /text-\[color:var\(--text-strong\)\]/, `selection lifts the ink (plainTitle=${plain})`)
  }
})

run('the Backlog panel hands the row its selected flag, so fill and ink cannot drift apart', () => {
  for (const [name, source] of [
    ['the panel', backlogPanelSource],
  ] as const) {
    assert.match(source, /<BacklogRowContent[\s\S]{0,600}?selected=\{selected\}/, `${name} passes it to the row`)
    assert.match(
      source,
      /<BacklogEpicHeaderContent[\s\S]{0,400}?selected=\{/,
      `${name} passes it to the group header too`,
    )
  }
})

if (failures > 0) {
  console.error(`BacklogRow.test.tsx: ${failures} failing`)
  process.exit(1)
}
console.log('BacklogRow.test.tsx: ok')
