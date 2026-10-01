import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  comparablePath,
  distroOfUncPath,
  isWindowsPath,
  isWslDriveMountPath,
  linuxPathUnderRoot,
  toWslPath,
  wslInputInRootSpelling,
  wslToWindowsPath,
} from './host-paths'
import { permissionModeAllows } from './conversation/permissionModes'

// One row per spelling a path arrives in, and what each conversion makes of it.
// `null` in the Windows column means "unchanged" (the input comes back as is).
type Row = {
  input: string
  wsl: string
  windows: string | null
  windowsInUbuntu: string | null
  distro: string | null
  comparable: string
}

const ROWS: Row[] = [
  {
    input: 'C:\\Users\\dev\\repo',
    wsl: '/mnt/c/Users/dev/repo',
    windows: null,
    windowsInUbuntu: null,
    distro: null,
    comparable: 'c:/users/dev/repo',
  },
  {
    input: 'D:/work/app/',
    wsl: '/mnt/d/work/app/',
    windows: null,
    windowsInUbuntu: null,
    distro: null,
    comparable: 'd:/work/app',
  },
  {
    input: 'C:',
    wsl: '/mnt/c/',
    windows: null,
    windowsInUbuntu: null,
    distro: null,
    comparable: 'c:',
  },
  {
    input: '\\\\wsl$\\Ubuntu\\home\\dev\\repo',
    wsl: '/home/dev/repo',
    windows: null,
    windowsInUbuntu: null,
    distro: 'Ubuntu',
    comparable: '//wsl.localhost/ubuntu/home/dev/repo',
  },
  {
    input: '\\\\wsl.localhost\\Debian\\home\\dev',
    wsl: '/home/dev',
    windows: null,
    windowsInUbuntu: null,
    distro: 'Debian',
    comparable: '//wsl.localhost/debian/home/dev',
  },
  {
    input: '\\\\WSL.LOCALHOST\\Ubuntu-24.04',
    wsl: '/',
    windows: null,
    windowsInUbuntu: null,
    distro: 'Ubuntu-24.04',
    comparable: '//wsl.localhost/ubuntu-24.04',
  },
  {
    input: '//wsl.localhost/Ubuntu/home/dev/repo',
    wsl: '/home/dev/repo',
    windows: null,
    windowsInUbuntu: null,
    distro: 'Ubuntu',
    comparable: '//wsl.localhost/ubuntu/home/dev/repo',
  },
  {
    input: '/mnt/c/Users/dev/repo',
    wsl: '/mnt/c/Users/dev/repo',
    windows: 'C:\\Users\\dev\\repo',
    windowsInUbuntu: 'C:\\Users\\dev\\repo',
    distro: null,
    comparable: 'c:/users/dev/repo',
  },
  {
    input: '/mnt/d',
    wsl: '/mnt/d',
    windows: 'D:\\',
    windowsInUbuntu: 'D:\\',
    distro: null,
    comparable: 'd:/',
  },
  {
    input: '/home/dev/repo',
    wsl: '/home/dev/repo',
    windows: null,
    windowsInUbuntu: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo',
    distro: null,
    comparable: '/home/dev/repo',
  },
  {
    input: '/Users/dev/repo/',
    wsl: '/Users/dev/repo/',
    windows: null,
    windowsInUbuntu: '\\\\wsl.localhost\\Ubuntu\\Users\\dev\\repo',
    distro: null,
    comparable: '/Users/dev/repo',
  },
  {
    input: 'relative/dir',
    wsl: 'relative/dir',
    windows: null,
    windowsInUbuntu: null,
    distro: null,
    comparable: 'relative/dir',
  },
]

for (const row of ROWS) {
  test(`host paths: ${row.input}`, () => {
    assert.equal(toWslPath(row.input), row.wsl, 'toWslPath')
    assert.equal(wslToWindowsPath(row.input), row.windows ?? row.input, 'wslToWindowsPath')
    assert.equal(
      wslToWindowsPath(row.input, { distro: 'Ubuntu' }),
      row.windowsInUbuntu ?? row.input,
      'wslToWindowsPath in Ubuntu',
    )
    assert.equal(distroOfUncPath(row.input), row.distro, 'distroOfUncPath')
    assert.equal(comparablePath(row.input), row.comparable, 'comparablePath')
  })
}

test('toWslPath is idempotent', () => {
  for (const row of ROWS) assert.equal(toWslPath(toWslPath(row.input)), row.wsl, row.input)
})

