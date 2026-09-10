import assert from 'node:assert/strict'

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  OFFICIAL_PLUGINS_SKILL_SOURCE_NAME,
  STUDIO_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_NAME,
  type ScanResult,
  type SkillSource,
} from '../../../../../../../shared/skills'
import type { SkillScanLoad } from '../skills/skillsSurfaceModel'
import {
  crossSourceStateLine,
  isCrossSourceQuery,
  searchAcrossSources,
  unreadSourcesLine,
} from './catalogueSearch'

// One search over every source (skills-everywhere, 2026-09-10). What the
// model owes: results grouped by source in TAB order, only the sources whose
// scan is already in hand, an honest account of the ones it did not cover,
// and the Installed tab's own rows leading — minus what a source already
// lists.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function source(id: string, repo: string, over: Partial<SkillSource> = {}): SkillSource {
  return { id, kind: 'github', name: repo.split('/')[1], repo, monogram: 'XX', blurb: '', commitSha: 'abc', scannedAt: '2026-09-01T00:00:00Z', ...over }
}

function scan(skillNames: readonly string[]): ScanResult {
  return {
    skills: skillNames.map((name) => ({
      id: `skills/${name}`,
      name,
      description: `${name} does a thing`,
      group: '',
      files: [],
      allowedTools: [],
      hasExecutables: false,
    })),
    groups: [],
    groupingSignal: 'none',
    fileCount: skillNames.length,
    commitSha: 'abc',
  }
}

const STUDIO = source(STUDIO_SKILL_SOURCE_ID, 'sprintengine/studio-releases')
const OFFICIAL = source(OFFICIAL_PLUGINS_SKILL_SOURCE_ID, 'anthropics/claude-plugins-official')
const ACME = source('github:acme/skills', 'acme/skills')
const LATE = source('github:late/skills', 'late/skills', { scannedAt: '' })
const BROKEN = source('github:broken/skills', 'broken/skills')

/** Rows are the skill names that contain the query, which is all a test needs of a view's rule. */
const byName = (_source: SkillSource, result: ScanResult, query: string): string[] =>
  result.skills.map((skill) => skill.name).filter((name) => name.includes(query))

run('a blank or whitespace query is browsing, not searching', () => {
  assert.equal(isCrossSourceQuery(''), false)
  assert.equal(isCrossSourceQuery('   '), false)
  assert.equal(isCrossSourceQuery(' pdf'), true)
})

run('results come grouped by source, in tab order, from every scan already in hand', () => {
  const scans: Record<string, SkillScanLoad> = {
    [ACME.id]: { status: 'ready', scan: scan(['pdf-reader', 'csv-reader']) },
    [OFFICIAL.id]: { status: 'ready', scan: scan(['pdf-forms']) },
    [STUDIO.id]: { status: 'ready', scan: scan(['studio-review']) },
  }
  // Listed in the order they were added; the result reorders them the way the
  // tab row does — ours, Anthropic's, then the rest.
  const result = searchAcrossSources({ query: ' pdf ', sources: [ACME, OFFICIAL, STUDIO], scans, match: byName })
  assert.equal(result.query, 'pdf', 'the query is trimmed once, here')
  assert.deepEqual(
    result.sections.map((section) => [section.label, section.items]),
    [
      [OFFICIAL_PLUGINS_SKILL_SOURCE_NAME, ['pdf-forms']],
      ['acme/skills', ['pdf-reader']],
    ],
    'a source with no hit has no section, and a matching source wears its tab name',
  )
  assert.equal(result.sections[0].source?.id, OFFICIAL.id, 'the section carries its source, for the avatar')
  assert.equal(result.searched, 3)
  assert.equal(result.sourceCount, 3)
  assert.equal(result.total, 2)
  assert.deepEqual(result.unread, [])
  assert.equal(crossSourceStateLine(result), `Searched all 3 sources for “pdf”`)
  assert.equal(unreadSourcesLine(result.unread), null, 'nothing to admit when everything was searched')
})

run('a source whose scan is not in hand is not read for the search — it is named instead', () => {
  const scans: Record<string, SkillScanLoad> = {
    [STUDIO.id]: { status: 'ready', scan: scan(['pdf-tools']) },
    // ACME is loading; LATE has never been asked for (a repository nobody has
    // opened is a network read, and a keystroke must not spend it); BROKEN failed.
    [ACME.id]: { status: 'loading' },
    [BROKEN.id]: { status: 'error', message: 'rate limited' },
  }
  const result = searchAcrossSources({ query: 'pdf', sources: [STUDIO, ACME, LATE, BROKEN], scans, match: byName })
  assert.deepEqual(result.sections.map((section) => section.label), [STUDIO_SKILL_SOURCE_NAME])
  assert.equal(result.searched, 1)
  assert.deepEqual(
    result.unread.map((entry) => [entry.label, entry.state]),
    [
      ['acme/skills', 'loading'],
      ['late/skills', 'unscanned'],
      ['broken/skills', 'error'],
    ],
  )
  assert.equal(crossSourceStateLine(result), `Searched 1 of 4 sources for “pdf”`)
  assert.equal(
    unreadSourcesLine(result.unread),
    "1 source not yet read: late/skills. Open a source's tab to read it. "
      + '1 source still being read: acme/skills. '
      + '1 source could not be read: broken/skills.',
    'each kind of absence is said in its own words, and the sources are named',
  )
})

run('two unread sources pluralise, and only the kinds present are spoken', () => {
  assert.equal(
    unreadSourcesLine([
      { source: ACME, label: 'acme/skills', state: 'unscanned' },
      { source: LATE, label: 'late/skills', state: 'unscanned' },
    ]),
    "2 sources not yet read: acme/skills, late/skills. Open a source's tab to read it.",
  )
})

run('the Installed tab’s own rows lead, minus what a source already lists', () => {
  const scans: Record<string, SkillScanLoad> = {
    [ACME.id]: { status: 'ready', scan: scan(['pdf-reader']) },
  }
  const result = searchAcrossSources({
    query: 'pdf',
    sources: [ACME],
    scans,
    match: byName,
    // The workspace holds two skills with "pdf" in the name: one that ACME
    // lists (and marks installed on its own row) and one written by hand.
    installed: (hits) => ['pdf-reader', 'my-pdf-notes'].filter((name) => !hits.includes(name)),
  })
  assert.deepEqual(
    result.sections.map((section) => [section.key, section.label, section.items]),
    [
      ['installed', 'Installed', ['my-pdf-notes']],
      [ACME.id, 'acme/skills', ['pdf-reader']],
    ],
  )
  assert.equal(result.sections[0].source, null, 'the Installed section has no source to wear')
  assert.equal(result.total, 2)
})

run('no hit anywhere is an empty section list, not a section of nothing', () => {
  const result = searchAcrossSources({
    query: 'zzz',
    sources: [ACME],
    scans: { [ACME.id]: { status: 'ready', scan: scan(['pdf-reader']) } },
    match: byName,
    installed: () => [],
  })
  assert.deepEqual(result.sections, [])
  assert.equal(result.total, 0)
  assert.equal(result.searched, 1)
})

console.log('catalogue search: ok')
