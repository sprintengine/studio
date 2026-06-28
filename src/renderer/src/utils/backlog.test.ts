import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileSystemStat } from '../../../shared/electron-api'
import {
  backlogExcerpt,
  backlogPreviewMarkdown,
  createBacklogItem,
  inferBacklogKind,
  nextArchiveRelativePath,
  scanBacklog,
  type BacklogFilesystemAdapter,
} from './backlog'

const tests: Array<{ name: string; body: () => void | Promise<void> }> = []

function run(name: string, body: () => void | Promise<void>): void {
  tests.push({ name, body })
}

type FixtureEntry =
  | { kind: 'dir'; children?: string[] }
  | { kind: 'file'; content: string; size?: number; modifiedAtMs?: number }

class FixtureBacklogFs implements BacklogFilesystemAdapter {
  constructor(private readonly entries: Map<string, FixtureEntry>) {}

  async pathExists(path: string): Promise<boolean> {
    return this.entries.has(normalize(path))
  }

  async readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    const key = normalize(path)
    const entry = this.entries.get(key)
    if (!entry || entry.kind !== 'dir') throw new Error(`Missing directory: ${path}`)
    const children = entry.children ?? Array.from(this.entries.keys())
      .filter((candidate) => parent(candidate) === key)
      .map((candidate) => basename(candidate))
    return children.map((name) => {
      const child = this.entries.get(normalize(`${key}/${name}`))
      if (!child) throw new Error(`Missing entry: ${name}`)
      return { name, isDir: child.kind === 'dir' }
    })
  }

  async readfile(path: string): Promise<string> {
    const entry = this.entries.get(normalize(path))
    if (!entry || entry.kind !== 'file') throw new Error(`Missing file: ${path}`)
    return entry.content
  }

  async statPath(path: string): Promise<FileSystemStat> {
    const entry = this.entries.get(normalize(path))
    if (!entry || entry.kind !== 'file') throw new Error(`Missing stat: ${path}`)
    return {
      isFile: true,
      isDirectory: false,
      sizeBytes: entry.size ?? entry.content.length,
      modifiedAt: new Date(entry.modifiedAtMs ?? 1000).toISOString(),
      modifiedAtMs: entry.modifiedAtMs ?? 1000,
    }
  }
}

function fixture(entries: Record<string, FixtureEntry>): FixtureBacklogFs {
  return new FixtureBacklogFs(new Map(Object.entries(entries).map(([key, value]) => [normalize(key), value])))
}

function file(content: string): FixtureEntry {
  return { kind: 'file', content, size: content.length, modifiedAtMs: 42 }
}

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

function parent(pathValue: string): string {
  const index = pathValue.lastIndexOf('/')
  return index > 0 ? pathValue.slice(0, index) : ''
}

function basename(pathValue: string): string {
  return pathValue.split('/').at(-1) ?? pathValue
}

run('missing backlog returns a typed missing-folder state', async () => {
  const result = await scanBacklog('/repo', fixture({ '/repo': { kind: 'dir' } }))
  assert.equal(result.state, 'missing-folder')
  assert.deepEqual(result.items, [])
})

run('empty backlog returns a typed empty-folder state', async () => {
  const result = await scanBacklog('/repo', fixture({
    '/repo': { kind: 'dir', children: ['backlog'] },
    '/repo/backlog': { kind: 'dir', children: [] },
  }))
  assert.equal(result.state, 'empty-folder')
  assert.deepEqual(result.items, [])
})

run('scan returns only markdown and html files under backlog and skips ignored directories', async () => {
  const result = await scanBacklog('/repo', fixture({
    '/repo': { kind: 'dir', children: ['backlog', 'outside.md'] },
    '/repo/outside.md': file('# Outside'),
    '/repo/backlog': { kind: 'dir', children: ['idea.md', 'mockup.html', 'note.txt', 'node_modules', '.git', '.multicode-worktrees'] },
    '/repo/backlog/idea.md': file('# Product Requirements\nShip it.'),
    '/repo/backlog/mockup.html': file('<html><title>Checkout</title></html>'),
    '/repo/backlog/note.txt': file('hidden'),
    '/repo/backlog/node_modules': { kind: 'dir', children: ['dependency.md'] },
    '/repo/backlog/node_modules/dependency.md': file('# Dependency'),
    '/repo/backlog/.git': { kind: 'dir', children: ['config.md'] },
    '/repo/backlog/.git/config.md': file('# Git'),
    '/repo/backlog/.multicode-worktrees': { kind: 'dir', children: ['worktree.md'] },
    '/repo/backlog/.multicode-worktrees/worktree.md': file('# Worktree'),
  }))

  assert.equal(result.state, 'ready')
  assert.deepEqual(result.items.map((item) => item.relativePath), ['backlog/idea.md', 'backlog/mockup.html'])
  assert.deepEqual(result.items.map((item) => item.kind), ['product_plan', 'html_mockup'])
})

