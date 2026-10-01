import assert from 'node:assert/strict'
import { test } from 'vitest'

import { resolveWindowsProgramOnPath } from './command-on-path'

const present =
  (...paths: string[]) =>
  async (path: string): Promise<boolean> =>
    paths.includes(path)

test('a Windows program is found in the first absolute PATH folder that has it', async () => {
  const resolved = await resolveWindowsProgramOnPath('gh', {
    pathValue: 'C:\\Windows\\system32;C:\\Program Files\\GitHub CLI;C:\\tools',
    exists: present('C:\\Program Files\\GitHub CLI\\gh.exe', 'C:\\tools\\gh.exe'),
  })
  assert.equal(resolved, 'C:\\Program Files\\GitHub CLI\\gh.exe')
})

test('an empty or relative PATH entry is skipped, because it means the working directory', async () => {
  const resolved = await resolveWindowsProgramOnPath('gh', {
    pathValue: ';.;bin;C:drive-relative;C:\\Program Files\\GitHub CLI',
    exists: async (path) => path.endsWith('gh.exe'),
  })
  assert.equal(resolved, 'C:\\Program Files\\GitHub CLI\\gh.exe')
})

test('a quoted PATH entry is read without its quotes', async () => {
  const resolved = await resolveWindowsProgramOnPath('gh', {
    pathValue: '"C:\\Program Files\\GitHub CLI"',
    exists: present('C:\\Program Files\\GitHub CLI\\gh.exe'),
  })
  assert.equal(resolved, 'C:\\Program Files\\GitHub CLI\\gh.exe')
})

test('a .cmd or .bat shim is not taken, since it would run through cmd.exe', async () => {
  const resolved = await resolveWindowsProgramOnPath('gh', {
    pathValue: 'C:\\shims',
    exists: present('C:\\shims\\gh.cmd', 'C:\\shims\\gh.bat'),
  })
  assert.equal(resolved, null)
})
