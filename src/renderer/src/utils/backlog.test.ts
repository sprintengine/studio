import assert from 'node:assert/strict'
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

run('triage metadata is surfaced from the backlog object record', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/checkout.md',
    relativePath: 'backlog/checkout.md',
    sourceContent: '# Checkout',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
    object: { objectId: 'obj_1', metadata: {}, links: [], type: 'feature', difficulty: 'm', criticality: 'high' },
  })

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

run('object store metadata overrides frontmatter seeds', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/override.md',
    relativePath: 'backlog/override.md',
    sourceContent: '---\ntype: bug\ndifficulty: xl\ncriticality: critical\n---\n# Checkout copy',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
    object: { objectId: 'obj_1', metadata: {}, links: [], type: 'feature', difficulty: 'xs', criticality: 'low' },
  })

  assert.equal(item.type, 'feature')
  assert.equal(item.difficulty, 'xs')
  assert.equal(item.criticality, 'low')
})

run('invalid frontmatter triage values are ignored without warnings', () => {
  const item = createBacklogItem({
    path: '/repo/backlog/bad-metadata.md',
    relativePath: 'backlog/bad-metadata.md',
    sourceContent: '---\ntype: epic\ndifficulty: huge\ncriticality: emergency\n---\n# Notes',
    stats: { modifiedAtMs: 20, sizeBytes: 64 },
  })

  assert.equal(item.type, undefined)
  assert.equal(item.difficulty, undefined)
  assert.equal(item.criticality, undefined)
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
