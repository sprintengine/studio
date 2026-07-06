import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSprintEngineStartedFrom,
  sprintEngineCapturedLabel,
  sprintEngineSeedKindLabel,
  sprintEngineSeedMode,
  sprintEngineSeedPreviewKind,
} from './sprintEngineStartedFrom'
import type { SprintEngineSource, SprintEngineSourceBundleStateItem } from '../../../types/workspace'

// T8 (Slice 2: "Started from" seed docs). The pure model builder is proven
// directly here (row shape, epic nesting, subtitle, mode/preview routing);
// the React-coupled behaviours (cap/expand, preview-pane routing, Open in
// Backlog) are pinned as source contracts on SprintEngineInboxView.tsx, which
// has no headless render harness.

function source(overrides: Partial<SprintEngineSource> = {}): SprintEngineSource {
  return { kind: 'markdown', origin: 'reference', path: 'backlog/login.md', ...overrides }
}

function bundleItem(
  overrides: Partial<SprintEngineSourceBundleStateItem> = {},
): SprintEngineSourceBundleStateItem {
  return { kind: 'generic_context', origin: 'reference', path: 'docs/context.md', ...overrides }
}

// 0. No recorded seed → no section (legacy runs).
assert.equal(buildSprintEngineStartedFrom(undefined, undefined), null, 'absent source yields null')
assert.equal(
  buildSprintEngineStartedFrom(source({ path: '' }), []),
  null,
  'source without a path yields null',
)

// 1. Backlog-launched (reference) with 4 supporting files. Primary is first,
// tagged as the backlog item; subtitle is plain words; every row previews a file.
{
  const model = buildSprintEngineStartedFrom(
    source({ origin: 'reference', path: 'backlog/login.md', capturedAt: '2026-07-05T15:00:00Z' }),
    [
      bundleItem({ path: 'docs/a.md' }),
      bundleItem({ path: 'docs/b.md' }),
      bundleItem({ path: 'docs/c.md' }),
      bundleItem({ kind: 'html_mockup', path: 'docs/screen.html' }),
    ],
  )
  assert.ok(model, 'model built')
  assert.equal(model.epic, false)
  assert.equal(model.rows.length, 5, 'primary + 4 files')
  assert.equal(model.subtitle, 'backlog item + 4 files')
  const primary = model.rows[0]
  assert.equal(primary.isPrimary, true)
  assert.equal(primary.role, 'primary')
  assert.equal(primary.kindLabel, 'Backlog item')
  assert.equal(primary.backlogPath, 'backlog/login.md', 'backlog row exposes its backlog path')
  assert.equal(primary.mode, 'reference')
  assert.equal(primary.previewKind, 'file')
  assert.equal(model.rows[4].previewKind, 'html', 'a .html seed routes to the HTML preview')
  assert.ok(
    model.rows.slice(1).every((row) => row.role === 'supporting'),
    'non-epic bundle rows are supporting files',
  )
}

// 2. Epic-sourced: epic container first, member backlog items nested, then a
// supporting file. Members carry the epic-child role; ordering is children then
// supporting regardless of bundle order.
{
  const model = buildSprintEngineStartedFrom(source({ planKind: 'epic', path: 'backlog/epics/auth.md' }), [
    bundleItem({ kind: 'html_mockup', origin: 'reference', path: 'docs/flow.html' }),
    bundleItem({ kind: 'unknown', origin: 'reference', path: 'backlog/login.md' }),
    bundleItem({ kind: 'unknown', origin: 'reference', path: 'backlog/signup.md' }),
  ])
  assert.ok(model)
  assert.equal(model.epic, true)
  assert.equal(model.subtitle, 'epic · 2 items + 1 file')
  assert.deepEqual(
    model.rows.map((row) => row.role),
    ['primary', 'epic-child', 'epic-child', 'supporting'],
    'primary, then children, then supporting',
  )
  assert.equal(model.rows[0].kindLabel, 'Epic')
  assert.equal(model.rows[1].kindLabel, 'Backlog item')
  assert.equal(model.rows[1].backlogPath, 'backlog/login.md')
  assert.equal(model.rows[3].role, 'supporting', 'the .html doc is a supporting file, not a child')
}

// 3. Copy mode: the original backlog path drives Open-in-Backlog even though the
// on-disk path is a written copy; captured time is a reference-only affordance.
{
  const model = buildSprintEngineStartedFrom(
    source({ origin: 'file', path: 'product-requirements.md', originalPath: 'backlog/login.md', capturedAt: '2026-07-05T15:00:00Z' }),
    [],
  )
  assert.ok(model)
  const primary = model.rows[0]
  assert.equal(primary.mode, 'copy')
  assert.equal(primary.backlogPath, 'backlog/login.md', 'copy mode resolves backlog path from originalPath')
  assert.equal(primary.path, 'product-requirements.md', 'preview reads the on-disk copy')
  assert.equal(sprintEngineCapturedLabel(primary.capturedAt, primary.mode), null, 'copy mode hides captured time')
}

