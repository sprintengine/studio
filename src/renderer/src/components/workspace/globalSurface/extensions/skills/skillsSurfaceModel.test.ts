import assert from 'node:assert/strict'

import type { ScanResult, ScannedSkill, SkillSource } from '../../../../../../../shared/skills'
import {
  deriveGroupTabs,
  deriveInstallAvailability,
  deriveSkillsKindStateLine,
  deriveSourceRailRows,
  deriveSourceView,
  describeSourceMeta,
  formatSkillFileSize,
  skillCountLine,
  skillGroupLabel,
  summarizeInstallRun,
  type SkillScanLoad,
} from './skillsSurfaceModel'

// The Skills surface makes two promises this suite holds to: a source page's
// shape follows what its scan actually found, and every count is honest —
// loading and unreadable never render as zero.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function skill(id: string, over: Partial<ScannedSkill> = {}): ScannedSkill {
  const name = id.split('/').slice(-1)[0]
  return {
    id,
    name,
    description: `${name} does something`,
    group: '',
    files: [{ path: 'SKILL.md', size: 1200, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
    ...over,
  }
}

function scanOf(skills: ScannedSkill[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    skills,
    groups: [],
    groupingSignal: 'none',
    fileCount: skills.reduce((total, entry) => total + entry.files.length, 0),
    commitSha: 'b81f77abcdef0123',
    ...over,
  }
}

function source(over: Partial<SkillSource> = {}): SkillSource {
  return {
    id: 'github:owner/repo',
    kind: 'github',
    name: 'repo',
    repo: 'owner/repo',
    monogram: 'RE',
    blurb: 'Skills from owner/repo.',
    commitSha: 'b81f77abcdef0123',
    scannedAt: '2026-07-28T10:00:00Z',
    ...over,
  }
}

function grouped(count: number, groups: string[]): ScanResult {
  const skills = Array.from({ length: count }, (_, index) =>
    skill(`skills/${groups[index % groups.length]}/skill-${index}`, {
      group: groups[index % groups.length],
    }),
  )
  return scanOf(skills, { groups, groupingSignal: 'folders' })
}

// ── State lines ──────────────────────────────────────────────────────────────

run('a pending or failed scan never reads as a zero count', () => {
  assert.equal(skillCountLine(undefined), 'Loading…')
  assert.equal(skillCountLine({ status: 'loading' }), 'Loading…')
  assert.equal(skillCountLine({ status: 'error', message: 'rate limited' }), 'Count unavailable')
  assert.equal(skillCountLine({ status: 'ready', scan: scanOf([skill('a')]) }), '1 skill')
  assert.equal(skillCountLine({ status: 'ready', scan: scanOf([skill('a'), skill('b')]) }), '2 skills')
})

run('the rail row states the total only once every source has answered', () => {
  const sources = [source({ id: 'builtin', name: 'Multicode' }), source({ id: 'github:o/r' })]
  const partial: Record<string, SkillScanLoad> = {
    builtin: { status: 'ready', scan: scanOf([skill('a'), skill('b')]) },
    'github:o/r': { status: 'loading' },
  }
  assert.equal(deriveSkillsKindStateLine({ status: 'ready' }, sources, partial), '2 sources')
  const complete: Record<string, SkillScanLoad> = {
    ...partial,
    'github:o/r': { status: 'ready', scan: scanOf([skill('c')]) },
  }
  assert.equal(deriveSkillsKindStateLine({ status: 'ready' }, sources, complete), '2 sources · 3 skills')
  assert.equal(deriveSkillsKindStateLine({ status: 'loading' }, [], {}), 'Loading…')
  assert.equal(
    deriveSkillsKindStateLine({ status: 'error', message: 'no' }, sources, complete),
    'Sources unavailable',
  )
  // A source whose scan failed holds the total back rather than under-counting.
  assert.equal(
    deriveSkillsKindStateLine({ status: 'ready' }, sources, {
      ...complete,
      'github:o/r': { status: 'error', message: 'offline' },
    }),
    '2 sources',
  )
})

run('a repository source is named by its repository, not its last path segment', () => {
  // mattpocock/skills, anthropics/skills and browser-act/skills all end in
  // "skills"; three rail rows reading "skills" would be unnavigable.
  const rows = deriveSourceRailRows(
    [
      source({ id: 'github:mattpocock/skills', name: 'skills', repo: 'mattpocock/skills' }),
      source({ id: 'github:browser-act/skills', name: 'skills', repo: 'browser-act/skills' }),
      source({ id: 'builtin', kind: 'builtin', name: 'Multicode', repo: '', monogram: 'MC' }),
    ],
    {
      'github:mattpocock/skills': { status: 'ready', scan: grouped(41, ['engineering', 'productivity']) },
    },
  )
  assert.deepEqual(
    rows.map((row) => `${row.monogram} ${row.name}`),
    ['MS mattpocock/skills', 'BA browser-act/skills', 'MC Multicode'],
  )
  assert.equal(rows[0].stateLine, '41 skills')
  assert.match(rows[0].tooltip, /mattpocock\/skills — 41 skills\./)
  // A source with no scan yet still lists, and says so.
  assert.equal(rows[1].stateLine, 'Loading…')
})

// ── The source page shape ────────────────────────────────────────────────────

run('one skill is a skill page, not a list of one', () => {
  const view = deriveSourceView({
    source: source(),
    scan: scanOf([skill('impeccable')]),
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind, 'solo')
  if (view.kind === 'solo') assert.equal(view.skill.skillId, 'impeccable')
})

run('a dozen ungrouped skills are one list', () => {
  const skills = Array.from({ length: 12 }, (_, index) => skill(`skills/skill-${index}`))
  const view = deriveSourceView({
    source: source({ id: 'builtin', kind: 'builtin', repo: '' }),
    scan: scanOf(skills),
    installedDirNames: new Set(['skill-3']),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind, 'flat')
  if (view.kind !== 'flat') return
  assert.equal(view.items.length, 12)
  assert.equal(view.items[3].installed, true)
  assert.equal(view.items[4].installed, false)
})

run('a grouped source opens on its largest group, never its smallest', () => {
  // Group names arrive sorted, so opening on the first would land
  // mattpocock/skills on `deprecated` — four abandoned skills out of 41.
  const scan = grouped(9, ['deprecated', 'engineering'])
  scan.skills = scan.skills.map((entry, index) => ({
    ...entry,
    group: index < 2 ? 'deprecated' : 'engineering',
  }))
  const view = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind === 'grouped' && view.activeGroup, 'engineering')
})

run('a grouped source renders one group at a time, never all 41 rows', () => {
  const scan = grouped(41, ['engineering', 'productivity', 'misc'])
  const first = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(first.kind, 'grouped')
  if (first.kind !== 'grouped') return
  assert.equal(first.groups.length, 3)
  assert.equal(first.activeGroup, 'engineering')
  assert.ok(first.items.length < 41 && first.items.length > 0)
  assert.ok(first.items.every((item) => item.group === 'engineering'))

  const second = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: 'misc',
    query: '',
  })
  assert.equal(second.kind === 'grouped' && second.activeGroup, 'misc')

  // A group the source no longer has falls back to its first group rather than
  // rendering an empty pane with no explanation.
  const stale = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: 'deleted-group',
    query: '',
  })
  assert.equal(stale.kind === 'grouped' && stale.activeGroup, 'engineering')
})

