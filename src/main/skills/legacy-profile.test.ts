// The profile rename must not cost anyone the sources they added.
//
// `multicode` became `sprintengine-studio` on 2026-09-08 and Electron moved
// userData with the name, so a person's `skill-sources.json` stayed in the old
// directory and the app started reading an empty one. Two sources —
// `anthropics/skills` and `mattpocock/skills` — were sitting in the old profile
// on the reporter's machine while the new one held nothing but the two
// always-present tabs.
//
// What is pinned here: what gets carried, what does not, that it happens once,
// and that a profile already in use is never touched.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  OFFICIAL_PLUGINS_SKILL_SOURCE_ID,
  STUDIO_SKILL_SOURCE_ID,
  type ScanResult,
  type SkillSource,
} from '../../shared/skills'
import { adoptLegacySkillSources, isDefaultProfileDir, planLegacySourceAdoption } from './legacy-profile'
import { createSkillSourceStore, parseSkillSourceState, type PersistedState } from './source-store'

function run(name: string, body: () => Promise<void> | void): Promise<void> | void {
  const done = (): void => console.log(`ok - ${name}`)
  try {
    const result = body()
    if (result instanceof Promise) {
      return result.then(done, (error) => {
        console.error(`not ok - ${name}`)
        throw error
      })
    }
    done()
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const scanOf = (skillId: string): ScanResult => ({
  skills: [
    {
      id: skillId,
      name: skillId,
      description: '',
      group: '',
      files: [{ path: 'SKILL.md', size: 10, blobSha: '', isEntry: true }],
      allowedTools: [],
      hasExecutables: false,
    },
  ],
  groups: [],
  groupingSignal: 'none',
  fileCount: 1,
  commitSha: '',
})

const repo = (name: string): SkillSource => ({
  id: `github:${name}`,
  kind: 'github',
  name: name.split('/')[1] ?? name,
  repo: name,
  monogram: 'XX',
  blurb: '',
  commitSha: 'abc1234',
  scannedAt: '2026-09-01T12:00:00.000Z',
})

const ANTHROPIC_SKILLS = repo('anthropics/skills')
const MATT = repo('mattpocock/skills')

/** The state the always-present tabs alone leave behind: no removable sources. */
const emptyish = (): PersistedState => ({
  sources: [{ ...repo('sprintengine/studio-releases'), id: STUDIO_SKILL_SOURCE_ID, name: 'SprintEngine Studio' }],
  scans: { [STUDIO_SKILL_SOURCE_ID]: scanOf('studio/thing') },
})

/** Two profiles side by side under one Application Support directory. */
function profiles(): { support: string; current: string; legacy: string } {
  const support = mkdtempSync(join(tmpdir(), 'multicode-profiles-'))
  return { support, current: join(support, 'sprintengine-studio'), legacy: join(support, 'multicode') }
}

function writeStore(dir: string, state: PersistedState): void {
  writeFileSync(join(dir, 'skill-sources.json'), JSON.stringify(state))
}

async function main(): Promise<void> {
  run('the plan carries the sources a person added, with their scans', () => {
    const plan = planLegacySourceAdoption(emptyish(), {
      sources: [
        ANTHROPIC_SKILLS,
        MATT,
        { ...repo('anthropics/claude-plugins-official'), id: OFFICIAL_PLUGINS_SKILL_SOURCE_ID },
      ],
      scans: {
        [ANTHROPIC_SKILLS.id]: scanOf('anthropics/pdf'),
        [MATT.id]: scanOf('matt/tsconfig'),
        [OFFICIAL_PLUGINS_SKILL_SOURCE_ID]: scanOf('official/thing'),
      },
    })
    assert.ok(plan, 'there is something to carry')
    assert.deepEqual(plan?.carried, [ANTHROPIC_SKILLS.id, MATT.id], 'only the ones a person added')
    assert.equal(plan?.scansCarried, 2, 'each with the scan cached beside it')
    assert.equal(
      plan?.state.scans[STUDIO_SKILL_SOURCE_ID]?.skills[0]?.id,
      'studio/thing',
      'and the current profile keeps everything it already had',
    )
  })

  run('a profile already holding sources of its own is left alone', () => {
    const current: PersistedState = { sources: [ANTHROPIC_SKILLS], scans: {} }
    assert.equal(
      planLegacySourceAdoption(current, { sources: [MATT], scans: {} }),
      null,
      'this is a rescue, not a sync: a live profile is never merged into',
    )
  })

  run('nothing is duplicated and no newer record is overruled', () => {
    // A source under the same id in both, and the current profile's scan is the
    // newer read of the two.
    const current: PersistedState = {
      sources: [{ ...repo('sprintengine/studio-releases'), id: STUDIO_SKILL_SOURCE_ID }],
      scans: { [STUDIO_SKILL_SOURCE_ID]: scanOf('new/read') },
    }
    const plan = planLegacySourceAdoption(current, {
      sources: [{ ...repo('sprintengine/studio-releases'), id: STUDIO_SKILL_SOURCE_ID }, MATT],
      scans: { [STUDIO_SKILL_SOURCE_ID]: scanOf('old/read'), [MATT.id]: scanOf('matt/tsconfig') },
    })
    assert.deepEqual(plan?.carried, [MATT.id])
    assert.equal(plan?.state.sources.filter((source) => source.id === STUDIO_SKILL_SOURCE_ID).length, 1)
    assert.equal(plan?.state.scans[STUDIO_SKILL_SOURCE_ID]?.skills[0]?.id, 'new/read', 'the newer scan stands')
  })

  run('an old profile with nothing a person added carries nothing', () => {
    assert.equal(planLegacySourceAdoption(emptyish(), { sources: [], scans: {} }), null)
  })

  await run('the sources come across, and the store reads them back', async () => {
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    writeStore(current, emptyish())
    writeStore(legacy, {
      sources: [ANTHROPIC_SKILLS, MATT],
      scans: { [ANTHROPIC_SKILLS.id]: scanOf('anthropics/pdf'), [MATT.id]: scanOf('matt/tsconfig') },
    })

    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.deepEqual(outcome.carried, [ANTHROPIC_SKILLS.id, MATT.id])

    // The real store over the real directory, which is the trip that matters:
    // this is what the person sees in the door.
    const store = createSkillSourceStore(current, { log: () => {} })
    const listed = (await store.listSources()).map((source) => source.id)
    assert.ok(listed.includes(ANTHROPIC_SKILLS.id) && listed.includes(MATT.id), 'both are in the list')
    assert.equal((await store.getScan(MATT.id))?.skills.length, 1, 'with the scan, so the tab lists offline')
    // The old profile is READ, never written: it is the only copy left.
    assert.equal(parseSkillSourceState(readFileSync(join(legacy, 'skill-sources.json'), 'utf8')).sources.length, 2)
  })

  await run('it runs once, even after the person removes what it brought', async () => {
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    writeStore(current, emptyish())
    writeStore(legacy, { sources: [MATT], scans: {} })

    assert.deepEqual(adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} }).carried, [
      MATT.id,
    ])
    assert.ok(existsSync(join(current, 'skill-sources-legacy-adoption.json')), 'a marker is written')

    const store = createSkillSourceStore(current, { log: () => {} })
    await store.removeSource(MATT.id)
    const second = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.equal(second.reason, 'already-run')
    const listed = (await store.listSources()).map((source) => source.id)
    assert.equal(listed.includes(MATT.id), false, 'a removal stays a removal')
  })

  await run('a machine with no old profile does nothing and says so', async () => {
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.equal(outcome.reason, 'no-legacy-profile')
    assert.equal(existsSync(join(current, 'skill-sources-legacy-adoption.json')), false, 'and marks nothing')
  })

  await run('an old profile that holds nothing worth carrying is marked and never read again', async () => {
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    writeStore(legacy, { sources: [], scans: {} })
    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.equal(outcome.reason, 'nothing-to-carry')
    assert.ok(existsSync(join(current, 'skill-sources-legacy-adoption.json')))
  })

  await run('a current store that cannot be read is never written over as though it were empty', async () => {
    // The store's own drop path, which this rescue must not reopen: a current
    // store that is unreadable for a moment used to parse to nothing, and the
    // plan was then renamed over the top of it — every source it held, gone.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    const held: PersistedState = {
      sources: [ANTHROPIC_SKILLS],
      scans: { [ANTHROPIC_SKILLS.id]: scanOf('anthropics/pdf') },
    }
    writeStore(current, held)
    writeStore(legacy, { sources: [MATT], scans: {} })
    const path = join(current, 'skill-sources.json')
    chmodSync(path, 0o000)

    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    chmodSync(path, 0o600)
    assert.equal(outcome.reason, 'failed', 'the rescue aborts')
    assert.equal(
      existsSync(join(current, 'skill-sources-legacy-adoption.json')),
      false,
      'and does not mark itself done',
    )
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), held, 'the current store is exactly as it was')

    // Readable again next launch: the rescue runs, and a store already in use
    // is left alone — the marker records that.
    assert.equal(
      adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} }).reason,
      'nothing-to-carry',
    )
  })

  await run('current bytes that are not JSON are left for the store to quarantine', async () => {
    // Same ruling, other cause. The store keeps unparsable bytes aside under a
    // timestamped name on its next write; the rescue must not destroy them
    // first by writing a fresh file where they were.
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    const garbage = '{"sources":[{"id":"github:acme/skills"'
    writeFileSync(join(current, 'skill-sources.json'), garbage)
    writeStore(legacy, { sources: [MATT], scans: {} })

    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.equal(outcome.reason, 'failed')
    assert.equal(readFileSync(join(current, 'skill-sources.json'), 'utf8'), garbage, 'byte for byte')
    assert.equal(existsSync(join(current, 'skill-sources-legacy-adoption.json')), false)
  })

  await run('an old store nobody can parse carries nothing, and is marked so', async () => {
    const { current, legacy } = profiles()
    await mkdir(current, { recursive: true })
    await mkdir(legacy, { recursive: true })
    writeFileSync(join(legacy, 'skill-sources.json'), 'not a store')
    const outcome = adoptLegacySkillSources({ userDataDir: current, legacyDir: legacy, log: () => {} })
    assert.equal(outcome.reason, 'nothing-to-carry')
    assert.ok(existsSync(join(current, 'skill-sources-legacy-adoption.json')))
  })

  run('the gate is the profile name, so a dev instance is excluded and a dev run is not', () => {
    assert.equal(
      isDefaultProfileDir('/Users/me/Library/Application Support/sprintengine-studio', 'sprintengine-studio'),
      true,
    )
    assert.equal(
      isDefaultProfileDir('/Users/me/Library/Application Support/multicode-dev-5174', 'sprintengine-studio'),
      false,
    )
  })

  console.log('legacy profile adoption tests passed')
}

void main()
