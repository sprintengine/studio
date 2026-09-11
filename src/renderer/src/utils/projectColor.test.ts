import assert from 'node:assert/strict'

import {
  PROJECT_COLOR_PRESETS,
  isProjectColor,
  isProjectColorSetting,
  projectColorKey,
  projectColorStyle,
  projectHue,
  resolveProjectColor,
  type ProjectColorSetting,
} from './projectColor'

const tests: Array<{ name: string; body: () => void }> = []

function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

// ---------------------------------------------------------------- key

run('the repository key wins over the folder path, so two clones are one project', () => {
  const local = projectColorKey({
    folderPath: '/Users/me/code/multicode',
    repository: { canonicalKey: 'github.com/acme/multicode' },
  })
  const paired = projectColorKey({
    folderPath: 'D:\\work\\multicode-checkout',
    repository: { canonicalKey: 'github.com/acme/multicode' },
  })
  assert.equal(local, 'repo:github.com/acme/multicode')
  assert.equal(local, paired)
})

run('a repository key is lower-cased and trimmed, so one repo is never two keys', () => {
  assert.equal(
    projectColorKey({ folderPath: null, repository: { canonicalKey: '  GitHub.com/Acme/Multicode ' } }),
    'repo:github.com/acme/multicode',
  )
})

run('a folder with no remote keys off its normalised path', () => {
  const forward = projectColorKey({ folderPath: '/Users/me/Notes/' })
  const backward = projectColorKey({ folderPath: '\\Users\\me\\Notes', repository: null })
  assert.equal(forward, 'folder:/users/me/notes')
  assert.equal(forward, backward, 'two spellings of one folder are one project')
})

run('an empty or absent canonical key falls through to the folder', () => {
  assert.equal(
    projectColorKey({ folderPath: '/tmp/x', repository: { canonicalKey: '   ' } }),
    'folder:/tmp/x',
  )
  assert.equal(projectColorKey({ folderPath: '/tmp/x', repository: null }), 'folder:/tmp/x')
})

run('no folder is not a project: the key is null, never a sentinel', () => {
  assert.equal(projectColorKey({ folderPath: null }), null)
  assert.equal(projectColorKey({ folderPath: undefined }), null)
  assert.equal(projectColorKey({ folderPath: '   ' }), null)
  assert.equal(projectColorKey({ folderPath: '', repository: null }), null)
})

run('the two kinds of key are prefixed, so a path can never collide with a repo key', () => {
  const repo = projectColorKey({ folderPath: null, repository: { canonicalKey: 'github.com/acme/x' } })
  const folder = projectColorKey({ folderPath: '/github.com/acme/x' })
  assert.equal(repo, 'repo:github.com/acme/x')
  assert.equal(folder, 'folder:/github.com/acme/x')
  assert.notEqual(repo, folder)
})

// ---------------------------------------------------------------- hash

run('the hash is pinned: changing it would recolour every project for everyone', () => {
  // Golden values. If one of these moves, every person's every project changes
  // colour on their next launch — that has to be a decision, not a refactor.
  assert.equal(projectHue('repo:github.com/acme/multicode'), 301)
  assert.equal(projectHue('repo:github.com/acme/api'), 36)
  assert.equal(projectHue('folder:/users/me/notes'), 53)
})

run('one repository is one hue on every machine, however it was cloned', () => {
  const mac = projectColorKey({ folderPath: '/Users/me/code/multicode', repository: { canonicalKey: 'github.com/acme/multicode' } })
  const windows = projectColorKey({ folderPath: 'D:\\work\\mc', repository: { canonicalKey: 'GitHub.com/Acme/Multicode' } })
  assert.equal(projectHue(mac!), projectHue(windows!))
})

run('two organisations with a repository of the same name are different projects', () => {
  assert.notEqual(projectHue('repo:github.com/acme/api'), projectHue('repo:github.com/other/api'))
})