run('frontmatter overrides kind and status when values are valid', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/context.md',
    relativePath: 'backlog/context.md',
    sourceContent: '---\nkind: architect_plan\nstatus: idea\n---\n# Build Plan\nBody.',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.kind, 'architect_plan')
  assert.equal(item.status, 'idea')
  assert.equal(item.title, 'Build Plan')
  // Excerpt drops the leading title so the row's supporting line starts at body.
  assert.equal(item.excerpt, 'Body.')
})

run('needs_input is a valid lifecycle status for an agent awaiting the user', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/blocked.md',
    relativePath: 'backlog/blocked.md',
    sourceContent: '---\nstatus: needs_input\n---\n# Blocked Work\nBody.',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.status, 'needs_input')
})

run('nested backlog frontmatter metadata overrides kind and status', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/nested.md',
    relativePath: 'backlog/nested.md',
    sourceContent: '---\nbacklog:\n  planKind: product_plan\n  status: ready\n---\n# Nested Metadata\nBody.',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.kind, 'product_plan')
  assert.equal(item.status, 'ready')
  assert.equal(item.title, 'Nested Metadata')
})

run('invalid frontmatter falls back to default inference', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/plan.md',
    relativePath: 'backlog/plan.md',
    sourceContent: '---\nkind: task_db\nstatus: parked\n---\n# Notes\nBody.',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.kind, 'unknown')
  // A rough, unknown-kind capture defaults to a calm "idea", never the
  // "needs_structure" warning that used to flag every rough note as a defect.
  assert.equal(item.status, 'idea')
})

run('an unknown-kind capture is never flagged needs_structure by default', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/rough-note.md',
    relativePath: 'backlog/rough-note.md',
    sourceContent: 'just a rough idea, no headings, no frontmatter',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.kind, 'unknown')
  assert.equal(item.status, 'idea')
  // Triage stays unestimated until an architect sizes/prioritizes it.
  assert.equal(item.difficulty, undefined)
  assert.equal(item.criticality, undefined)
})

run('the sidecar object contributes identity, metadata, and highlight, never triage', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/checkout.md',
    relativePath: 'backlog/checkout.md',
    sourceContent: '---\ntype: feature\ndifficulty: m\ncriticality: high\n---\n# Checkout',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
    object: { objectId: 'obj_1', metadata: { jira: { key: 'P-1' } }, links: [], highlight: { starred: true, color: 'amber' } },
  })

  // App churn rides along from the sidecar object.
  assert.equal(item.objectId, 'obj_1')
  assert.deepEqual(item.metadata, { jira: { key: 'P-1' } })
  assert.deepEqual(item.highlight, { starred: true, color: 'amber' })
  // Triage is frontmatter-sourced; the sidecar cannot supply or shadow it.
  assert.equal(item.type, 'feature')
  assert.equal(item.difficulty, 'm')
  assert.equal(item.criticality, 'high')
})

run('frontmatter seeds backlog type and triage metadata when no object value exists', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/bug.md',
    relativePath: 'backlog/bug.md',
    sourceContent: '---\ntype: bug\ndifficulty: s\ncriticality: critical\n---\n# Crash on launch',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.type, 'bug')
  assert.equal(item.difficulty, 's')
  assert.equal(item.criticality, 'critical')
})

run('nested backlog frontmatter seeds metadata and aliases size/priority', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/feature.md',
    relativePath: 'backlog/feature.md',
    sourceContent: '---\nbacklog:\n  type: feature\n  size: l\n  priority: high\n---\n# Offline mode',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.type, 'feature')
  assert.equal(item.difficulty, 'l')
  assert.equal(item.criticality, 'high')
})

run('invalid frontmatter triage values are ignored without warnings', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/bad-metadata.md',
    relativePath: 'backlog/bad-metadata.md',
    sourceContent: '---\ntype: saga\ndifficulty: huge\ncriticality: emergency\n---\n# Notes',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.type, undefined)
  assert.equal(item.difficulty, undefined)
  assert.equal(item.criticality, undefined)
})

