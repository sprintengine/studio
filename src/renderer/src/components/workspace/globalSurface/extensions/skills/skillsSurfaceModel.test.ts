import assert from 'node:assert/strict'

import type {
  ScanResult,
  ScannedSkill,
  SkillDiscoveryCondition,
  SkillFileRef,
  SkillSource,
} from '../../../../../../../shared/skills'
import {
  addedRepoKeys,
  createSkillSearchScheduler,
  describeSearchBudget,
  discoverNoticeTone,
  formatStars,
  isRepoAdded,
  SKILL_SEARCH_DEBOUNCE_MS,
} from './discoverModel'
import {
  defaultSkillFilePath,
  deriveGroupTabs,
  deriveSkillCatalogueGroups,
  bundledScanLine,
  skippedNoDescriptionLine,
  deriveInstallAvailability,
  deriveSkillsKindStateLine,
  deriveSourceRailRows,
  deriveSourceView,
  describeDeadSkillLink,
  describeSourceMeta,
  formatSkillFileSize,
  isMarkdownSkillFile,
  orderSkillFiles,
  resolveSkillLink,
  skillCountLine,
  skillGroupLabel,
  stripSkillFrontmatter,
  skillSourceCommitsUrl,
  summarizeInstallRun,
  summarizeSyncRun,
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

// ── Syncing ──────────────────────────────────────────────────────────────────

run('a sync reports counts, and only counts', () => {
  assert.equal(summarizeSyncRun({ added: 3, removed: 0, refreshed: 0, failures: [] }), 'Synced · 3 new skills')
  assert.equal(summarizeSyncRun({ added: 1, removed: 0, refreshed: 0, failures: [] }), 'Synced · 1 new skill')
  // A sync that brought nothing in says so, rather than reading as an outcome
  // it did not have.
  assert.equal(summarizeSyncRun({ added: 0, removed: 0, refreshed: 0, failures: [] }), 'Synced · no new skills')
  assert.equal(
    summarizeSyncRun({ added: 2, removed: 1, refreshed: 4, failures: [] }),
    'Synced · 2 new skills · 1 removed upstream · 4 installed skills updated',
  )
})

run('a sync that could not update an installed skill names it', () => {
  const line = summarizeSyncRun({
    added: 0,
    removed: 0,
    refreshed: 1,
    failures: [{ skillId: 'skills/engineering/tdd', message: 'GitHub rate-limited this request.' }],
  })
  assert.match(line, /tdd did not update: GitHub rate-limited this request\.$/)
})

run('the source links out to the history that says what changed', () => {
  assert.equal(
    skillSourceCommitsUrl(source()),
    'https://github.com/owner/repo/commits/b81f77abcdef0123',
  )
  // Nothing to link to for a source that is not a repository.
  assert.equal(skillSourceCommitsUrl(source({ id: 'builtin', kind: 'builtin', repo: '' })), null)
})

// ── Header facts ─────────────────────────────────────────────────────────────

run('a source header states only facts the scan produced', () => {
  const meta = describeSourceMeta(source(), { status: 'ready', scan: scanOf([skill('a'), skill('b')]) })
  // The repository is the header's title, so the line under it does not repeat it.
  assert.deepEqual(meta, ['2 skills', '2 files', 'b81f77a'])
  // Before the scan lands, no counts are claimed.
  assert.deepEqual(describeSourceMeta(source(), { status: 'loading' }), ['b81f77a'])
  assert.deepEqual(
    describeSourceMeta(source({ id: 'connectors', kind: 'connectors', repo: '', commitSha: '' }), {
      status: 'loading',
    }),
    [],
  )
})

run('a listing that came out of the build says so; one read from the repository does not', () => {
  // The two look identical on screen and are different claims about how current
  // the list is (studio-marketplace ruling, 2026-09-06): our own marketplace
  // falls back to the copy this build shipped when the network is not there,
  // and someone deciding whether a plugin exists yet needs to know which
  // question their answer came from.
  assert.equal(bundledScanLine(null), null, 'a scan that has not landed claims nothing either way')
  assert.equal(bundledScanLine({}), null, 'nor does a scan cached before the flag existed')
  assert.equal(bundledScanLine({ bundled: false }), null, 'a read of the repository is the ordinary case')
  assert.match(bundledScanLine({ bundled: true }) ?? '', /bundled copy/)
  assert.match(bundledScanLine({ bundled: true }) ?? '', /repository could not be read/)
  assert.equal(
    /network/.test(bundledScanLine({ bundled: true }) ?? ''),
    false,
    'and never names a cause it does not know: the fallback also fires on a rate limit',
  )
})

run('file sizes read in the units of the file', () => {
  assert.equal(formatSkillFileSize(0), '0 B')
  assert.equal(formatSkillFileSize(900), '900 B')
  assert.equal(formatSkillFileSize(2048), '2.0 KB')
  assert.equal(formatSkillFileSize(5 * 1024 * 1024), '5.0 MB')
})

// ── The reader ───────────────────────────────────────────────────────────────

function file(path: string, over: Partial<SkillFileRef> = {}): SkillFileRef {
  return { path, size: 1200, blobSha: '', isEntry: path === 'SKILL.md', ...over }
}

run('a skill is read entry first, then its own documents, then its subdirectories', () => {
  const ordered = orderSkillFiles([
    file('scripts/block-dangerous-git.sh'),
    file('UI.md'),
    file('SKILL.md'),
    file('agents/openai.yaml'),
    file('LOGIC.md'),
  ]).map((entry) => entry.path)
  assert.deepEqual(ordered, [
    'SKILL.md',
    'LOGIC.md',
    'UI.md',
    'agents/openai.yaml',
    'scripts/block-dangerous-git.sh',
  ])
  assert.equal(defaultSkillFilePath([file('UI.md'), file('SKILL.md')]), 'SKILL.md')
  // A skill whose scan carried no entry still opens on something readable.
  assert.equal(defaultSkillFilePath([file('UI.md'), file('LOGIC.md')]), 'LOGIC.md')
  assert.equal(defaultSkillFilePath([]), '')
})

run('a relative link resolves against the skill it came from', () => {
  const files = [file('SKILL.md'), file('LOGIC.md'), file('UI.md'), file('scripts/run.sh')]
  assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md'), { kind: 'file', path: 'LOGIC.md' })
  assert.deepEqual(resolveSkillLink(files, 'SKILL.md', './UI.md'), { kind: 'file', path: 'UI.md' })
  // Back the other way, and out of a subdirectory.
  assert.deepEqual(resolveSkillLink(files, 'UI.md', 'SKILL.md'), { kind: 'file', path: 'SKILL.md' })
  assert.deepEqual(resolveSkillLink(files, 'scripts/run.sh', '../SKILL.md'), {
    kind: 'file',
    path: 'SKILL.md',
  })
  assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'scripts/run.sh'), {
    kind: 'file',
    path: 'scripts/run.sh',
  })
  // A fragment on a resolvable file still opens the file.
  assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md#state'), {
    kind: 'file',
    path: 'LOGIC.md',
  })
})