run('a folder with no remote hashes its NAME, so it agrees across machines whose paths differ', () => {
  const mine = projectColorKey({ folderPath: '/Users/me/notes' })
  const theirs = projectColorKey({ folderPath: '/home/b/notes/' })
  assert.notEqual(mine, theirs, 'the keys still differ — an override stays this folder’s')
  assert.equal(projectHue(mine!), projectHue(theirs!), 'but the hue is the same')
})

run('every hue is a whole degree on the wheel, and the wheel is used evenly', () => {
  const buckets = new Array<number>(12).fill(0)
  for (let index = 0; index < 3600; index += 1) {
    const hue = projectHue(`repo:github.com/org/repo-${index}`)
    assert.ok(isProjectColor(hue), `hue ${hue} is a whole degree in [0, 360)`)
    buckets[Math.floor(hue / 30)] += 1
  }
  // 300 expected per 30°; a hash that clumped (a bare modulo of FNV's low bits
  // on near-identical names does) would leave whole sectors of the wheel dark.
  for (const count of buckets) assert.ok(count > 240 && count < 360, `each 30° sector is used: ${buckets.join(' ')}`)
})

// -------------------------------------------------------------- lookup

run('with no override a project wears its hashed hue; an override wins; none is no colour', () => {
  const stored: Record<string, ProjectColorSetting> = { 'repo:a': 145, 'repo:b': 'none' }
  assert.equal(resolveProjectColor(stored, 'repo:a'), 145, 'the person’s choice')
  assert.equal(resolveProjectColor(stored, 'repo:b'), null, "'none' is no colour")
  assert.equal(resolveProjectColor(stored, 'repo:unseen'), projectHue('repo:unseen'), 'absent is the hash, not nothing')
  assert.equal(resolveProjectColor(undefined, 'repo:unseen'), projectHue('repo:unseen'))
  assert.equal(resolveProjectColor(stored, 0 as never), null)
  assert.equal(resolveProjectColor(stored, null), null, 'no key is no project')
  assert.equal(resolveProjectColor(stored, ''), null)
})

run('an override of hue 0 is a hue, not a missing one', () => {
  assert.equal(resolveProjectColor({ 'repo:red': 0 }, 'repo:red'), 0)
})

run('the style carries the angle and nothing else, and no colour carries no style', () => {
  assert.deepEqual(projectColorStyle(200), { '--project-hue': 200 })
  assert.deepEqual(projectColorStyle(0), { '--project-hue': 0 })
  assert.equal(projectColorStyle(null), undefined)
  assert.equal(projectColorStyle(undefined), undefined)
})

run('the guards accept whole degrees and none, and nothing else', () => {
  for (const hue of [0, 1, 180, 359]) {
    assert.equal(isProjectColor(hue), true)
    assert.equal(isProjectColorSetting(hue), true)
  }
  assert.equal(isProjectColor('none'), false)
  assert.equal(isProjectColorSetting('none'), true)
  // The 2026-09-09 build stored hue NAMES. They are not settings any more, so a
  // settings file from that build drops them and the projects return to their
  // hashed hues — the same on every machine.
  for (const rejected of ['blue', 'teal', 'red', 360, -1, 12.5, Number.NaN, '120', '', null, undefined, {}]) {
    assert.equal(isProjectColor(rejected), false, `${String(rejected)} is not a hue`)
    assert.equal(isProjectColorSetting(rejected), false, `${String(rejected)} is not a setting`)
  }
})

run('the presets are distinct named hues around the whole wheel, yellow and green included', () => {
  const hues = PROJECT_COLOR_PRESETS.map((preset) => preset.hue)
  assert.equal(new Set(hues).size, hues.length, 'no two presets share a hue')
  assert.equal(new Set(PROJECT_COLOR_PRESETS.map((preset) => preset.label)).size, hues.length, 'or a name')
  for (const hue of hues) assert.ok(isProjectColor(hue))
  const labels = PROJECT_COLOR_PRESETS.map((preset) => preset.label)
  for (const wanted of ['Yellow', 'Green', 'Blue', 'Pink', 'Cyan']) assert.ok(labels.includes(wanted), `${wanted} is offered`)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('projectColor.test.ts: ok')
}

main()