// 4. Mode + preview-kind + kind-label helpers.
assert.equal(sprintEngineSeedMode('reference'), 'reference')
assert.equal(sprintEngineSeedMode('file'), 'copy')
assert.equal(sprintEngineSeedMode('stdin'), 'copy')
assert.equal(sprintEngineSeedPreviewKind('a/b.HTML'), 'html')
assert.equal(sprintEngineSeedPreviewKind('a/b.htm'), 'html')
assert.equal(sprintEngineSeedPreviewKind('a/b.md'), 'file')
assert.equal(sprintEngineSeedPreviewKind('a/b.txt'), 'file')
assert.equal(sprintEngineSeedKindLabel({ kind: 'html_mockup', isEpicRoot: false }), 'Mockup')
assert.equal(sprintEngineSeedKindLabel({ kind: 'design_notes', isEpicRoot: false }), 'Design notes')
assert.equal(sprintEngineSeedKindLabel({ kind: 'unknown', isEpicRoot: true }), 'Epic')
assert.equal(sprintEngineSeedKindLabel({ kind: 'unknown', isEpicRoot: false }), 'Document')

// 5. Captured label: reference + timestamp is a human "captured at launch" line.
{
  const label = sprintEngineCapturedLabel('2026-07-05T15:00:00Z', 'reference')
  assert.ok(label && label.startsWith('captured at launch'), 'reference mode shows captured time')
  assert.equal(sprintEngineCapturedLabel(undefined, 'reference'), null, 'no timestamp → no label')
}

// 6. Source contracts on the view: the React-coupled behaviours acceptance
// names but that have no headless render harness here.
{
  const viewSource = readFileSync(
    join(
      process.cwd(),
      'src/renderer/src/components/panels/sprintEngineBoard/SprintEngineInboxView.tsx',
    ),
    'utf8',
  )
  // Cap at 4 with a Show-N-more toggle.
  assert.ok(
    viewSource.includes('SPRINT_ENGINE_SEED_ROW_CAP = 4'),
    'seed list caps at 4 rows',
  )
  assert.ok(
    viewSource.includes('rows.slice(0, SPRINT_ENGINE_SEED_ROW_CAP)') &&
      viewSource.includes('Show ${hiddenCount} more'),
    'cap-expand renders a Show N more control',
  )
  // Collapsible section.
  assert.ok(viewSource.includes('aria-expanded={!collapsed}'), 'the section is collapsible')
  // Preview routing: HTML → HtmlArtifactFrame (opt-in Source), else FilePreviewPane.
  assert.ok(
    viewSource.includes("row.previewKind === 'html'") &&
      viewSource.includes('<HtmlArtifactFrame') &&
      viewSource.includes('enableSourceView'),
    'HTML seeds route to the sandboxed frame with the opt-in Source toggle',
  )
  assert.ok(viewSource.includes('<FilePreviewPane'), 'non-HTML seeds route to FilePreviewPane')
  // Open in Backlog reveals + latches the item.
  assert.ok(
    viewSource.includes("revealNavRailComponent(workspaceId, 'backlog', 'Backlog')") &&
      viewSource.includes('dispatchBacklogReveal({ workspaceId, relativePath: backlogPath })'),
    'Open in Backlog reveals the panel and latches the item',
  )
  // T14/1 (a11y): each Open-in-Backlog button carries a distinct accessible
  // name naming its seed file, so keyboard/SR users can tell the rows apart.
  assert.ok(
    viewSource.includes('aria-label={`Open ${row.fileName} in Backlog`}'),
    'Open-in-Backlog button aria-label names the seed file',
  )
  // T14/2 (responsive): the expanded seed list is height-bounded with an
  // internal scroll, so a tall bundle / short viewport cannot push the collapse
  // toggle or lowest rows off the pane and trap the operator.
  assert.ok(
    viewSource.includes('<ul className="max-h-[40vh] overflow-y-auto pb-1">'),
    'expanded seed list is height-bounded with internal scroll',
  )
  // T14/4 (polish): incomplete epic children reserve the tick's width so child
  // filenames share one left margin (no ragged left edge). The completed tick
  // and the reserved spacer both carry the icon-xs width.
  assert.ok(
    viewSource.includes('<span aria-hidden="true" className="icon-xs shrink-0" />'),
    'incomplete epic children reserve a fixed-width tick spacer',
  )
}

// eslint-disable-next-line no-console
console.log('SprintEngineStartedFrom.test.ts: ok')