run('a link to a file the scan never carried is dead, and says which file', () => {
  const files = [file('SKILL.md')]
  assert.deepEqual(resolveSkillLink(files, 'SKILL.md', 'LOGIC.md'), { kind: 'dead', target: 'LOGIC.md' })
  assert.equal(describeDeadSkillLink('LOGIC.md'), "LOGIC.md is not one of this skill's files.")
})

run('anything carrying a scheme is not the skill’s to resolve', () => {
  const files = [file('SKILL.md'), file('LOGIC.md')]
  // Handed back to the renderer's protocol guard: https opens, javascript dies
  // there. Resolving either one here would route it around that guard.
  assert.equal(resolveSkillLink(files, 'SKILL.md', 'https://example.com/LOGIC.md'), null)
  assert.equal(resolveSkillLink(files, 'SKILL.md', 'javascript:steal()'), null)
  assert.equal(resolveSkillLink(files, 'SKILL.md', 'JavaScript:steal()'), null)
  assert.equal(resolveSkillLink(files, 'SKILL.md', 'mailto:matt@example.com'), null)
  assert.equal(resolveSkillLink(files, 'SKILL.md', '#a-heading'), null)
  assert.equal(resolveSkillLink(files, 'SKILL.md', '   '), null)
})

run('frontmatter is the briefing, so the document starts after it', () => {
  const withMeta = '---\nname: tdd\ndescription: Write the test first\n---\n\n# TDD\n\nBody.\n'
  assert.equal(stripSkillFrontmatter(withMeta), '\n# TDD\n\nBody.\n')
  // A rule that is not frontmatter is left exactly where the author put it.
  assert.equal(stripSkillFrontmatter('# TDD\n\n---\n\nBody.\n'), '# TDD\n\n---\n\nBody.\n')
  assert.equal(isMarkdownSkillFile('SKILL.md'), true)
  assert.equal(isMarkdownSkillFile('agents/openai.yaml'), false)
  assert.equal(isMarkdownSkillFile('scripts/block-dangerous-git.sh'), false)
})