run('epic frontmatter sets the slug and marks containers via isEpic', () => {
  const child = createBacklogItem({
    path: '/repo/backlog/login.md',
    relativePath: 'backlog/login.md',
    sourceContent: '---\ntype: feature\nepic: auth-revamp\n---\n# Login',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(child.epic, 'auth-revamp')
  assert.equal(child.isEpic, false)

  const container = createBacklogItem({
    path: '/repo/backlog/epics/auth-revamp.md',
    relativePath: 'backlog/epics/auth-revamp.md',
    sourceContent: '---\ntype: epic\n---\n# Auth revamp',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(container.type, 'epic')
  assert.equal(container.isEpic, true)
  assert.equal(container.epic, undefined)
})

run('risk is read from frontmatter; invalid or absent risk stays unset', () => {
  const risky = createBacklogItem({
    path: '/repo/backlog/migration.md',
    relativePath: 'backlog/migration.md',
    sourceContent: '---\ntype: feature\nrisk: high\n---\n# Risky migration',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(risky.risk, 'high')

  // `critical` is a criticality value, not a risk value — risk is low|normal|high.
  const invalid = createBacklogItem({
    path: '/repo/backlog/bad-risk.md',
    relativePath: 'backlog/bad-risk.md',
    sourceContent: '---\nrisk: critical\n---\n# Bad risk',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(invalid.risk, undefined)

  const none = createBacklogItem({
    path: '/repo/backlog/no-risk.md',
    relativePath: 'backlog/no-risk.md',
    sourceContent: '# No risk',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(none.risk, undefined)
})

run('an unknown type value is preserved as rawType and treated as a leaf', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/saga.md',
    relativePath: 'backlog/saga.md',
    sourceContent: '---\ntype: saga\n---\n# Long-running saga',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  // Not coerced into the known union, not dropped: the literal survives on rawType.
  assert.equal(item.type, undefined)
  assert.equal(item.rawType, 'saga')
  assert.equal(item.isEpic, false)
})

run('recently-updated recency uses frontmatter updated when present, else file mtime', () => {
  const dated = createBacklogItem({
    path: '/repo/backlog/dated.md',
    relativePath: 'backlog/dated.md',
    sourceContent: '---\nupdated: 2026-06-26T10:00:00Z\n---\n# Dated',
    stats: { modifiedAtMs: 1000, sizeBytes: 64 },
  })
  assert.equal(dated.modifiedAt, Date.parse('2026-06-26T10:00:00Z'))

  // No `updated` (or an unparseable one) falls back to the file mtime.
  const undatedMtime = createBacklogItem({
    path: '/repo/backlog/undated.md',
    relativePath: 'backlog/undated.md',
    sourceContent: '# Undated',
    stats: { modifiedAtMs: 1000, sizeBytes: 64 },
  })
  assert.equal(undatedMtime.modifiedAt, 1000)

  const badDate = createBacklogItem({
    path: '/repo/backlog/bad-date.md',
    relativePath: 'backlog/bad-date.md',
    sourceContent: '---\nupdated: not-a-date\n---\n# Bad date',
    stats: { modifiedAtMs: 1000, sizeBytes: 64 },
  })
  assert.equal(badDate.modifiedAt, 1000)
})

run('highlight comes only from the object store, never frontmatter', () => {
  const seeded = createBacklogItem({
    path: '/repo/backlog/starred.md',
    relativePath: 'backlog/starred.md',
    sourceContent: '---\nhighlight: red\nstarred: true\n---\n# Starred idea',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(seeded.highlight, undefined)

  const hydrated = createBacklogItem({
    path: '/repo/backlog/starred.md',
    relativePath: 'backlog/starred.md',
    sourceContent: '# Starred idea',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
    object: { objectId: 'obj_starred', metadata: {}, links: [], highlight: { starred: true, color: 'pink' } },
  })
  assert.deepEqual(hydrated.highlight, { starred: true, color: 'pink' })
})

run('archived paths are always marked archived', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/archived/product-plan.md',
    relativePath: 'backlog/archived/product-plan.md',
    sourceContent: '---\nstatus: ready\n---\n# Product Plan',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.status, 'archived')
})

run('Windows-style path separators normalize to project-relative backlog paths', async () => {
  const result = await scanBacklog('C:\\repo', fixture({
    'C:/repo': { kind: 'dir', children: ['backlog'] },
    'C:/repo/backlog': { kind: 'dir', children: ['implementation-plan.md'] },
    'C:/repo/backlog/implementation-plan.md': file('# Roadmap'),
  }))

  assert.equal(result.state, 'ready')
  assert.equal(result.items[0]?.relativePath, 'backlog/implementation-plan.md')
  assert.equal(result.items[0]?.id, 'backlog/implementation-plan.md')
  assert.match(result.items[0]?.objectId ?? '', /^backlog_[a-z0-9]+$/)
  assert.equal(result.items[0]?.kind, 'architect_plan')
})

run('read failures surface the failing project-relative path', async () => {
  class FailingReadFs extends FixtureBacklogFs {
    override async readfile(path: string): Promise<string> {
      if (normalize(path).endsWith('/broken.md')) throw new Error('Cannot read plan')
      return super.readfile(path)
    }
  }
  const fs = new FailingReadFs(new Map(Object.entries({
    '/repo': { kind: 'dir', children: ['backlog'] },
    '/repo/backlog': { kind: 'dir', children: ['good.md', 'broken.md'] },
    '/repo/backlog/good.md': file('# Good'),
    '/repo/backlog/broken.md': file('# Broken'),
  }).map(([key, value]) => [normalize(key), value as FixtureEntry])))

  const result = await scanBacklog('/repo', fs)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.items.map((item) => item.relativePath), ['backlog/good.md'])
  assert.deepEqual(result.errors.map((error) => error.relativePath), ['backlog/broken.md'])
})

run('scan reads files through a bounded-concurrency pool and preserves sorted order', async () => {
  const fileCount = 30
  const names = Array.from({ length: fileCount }, (_, index) => `item-${String(index).padStart(2, '0')}.md`)
  const entries: Record<string, FixtureEntry> = {
    '/repo': { kind: 'dir', children: ['backlog'] },
    '/repo/backlog': { kind: 'dir', children: names },
  }
  for (const name of names) entries[`/repo/backlog/${name}`] = file(`# ${name}`)

  let active = 0
  let maxActive = 0
  class PoolFs extends FixtureBacklogFs {
    override async readfile(path: string): Promise<string> {
      active += 1
      maxActive = Math.max(maxActive, active)
      // Stagger completion so earlier-started reads can finish after later ones:
      // this proves the result order comes from the path sort, not read timing.
      const index = Number(/item-(\d+)\.md$/.exec(normalize(path))?.[1] ?? '0')
      await new Promise((resolve) => setTimeout(resolve, (fileCount - index) % 5))
      active -= 1
      return super.readfile(path)
    }
  }
  const fs = new PoolFs(
    new Map(Object.entries(entries).map(([key, value]) => [normalize(key), value as FixtureEntry])),
  )

  const result = await scanBacklog('/repo', fs)
  assert.equal(result.state, 'ready')
  // Output stays deterministically path-sorted regardless of read finish order.
  assert.deepEqual(
    result.items.map((item) => item.relativePath),
    names.map((name) => `backlog/${name}`),
  )
  // Reads run in parallel (peak > 1) but never exceed the pool bound of 12.
  assert.ok(maxActive > 1, `expected concurrent reads, saw peak ${maxActive}`)
  assert.equal(maxActive, 12, `expected pool bounded at 12, saw peak ${maxActive}`)
})

run('a single unreadable file is isolated and does not fail the parallel scan', async () => {
  const names = Array.from({ length: 20 }, (_, index) => `item-${String(index).padStart(2, '0')}.md`)
  const entries: Record<string, FixtureEntry> = {
    '/repo': { kind: 'dir', children: ['backlog'] },
    '/repo/backlog': { kind: 'dir', children: names },
  }
  for (const name of names) entries[`/repo/backlog/${name}`] = file(`# ${name}`)

  class PartialFailFs extends FixtureBacklogFs {
    override async readfile(path: string): Promise<string> {
      if (normalize(path).endsWith('/item-07.md')) throw new Error('Cannot read plan')
      return super.readfile(path)
    }
  }
  const fs = new PartialFailFs(
    new Map(Object.entries(entries).map(([key, value]) => [normalize(key), value as FixtureEntry])),
  )

  const result = await scanBacklog('/repo', fs)
  assert.equal(result.state, 'partial')
  assert.equal(result.items.length, names.length - 1)
  assert.ok(!result.items.some((item) => item.relativePath === 'backlog/item-07.md'))
  assert.deepEqual(result.errors.map((error) => error.relativePath), ['backlog/item-07.md'])
})

run('archive helper chooses collision-safe names', () => {
  assert.equal(
    nextArchiveRelativePath('backlog/product-plan.md', [
      'backlog/archived/product-plan.md',
      'backlog/archived/product-plan-2.md',
    ]),
    'backlog/archived/product-plan-3.md',
  )
})

run('HTML kind and title inference handles mockup files', () => {
  assert.equal(inferBacklogKind('backlog/prototype.htm', '<h1>Checkout</h1>'), 'html_mockup')
  const item = createBacklogItem({
    path: '/repo/backlog/prototype.htm',
    relativePath: 'backlog/prototype.htm',
    sourceContent: '<main><h1>Checkout Mockup</h1><p>Prototype flow</p></main>',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })
  assert.equal(item.title, 'Checkout Mockup')
  assert.equal(item.kind, 'html_mockup')
  assert.equal(item.type, 'mockup')
})

run('excerpt strips frontmatter and HTML noise', () => {
  assert.equal(
    backlogExcerpt('---\nstatus: ready\n---\n<style>x</style><h1>Title</h1>\n<p>Useful text</p>'),
    'Title Useful text',
  )
})

run('preview markdown drops frontmatter and the leading title H1', () => {
  assert.equal(
    backlogPreviewMarkdown('---\nstatus: ready\n---\n# Realtime presence\n\n## Goal\nShip it.'),
    '## Goal\nShip it.',
  )
  // A non-title leading heading (H2+) and body content are preserved.
  assert.equal(backlogPreviewMarkdown('## Goal\nShip it.'), '## Goal\nShip it.')
  // Title-only files render an empty body so the preview can show its own label.
  assert.equal(backlogPreviewMarkdown('# Just a title\n'), '')
})

run('excerpt drops a leading title and its trailing punctuation', () => {
  assert.equal(
    backlogExcerpt('# Realtime presence\n\nGoal: ship presence indicators.', 'Realtime presence'),
    'Goal: ship presence indicators.',
  )
  // No leading-title match leaves the flattened text untouched.
  assert.equal(backlogExcerpt('Body only.', 'Realtime presence'), 'Body only.')
})

// Structural guarantees for the Backlog provider-backed link surface (T4). These
// are source-level contracts in the spirit of ui/accessibility-contracts.test.ts:
// they keep the rendered links interactive, keyboard-accessible, status-labeled,
// failure-surfacing, and de-duplicated against the primary action without a DOM.
// The link state machine + renderer live in a focused BacklogLinksSection
// component; the Backlog panel only decides which link the primary action owns.
const backlogPanelSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/panels/BacklogPanel.tsx'),
  'utf8',
)
const linksSectionSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/backlog/BacklogLinksSection.tsx'),
  'utf8',
)
const sprintEngineModuleSource = readFileSync(
  join(process.cwd(), 'src/renderer/src/modules/sprint-engine-module.ts'),
  'utf8',
)

run('the link state machine and renderer are extracted out of BacklogPanel', () => {
  assert.ok(!backlogPanelSource.includes('function BacklogLinkControl'), 'the link renderer no longer lives in the panel')
  assert.ok(!backlogPanelSource.includes('syncBacklogItemLinks('), 'the resolution state machine no longer lives in the panel')
  assert.match(backlogPanelSource, /<BacklogLinksSection/, 'the panel composes the focused link section')
  assert.match(linksSectionSource, /export function BacklogLinksSection/, 'the focused section exists under components/backlog')
})

run('openable Backlog links render as a focusable button, not an inert span', () => {
  assert.match(linksSectionSource, /<button/, 'an openable link is a real button')
  assert.match(linksSectionSource, /onClick=\{\(\) => onOpen\(link\)\}/, 'the button opens the link through the provider')
  // The pre-T4 inert link pill carried a native title and no interactivity.
  assert.ok(!linksSectionSource.includes('title={link.target.path'), 'inert title-only link pill is gone')
})

run('unknown or unavailable Backlog links render as a focusable, non-actionable note', () => {
  assert.match(linksSectionSource, /role="note"/, 'unavailable link is informational, not a button')
  assert.match(linksSectionSource, /tabIndex=\{0\}/, 'unavailable link is keyboard-focusable so its reason is reachable')
  assert.match(linksSectionSource, /model\.canOpen \?/, 'render branches on whether the link can open')
})

run('every Backlog link shows a visible status word and a Tooltip detail', () => {
  assert.match(linksSectionSource, /\{model\.statusText\}/, 'status word is rendered as visible text, not color alone')
  assert.match(linksSectionSource, /<Tooltip content=\{model\.detail\}/, 'target/reason detail uses the Tooltip primitive')
})

run('Backlog link resolve/open failures surface inline instead of being swallowed', () => {
  assert.match(linksSectionSource, /linkError \?/, 'link errors gate an inline notice')
  assert.match(linksSectionSource, /<InlineNotice tone="warn">\{linkError\}/, 'link errors render as an inline warning')
})

run('Backlog scan/refresh resolves visible links and persists status through the service', () => {
  assert.match(linksSectionSource, /syncBacklogItemLinks\(/, 'the section resolves provider-backed links')
  assert.match(
    linksSectionSource,
    /persistLink: \(args\) => window\.api\.addOrUpdateBacklogLink\(args\)/,
    'resolved status persists through the Backlog service',
  )
})

run('the primary Sprint Engine run link is the Open action, not a duplicate Links-list button', () => {
  // The panel only de-dups the primary run link when the primary Open action is
  // actually present: an enabled provider owns it and the item is not archived.
  assert.match(backlogPanelSource, /const primaryRunLink = sprintEngineRunLinkForItem\(selected\)/, 'the primary run link is identified')
  assert.match(backlogPanelSource, /selected\.status !== 'archived'/, 'archived items keep the run link visible (no Open action)')
  assert.match(backlogPanelSource, /providerForBacklogLink\(linkProviders, primaryRunLink\)/, 'de-dup only applies when an enabled provider represents the link')
  assert.match(backlogPanelSource, /excludeLinkId=\{primaryRunLinkId\}/, 'the panel hands the primary link to the section to exclude')
  // The section excludes exactly the link the caller promoted to a primary action.
  assert.match(linksSectionSource, /\.filter\(\(link\) => link\.id !== excludeLinkId\)/, 'the section excludes the promoted primary link')
})

run('Sprint Engine contributes Start/Open Backlog actions for run-linked items', () => {
  assert.match(
    sprintEngineModuleSource,
    /host\.registerBacklogLinkProvider\(\{\s*moduleId: SPRINT_ENGINE_MODULE_ID,\s*targetKinds: \[SPRINT_ENGINE_RUN_TARGET_KIND\]/s,
    'the Sprint Engine module registers the built-in run link provider',
  )
  assert.match(
    sprintEngineModuleSource,
    /id: 'sprint-engine\.start-from-backlog',\s*label: 'Run a Sprint'/s,
    'the module registers the Run a Sprint Backlog action',
  )
  assert.match(
    sprintEngineModuleSource,
    /id: 'sprint-engine\.open-linked-run',\s*label: 'Open Sprint'/s,
    'the module registers the Open Sprint Backlog action',
  )
  assert.match(
    sprintEngineModuleSource,
    /item\.status !== 'archived' && item\.status !== 'completed' && !hasSprintEngineRunLink\(item\)/,
    'Start is visible only for runnable items without a Sprint Engine run link',
  )
  assert.match(
    sprintEngineModuleSource,
    /item\.status !== 'archived' && hasSprintEngineRunLink\(item\)/,
    'Open is visible for non-archived items with a Sprint Engine run link',
  )
})

run('completed Backlog items can be marked done manually and do not offer Sprint Engine start', () => {
  assert.match(
    backlogPanelSource,
    /id: 'mark-completed', label: 'Mark completed'/,
    'the detail overflow exposes a manual completed status action',
  )
  assert.match(
    backlogPanelSource,
    /window\.api\.updateBacklogStatus/,
    'manual completion persists through the Backlog object service',
  )
  assert.match(
    sprintEngineModuleSource,
    /item\.status !== 'archived' && item\.status !== 'completed' && !hasSprintEngineRunLink\(item\)/,
    'completed items without a run link hide Start Sprint Engine',
  )
})

async function main(): Promise<void> {
  for (const test of tests) {
    try {
      await test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }

  console.log('backlog.test.ts: ok')
}

void main()
