import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildSprintEngineStartedFrom,
  sprintEngineCapturedLabel,
  sprintEngineSeedKindLabel,
  sprintEngineSeedMode,
  sprintEngineSeedPreviewKind,
  sprintEngineSeedProvenanceProviderLabel,
  trackerSeedProvenance,
} from './sprintEngineStartedFrom'
import type { SprintEngineSource, SprintEngineSourceBundleStateItem } from '../../../types/workspace'

// T8 (Slice 2: seed docs). The pure model builder is proven directly here (row
// shape, epic nesting, subtitle, mode/preview routing); the React-coupled
// behaviours (seed inbox row, seeded-documents panel, preview-pane routing,
// Open in Backlog) are pinned as source contracts on SprintEngineInboxView.tsx,
// which has no headless render harness.

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
  // The seed is a normal inbox row (SprintEngineSeedInboxRow) tagged "Seed
  // input", not a pinned bottom section.
  assert.ok(
    viewSource.includes('<SprintEngineSeedInboxRow') &&
      viewSource.includes('Seed input'),
    'the seed surfaces as a "Seed input" inbox row',
  )
  // Selecting the seed row opens the seeded-documents list in the detail pane.
  assert.ok(
    viewSource.includes('<SprintEngineSeededDocumentsPanel') &&
      viewSource.includes('This sprint was seeded from the following'),
    'selecting the seed row opens the seeded-documents list',
  )
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
  // T14/4 (polish): incomplete epic children reserve the tick's width so child
  // filenames share one left margin (no ragged left edge). The completed tick
  // and the reserved spacer both carry the icon-xs width.
  assert.ok(
    viewSource.includes('<span aria-hidden="true" className="icon-xs shrink-0" />'),
    'incomplete epic children reserve a fixed-width tick spacer',
  )
}

// 7. MC-1467: the review artifact preview routes HTML artifacts to the same
// sandboxed frame as the seed preview (raw-source rendering was the bug).
// React-coupled, so pinned as source contracts like section 6.
{
  const inspectorSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/SprintEngineInspectorPanel.tsx'),
    'utf8',
  )
  // The routing decision reuses the seed preview-kind helper, so both
  // surfaces classify HTML identically by construction.
  assert.ok(
    inspectorSource.includes(
      "sprintEngineSeedPreviewKind(selection.artifact.relativePath) === 'html'",
    ),
    'artifact preview classifies HTML via the shared seed preview-kind helper',
  )
  assert.ok(
    inspectorSource.includes('<HtmlArtifactFrame') &&
      inspectorSource.includes('enableSourceView'),
    'HTML artifacts route to the sandboxed frame with the opt-in Source toggle',
  )
  assert.ok(
    inspectorSource.includes('watchDirectoryPath={parentPath(selection.artifact.path)}'),
    'the frame watches the artifact directory for live reload during revisions',
  )

  // FilePreviewPane keeps its default extension-based body unless a caller
  // opts into the body override (header chrome stays shared either way).
  const panePreviewSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/ui/FilePreviewPane.tsx'),
    'utf8',
  )
  assert.ok(
    panePreviewSource.includes('body?: React.ReactNode'),
    'FilePreviewPane body override is opt-in',
  )
  assert.ok(
    panePreviewSource.includes('{renderAsMarkdown ? ('),
    'FilePreviewPane retains the markdown/plain-text default body',
  )

  // openArtifact must carry the artifact's recorded path so the preview can
  // classify and display it; the absolute path stays the IO handle.
  const actionsSource = readFileSync(
    join(
      process.cwd(),
      'src/renderer/src/components/panels/sprintEngineBoard/useSprintEngineBoardArtifactActions.ts',
    ),
    'utf8',
  )
  assert.ok(
    actionsSource.includes('relativePath: artifact.path'),
    'openArtifact records the artifact-relative path alongside the resolved absolute path',
  )
}