// ── Discover ─────────────────────────────────────────────────────────────────
// The input discipline GitHub's ten-searches-a-minute budget forces, and the
// facts a result row is allowed to state.

/** A clock the test drives, so the quiet window is crossed without waiting. */
function fakeClock(): {
  schedule: (callback: () => void, delayMs: number) => number
  cancelScheduled: (handle: number) => void
  fire: () => void
  armed: () => number
  delays: number[]
} {
  const pending = new Map<number, () => void>()
  const delays: number[] = []
  let nextHandle = 1
  return {
    schedule(callback, delayMs) {
      delays.push(delayMs)
      const handle = nextHandle
      nextHandle += 1
      pending.set(handle, callback)
      return handle
    },
    cancelScheduled(handle) {
      pending.delete(handle)
    },
    fire() {
      const due = [...pending.values()]
      pending.clear()
      for (const callback of due) callback()
    },
    armed: () => pending.size,
    delays,
  }
}

run('nothing is searched under three characters, and a burst of keystrokes is one request', () => {
  const clock = fakeClock()
  const sent: string[] = []
  const scheduler = createSkillSearchScheduler({
    onSearch: (query) => sent.push(query),
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  })

  assert.deepEqual(scheduler.type(''), { kind: 'empty' })
  assert.deepEqual(scheduler.type('p'), { kind: 'too_short', minLength: 3 })
  assert.deepEqual(scheduler.type('pd'), { kind: 'too_short', minLength: 3 })
  assert.equal(clock.armed(), 0, 'nothing is even armed below the minimum')
  clock.fire()
  assert.deepEqual(sent, [], 'and so nothing is sent')

  // Typing "pdf extract" one key at a time: each keystroke disarms the last, so
  // the quiet window at the end of it spends ONE of the ten requests a minute.
  for (const keystroke of ['pdf', 'pdf ', 'pdf e', 'pdf ex', 'pdf extract']) {
    assert.deepEqual(scheduler.type(keystroke), { kind: 'pending' })
  }
  assert.equal(clock.armed(), 1, 'one armed request, not five')
  clock.fire()
  assert.deepEqual(sent, ['pdf extract'], 'and it carries the last thing typed')
  assert.deepEqual(new Set(clock.delays), new Set([SKILL_SEARCH_DEBOUNCE_MS]))
})

run('an armed search does not survive deleting back past the minimum, or leaving', () => {
  const clock = fakeClock()
  const sent: string[] = []
  const scheduler = createSkillSearchScheduler({
    onSearch: (query) => sent.push(query),
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  })

  scheduler.type('pdf')
  assert.deepEqual(scheduler.type('pd'), { kind: 'too_short', minLength: 3 })
  clock.fire()
  assert.deepEqual(sent, [], 'the request armed at three characters was dropped')

  scheduler.type('pdf extract')
  scheduler.cancel()
  clock.fire()
  assert.deepEqual(sent, [], 'and leaving the tab drops it too')

  // Surrounding and repeated whitespace is not a different query.
  scheduler.type('  pdf   extract  ')
  clock.fire()
  assert.deepEqual(sent, ['pdf extract'])
})