run('a 103-skill source is search-first and stays empty until it is asked', () => {
  const scan = grouped(103, ['ecommerce', 'social-listening', 'video-platforms'])
  const idle = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(idle.kind, 'search')
  if (idle.kind !== 'search') return
  assert.equal(idle.items.length, 0)
  assert.equal(idle.prompt, 'Pick a category, or search.')

  const byCategory = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: 'ecommerce',
    query: '',
  })
  assert.ok(byCategory.kind === 'search' && byCategory.items.length > 0)
  assert.ok(byCategory.kind === 'search' && byCategory.items.every((item) => item.group === 'ecommerce'))

  const searched = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: null,
    query: 'skill-7',
  })
  assert.ok(searched.kind === 'search' && searched.items.length > 0)
  assert.equal(searched.kind === 'search' && searched.prompt, null)

  const missed = deriveSourceView({
    source: source(),
    scan,
    installedDirNames: new Set(),
    activeGroup: null,
    query: 'nothing-here',
  })
  assert.equal(missed.kind === 'search' && missed.items.length, 0)
  assert.match(String(missed.kind === 'search' ? missed.prompt : ''), /Nothing matches/)
})

run('an ungrouped source past the browsing threshold is search-first too', () => {
  const skills = Array.from({ length: 30 }, (_, index) => skill(`skills/skill-${index}`))
  const view = deriveSourceView({
    source: source(),
    scan: scanOf(skills),
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind, 'search')
  assert.equal(view.kind === 'search' && view.groups.length, 0)
  assert.equal(view.kind === 'search' && view.prompt, 'Search these 30 skills.')
})

run('the connector skills deflect to their MCP servers instead of listing 194 rows', () => {
  const skills = Array.from({ length: 194 }, (_, index) => skill(`skills/connector-${index}`))
  const view = deriveSourceView({
    source: source({ id: 'connectors', kind: 'connectors', repo: '', name: 'Connectors' }),
    scan: scanOf(skills),
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind, 'connectors')
  assert.equal(view.kind === 'connectors' && view.count, 194)
})

run('a source that scanned no skills says so rather than rendering a list', () => {
  const view = deriveSourceView({
    source: source(),
    scan: scanOf([]),
    installedDirNames: new Set(),
    activeGroup: null,
    query: '',
  })
  assert.equal(view.kind, 'empty')
})

run('group tabs count their own members and read as words', () => {
  const tabs = deriveGroupTabs(grouped(6, ['social-listening', 'Document skills']))
  assert.deepEqual(
    tabs.map((tab) => `${tab.label}:${tab.count}`),
    ['Social listening:3', 'Document skills:3'],
  )
  assert.equal(skillGroupLabel('(repo root)'), '(repo root)')
  assert.equal(skillGroupLabel('in-progress'), 'In progress')
})

// ── Installing ───────────────────────────────────────────────────────────────

run('with no workspace, Install is disabled and states why', () => {
  const none = deriveInstallAvailability(null, 3)
  assert.equal(none.enabled, false)
  assert.match(String(none.reason), /Open a workspace/)
  const nothingPicked = deriveInstallAvailability('/proj', 0)
  assert.equal(nothingPicked.enabled, false)
  assert.equal(nothingPicked.reason, null)
  assert.deepEqual(deriveInstallAvailability('/proj', 2), { enabled: true, reason: null })
})

run('a batch install reports what actually happened, failures named', () => {
  assert.equal(summarizeInstallRun(3, []), 'Installed 3 skills.')
  assert.equal(summarizeInstallRun(1, []), 'Installed 1 skill.')
  assert.match(summarizeInstallRun(2, [{ skillId: 'skills/a/tdd', message: 'rate limited' }]), /Installed 2 of 3/)
  assert.match(
    summarizeInstallRun(0, [{ skillId: 'skills/a/tdd', message: 'rate limited' }]),
    /^tdd did not install: rate limited$/,
  )
})

// ── Header facts ─────────────────────────────────────────────────────────────

run('a source header states only facts the scan produced', () => {
  const meta = describeSourceMeta(source(), { status: 'ready', scan: scanOf([skill('a'), skill('b')]) })
  // The repository is the header's title, so the line under it does not repeat it.
  assert.deepEqual(meta, ['2 skills', '2 files', 'b81f77a'])
  // Before the scan lands, no counts are claimed.
  assert.deepEqual(describeSourceMeta(source(), { status: 'loading' }), ['b81f77a'])
  assert.deepEqual(
    describeSourceMeta(source({ id: 'builtin', kind: 'builtin', repo: '', commitSha: '' }), {
      status: 'loading',
    }),
    [],
  )
})

run('file sizes read in the units of the file', () => {
  assert.equal(formatSkillFileSize(0), '0 B')
  assert.equal(formatSkillFileSize(900), '900 B')
  assert.equal(formatSkillFileSize(2048), '2.0 KB')
  assert.equal(formatSkillFileSize(5 * 1024 * 1024), '5.0 MB')
})

console.log('skills surface model tests passed')