test('a drive path survives the round trip through WSL', () => {
  assert.equal(wslToWindowsPath(toWslPath('C:\\Users\\dev\\repo')), 'C:\\Users\\dev\\repo')
  assert.equal(
    wslToWindowsPath(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\dev'), { distro: 'Ubuntu' }),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  )
})

test('the separator of a Windows result can be forward', () => {
  assert.equal(wslToWindowsPath('/mnt/c/Users/me/proj', { separator: '/' }), 'C:/Users/me/proj')
  assert.equal(wslToWindowsPath('/mnt/d', { separator: '/' }), 'D:/')
})

test('drive letters compare without regard to case, Linux paths with it', () => {
  assert.equal(comparablePath('C:\\Users\\Dev'), comparablePath('/mnt/c/users/dev/'))
  assert.notEqual(comparablePath('/home/Dev'), comparablePath('/home/dev'))
})

test("a distribution's two share names, in any case, are one folder; the Linux path after them is not folded", () => {
  // A workspace stored under `\\wsl$\` against git's `//wsl.localhost/` answer.
  assert.equal(
    comparablePath('\\\\wsl$\\Ubuntu\\home\\dev\\repo\\'),
    comparablePath('//wsl.localhost/Ubuntu/home/dev/repo'),
  )
  assert.equal(comparablePath('\\\\WSL.LOCALHOST\\UBUNTU\\home\\dev'), comparablePath('\\\\wsl$\\ubuntu\\home\\dev'))
  assert.notEqual(comparablePath('\\\\wsl$\\Ubuntu\\home\\Dev'), comparablePath('\\\\wsl$\\Ubuntu\\home\\dev'))
  assert.notEqual(comparablePath('\\\\wsl$\\Ubuntu\\home\\dev'), comparablePath('\\\\wsl$\\Debian\\home\\dev'))
})

test('which paths Windows opens as they are', () => {
  assert.equal(isWindowsPath('C:\\x'), true)
  assert.equal(isWindowsPath('c:/x'), true)
  assert.equal(isWindowsPath('\\\\server\\share'), true)
  assert.equal(isWindowsPath('/mnt/c/x'), false)
  assert.equal(isWindowsPath('C:'), false, 'a bare drive is drive-relative, not a path')
  assert.equal(isWslDriveMountPath('/mnt/c'), true)
  assert.equal(isWslDriveMountPath('\\mnt\\c\\x'), true)
  assert.equal(isWslDriveMountPath('/mnt/cd/x'), false)
})

test('a Linux path joins the root wslpath prints for the distribution', () => {
  assert.equal(
    linuxPathUnderRoot('/home/dev/.claude', '\\\\wsl.localhost\\Ubuntu\\'),
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.claude',
  )
  assert.equal(linuxPathUnderRoot('/', '\\\\wsl$\\Debian'), '\\\\wsl$\\Debian')
})

// A WSL agent names files the Linux way; the workspace root is a Windows path.
// Auto placed every file in the workspace outside it and approved nothing.
test("a WSL agent's paths are placed against the root as the root spells them", () => {
  const share = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo'
  const auto = (action: string, root: string, file: string) =>
    permissionModeAllows('auto', { action, input: wslInputInRootSpelling({ file_path: file }, root, 'Ubuntu') }, root)

  assert.equal(auto('Edit', 'C:\\Users\\dev\\repo', '/mnt/c/Users/dev/repo/src/a.ts'), true)
  assert.equal(auto('Edit', 'C:\\Users\\dev\\repo', '/mnt/c/Users/dev/other/a.ts'), false)
  assert.equal(auto('Edit', share, '/home/dev/repo/src/a.ts'), true)
  assert.equal(
    auto('Read', '\\\\wsl$\\Ubuntu\\home\\dev\\repo', '/home/dev/repo/README.md'),
    true,
    "the root's own share name",
  )
  assert.equal(auto('Read', share, '/etc/passwd'), false)
  assert.equal(auto('Edit', share, '/home/dev/repo/../../x'), false, 'a climb out stays out')
  assert.equal(auto('Edit', share, '/home/dev/repo/.git/hooks/pre-commit'), false, 'never the git directory')
})

test('only whole paths are respelled, and the input itself is left alone', () => {
  const input = { file_path: '/home/dev/repo/a.ts', command: 'cat /home/dev/repo/a.ts', edits: [{ path: '/mnt/d/x' }] }
  const respelled = wslInputInRootSpelling(input, 'C:\\Users\\dev\\repo', 'Ubuntu')
  assert.deepEqual(respelled, {
    file_path: '//wsl.localhost/Ubuntu/home/dev/repo/a.ts',
    command: 'cat /home/dev/repo/a.ts',
    edits: [{ path: 'D:/x' }],
  })
  assert.equal(input.file_path, '/home/dev/repo/a.ts')
})
