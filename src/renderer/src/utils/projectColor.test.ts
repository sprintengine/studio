import assert from 'node:assert/strict'

import {
  PROJECT_COLORS,
  isProjectColor,
  isProjectColorSetting,
  pickProjectColor,
  projectColorGlyphClass,
  projectColorKey,
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

// ---------------------------------------------------------- allocation

run('a fresh install hands out the hues in order, one project at a time', () => {
  const assigned: ProjectColorSetting[] = []
  for (const expected of PROJECT_COLORS) {
    const picked = pickProjectColor(assigned)
    assert.equal(picked, expected)
    assigned.push(picked)
  }
  assert.deepEqual(assigned, [...PROJECT_COLORS])
})

run('two open projects never receive the same hue', () => {
  assert.equal(pickProjectColor([]), 'blue')
  assert.equal(pickProjectColor(['blue']), 'teal')
  assert.equal(pickProjectColor(['blue', 'teal']), 'cyan')
})

run('a gap in the middle is filled before the untouched tail', () => {
  // blue and cyan are taken; teal is the first free hue in list order.
  assert.equal(pickProjectColor(['blue', 'cyan']), 'teal')
  assert.equal(pickProjectColor(['blue', 'teal', 'cyan', 'orange']), 'violet')
})

run('with all six used, the least-used hue is reused', () => {
  const used: ProjectColorSetting[] = [...PROJECT_COLORS, 'blue', 'teal', 'cyan', 'violet', 'orange']
  // Every hue is used twice except red, which is used once.
  assert.equal(pickProjectColor(used), 'red')
})

run('a tie among the least-used goes to the earliest hue in the list', () => {
  // All six used exactly once: every count ties at 1, so the first wins.
  assert.equal(pickProjectColor([...PROJECT_COLORS]), 'blue')
  // Blue and teal are used twice, the rest once: cyan is the earliest of the ones.
  assert.equal(pickProjectColor([...PROJECT_COLORS, 'blue', 'teal']), 'cyan')
})

run("'none' is a choice, not a use: it never counts toward allocation", () => {
  assert.equal(pickProjectColor(['none', 'none', 'none']), 'blue')
  assert.equal(pickProjectColor(['blue', 'none', 'teal']), 'cyan')
})

run('null, undefined and unknown values are ignored rather than counted', () => {
  const noisy: Array<ProjectColorSetting | null | undefined> = [
    'blue',
    null,
    undefined,
    'chartreuse' as unknown as ProjectColorSetting,
    'teal',
  ]
  assert.equal(pickProjectColor(noisy), 'cyan')
})

run('allocation reads any iterable, including a settings map values view', () => {
  const stored: Record<string, ProjectColorSetting> = {
    'repo:github.com/acme/a': 'blue',
    'repo:github.com/acme/b': 'teal',
    'folder:/tmp/c': 'none',
  }
  assert.equal(pickProjectColor(Object.values(stored)), 'cyan')
})

// -------------------------------------------------------------- lookup

run('resolveProjectColor returns null for a missing key, a missing entry and none', () => {
  const stored: Record<string, ProjectColorSetting> = { 'repo:a': 'violet', 'repo:b': 'none' }
  assert.equal(resolveProjectColor(stored, 'repo:a'), 'violet')
  assert.equal(resolveProjectColor(stored, 'repo:b'), null, "'none' is no colour")
  assert.equal(resolveProjectColor(stored, 'repo:unseen'), null)
  assert.equal(resolveProjectColor(stored, null), null)
  assert.equal(resolveProjectColor(undefined, 'repo:a'), null)
})

run('every hue has a glyph class, and no colour has none', () => {
  for (const color of PROJECT_COLORS) {
    assert.equal(projectColorGlyphClass(color), `project-mark-${color}`)
  }
  assert.equal(projectColorGlyphClass(null), '')
  assert.equal(projectColorGlyphClass(undefined), '')
})

run('the guards accept exactly the palette, and none only as a setting', () => {
  for (const color of PROJECT_COLORS) {
    assert.equal(isProjectColor(color), true)
    assert.equal(isProjectColorSetting(color), true)
  }
  assert.equal(isProjectColor('none'), false)
  assert.equal(isProjectColorSetting('none'), true)
  // Gold and green are deliberately absent: they are the waiting and finished
  // row tints, and may not double as a project's colour on the same row.
  for (const rejected of ['yellow', 'gold', 'green', 'purple', '', null, undefined, 7, {}]) {
    assert.equal(isProjectColor(rejected), false)
    assert.equal(isProjectColorSetting(rejected), false)
  }
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