// 8. MC-1469: a task's artifacts are its outputs — the task detail renders
// them first-class (after the review surfaces), not inside the collapsed
// "More" reference section, and only when the task actually has artifacts.
{
  const inspectorSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/SprintEngineInspectorPanel.tsx'),
    'utf8',
  )
  const listSites = inspectorSource.match(/<SprintEngineArtifactList/g) ?? []
  assert.equal(listSites.length, 1, 'the task detail renders exactly one artifact list')
  const listIndex = inspectorSource.indexOf('<SprintEngineArtifactList')
  const moreIndex = inspectorSource.indexOf('<details className="group mt-4">')
  assert.ok(moreIndex > -1, 'the More disclosure still exists for reference sections')
  assert.ok(
    listIndex > -1 && listIndex < moreIndex,
    'the artifact list renders above the More disclosure, not inside it',
  )
  assert.ok(
    inspectorSource.includes('selectedTaskArtifacts.length > 0 ? ('),
    'the Artifacts section hides entirely for tasks with no artifacts',
  )
  assert.ok(
    inspectorSource.includes('title="Artifacts"'),
    'the promoted section is titled plainly ("Artifacts")',
  )
}

// 9. Tracker provenance (MC-1639): a proxy item's flat underscore external
// frontmatter yields the native key + issue URL + provider for the seed row; a
// native item yields null (its row is unchanged, byte-identical to today).
{
  const proxy = [
    '---',
    'external_provider: jira',
    'external_connection: trk-1',
    'external_id: "10023"',
    'external_key: PROJ-141',
    'external_url: https://acme.atlassian.net/browse/PROJ-141',
    'status: in_progress',
    '---',
    '# Relay ledger purge',
    '',
    'Body.',
  ].join('\n')
  const provenance = trackerSeedProvenance(proxy)
  assert.deepEqual(
    provenance,
    { provider: 'jira', nativeKey: 'PROJ-141', url: 'https://acme.atlassian.net/browse/PROJ-141' },
    'a proxy item yields provider + native key + issue url',
  )

  assert.equal(
    trackerSeedProvenance('# Native item\n\nA plain backlog note.\n'),
    null,
    'a native (non-proxy) item yields null provenance',
  )

  // A proxy whose external block was stripped down to just provider is not a
  // usable provenance (no native key to show) → null, not a partial chip.
  assert.equal(
    trackerSeedProvenance('---\nexternal_provider: github\n---\n# x\n'),
    null,
    'provider without a native key yields null',
  )

  // An unknown provider value is rejected (never rendered as a bogus chip).
  assert.equal(
    trackerSeedProvenance('---\nexternal_provider: gitlab\nexternal_key: GL-1\n---\n# x\n'),
    null,
    'an unsupported provider yields null',
  )

  // A missing url is tolerated (key still shows; the row just has no View link).
  assert.deepEqual(
    trackerSeedProvenance('---\nexternal_provider: linear\nexternal_key: ENG-7\n---\n# x\n'),
    { provider: 'linear', nativeKey: 'ENG-7', url: '' },
    'a proxy without a url still yields the native key, with an empty url',
  )

  assert.equal(sprintEngineSeedProvenanceProviderLabel('jira'), 'Jira', 'plain provider label')
  assert.equal(sprintEngineSeedProvenanceProviderLabel('github'), 'GitHub', 'plain provider label')
  assert.equal(sprintEngineSeedProvenanceProviderLabel('linear'), 'Linear', 'plain provider label')
}

// 10. Source contract: the Inbox seed row renders tracker provenance (native key
// + a "View in <provider>" jump-out) for proxy-seeded rows, derived from the
// backlog scan it already loads (no extra file reads). React-coupled, so pinned
// on source like the other Inbox behaviours above.
{
  const inboxSource = readFileSync(
    join(process.cwd(), 'src/renderer/src/components/panels/sprintEngineBoard/SprintEngineInboxView.tsx'),
    'utf8',
  )
  assert.ok(
    inboxSource.includes('trackerSeedProvenance(item.sourceContent)'),
    'the Inbox derives provenance from the already-loaded backlog scan, not a new read',
  )
  assert.ok(
    inboxSource.includes('provenance={row.backlogPath ? provenanceByPath.get(row.backlogPath.toLowerCase()) ?? null : null}'),
    'each seed row gets its proxy provenance by backlog path',
  )
  assert.ok(
    inboxSource.includes('window.api.openExternal(provenance.url)'),
    'the View jump-out opens the tracker issue url',
  )
  assert.ok(
    inboxSource.includes('{provenance.nativeKey}'),
    'the native tracker key renders verbatim on the seed row',
  )
}

// eslint-disable-next-line no-console
console.log('SprintEngineStartedFrom.test.ts: ok')