run('the budget is spoken only when it is about to bite', () => {
  assert.equal(describeSearchBudget(null), null)
  assert.equal(describeSearchBudget({ limit: 10, remaining: 8, resetAt: '' }), null)
  assert.equal(describeSearchBudget({ limit: 10, remaining: 2, resetAt: '' }), '2 searches left this minute.')
  assert.equal(describeSearchBudget({ limit: 10, remaining: 1, resetAt: '' }), '1 search left this minute.')
  assert.equal(describeSearchBudget({ limit: 10, remaining: 0, resetAt: '' }), 'No searches left in this minute.')
})

run('a missing token is a failure of the tab; everything else is degraded', () => {
  const condition = (reason: SkillDiscoveryCondition['reason']): SkillDiscoveryCondition => ({
    reason,
    message: reason,
    retryAfterSeconds: 0,
  })
  assert.equal(discoverNoticeTone(condition('needs_token')), 'error')
  assert.equal(discoverNoticeTone(condition('rate_limited')), 'warn')
  assert.equal(discoverNoticeTone(condition('unavailable')), 'warn')
})

run('star counts fold, and a repository already added is recognised whatever its case', () => {
  assert.equal(formatStars(0), '0')
  assert.equal(formatStars(973), '973')
  assert.equal(formatStars(4900), '4.9k')
  assert.equal(formatStars(52341), '52k')

  const added = addedRepoKeys(['browser-act/skills', '', 'MattPocock/Skills '])
  assert.equal(isRepoAdded(added, 'Browser-Act/Skills'), true)
  assert.equal(isRepoAdded(added, 'mattpocock/skills'), true)
  assert.equal(isRepoAdded(added, 'anthropics/skills'), false)
})

run('a skill whose name is not its directory name carries the warning on its row', () => {
  // anthropics/skills' own `template/` declares `template-skill`; the row says
  // so and stays a row, because a source we do not own is not ours to refuse.
  const groups = deriveSkillCatalogueGroups({
    scan: scanOf([skill('template', { name: 'template-skill' }), skill('skills/tdd')]),
    installedDirNames: new Set<string>(),
    query: '',
  })
  const items = groups.flatMap((group) => group.items)
  assert.equal(items.length, 2, 'a name the specification would reject is never a missing row')
  const template = items.find((item) => item.skillId === 'template')
  assert.match(template?.nameWarning ?? '', /is not its directory name “template”/)
  assert.equal(items.find((item) => item.skillId === 'skills/tdd')?.nameWarning, '')
})

run('the skills a manifest does not list are grouped, not dropped', () => {
  // The scan puts them in a group of their own, which the catalogue renders
  // like any other — the fallback heading is for a group the scan never named.
  const sections = deriveSkillCatalogueGroups({
    scan: scanOf([skill('skills/pdf', { group: 'document-skills' }), skill('template', { group: 'Everything else' })], {
      groups: ['document-skills', 'Everything else'],
      groupingSignal: 'manifest',
    }),
    installedDirNames: new Set<string>(),
    query: '',
  })
  assert.deepEqual(
    sections.map((section) => [section.label, section.items.map((item) => item.skillId)]),
    [
      ['Document skills', ['skills/pdf']],
      ['Everything else', ['template']],
    ],
  )
})

run('the reader drops a byte-order mark before the fence, so frontmatter is never prose', () => {
  const withBom = '\uFEFF---\nname: tdd\ndescription: A skill.\n---\n\n# TDD\n\nBody.\n'
  assert.equal(stripSkillFrontmatter(withBom), '\n# TDD\n\nBody.\n')
})

run('a source says how many directories the scan passed over, and never says zero', () => {
  assert.equal(skippedNoDescriptionLine({ skippedNoDescription: 1 }), '1 directory skipped: no description')
  assert.equal(skippedNoDescriptionLine({ skippedNoDescription: 3 }), '3 directories skipped: no description')
  assert.equal(skippedNoDescriptionLine({ skippedNoDescription: 0 }), null)
  // A scan cached before the count existed says nothing, rather than "0".
  assert.equal(skippedNoDescriptionLine({}), null)
  assert.equal(skippedNoDescriptionLine(null), null)
})

console.log('skills surface model tests passed')
