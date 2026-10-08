import assert from 'node:assert/strict'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { ensureSidecarDirNoLinks, SidecarLinkError, sidecarLinkOnPath } from './workspace-sidecar'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'se-sidecar-'))
  made.push(dir)
  return dir
}

test('the sidecar folder is made one level at a time, and its first folder ignores itself', async () => {
  const root = folder()
  const dir = await ensureSidecarDirNoLinks(root, 'browser', 'recordings')
  assert.equal(dir, join(root, '.sprintengine', 'browser', 'recordings'))
  assert.ok(lstatSync(dir).isDirectory())
  assert.equal(readFileSync(join(root, '.sprintengine', 'browser', '.gitignore'), 'utf8'), '*\n')
  // A second call keeps the folders and an ignore file the person edited.
  writeFileSync(join(root, '.sprintengine', 'browser', '.gitignore'), '*.png\n')
  await ensureSidecarDirNoLinks(root, 'browser', 'recordings')
  assert.equal(readFileSync(join(root, '.sprintengine', 'browser', '.gitignore'), 'utf8'), '*.png\n')
})

test('a link anywhere from the sidecar root down is refused, and its target is left alone', async () => {
  for (const linked of [['.sprintengine'], ['.sprintengine', 'browser'], ['.sprintengine', 'browser', 'recordings']]) {
    const root = folder()
    const elsewhere = folder()
    mkdirSync(join(root, ...linked.slice(0, -1)), { recursive: true })
    symlinkSync(elsewhere, join(root, ...linked))
    await assert.rejects(ensureSidecarDirNoLinks(root, 'browser', 'recordings'), SidecarLinkError, linked.join('/'))
    assert.deepEqual(readdirSync(elsewhere), [], linked.join('/'))
  }
})

test('an ignore file the project made a link is not written through', async () => {
  const root = folder()
  const outside = join(folder(), 'outside.txt')
  writeFileSync(outside, 'untouched')
  mkdirSync(join(root, '.sprintengine', 'browser'), { recursive: true })
  symlinkSync(outside, join(root, '.sprintengine', 'browser', '.gitignore'))
  await ensureSidecarDirNoLinks(root, 'browser')
  assert.equal(readFileSync(outside, 'utf8'), 'untouched')
})

test('the first link on a sidecar path is named; a path not made yet has none', async () => {
  const root = folder()
  const sidecar = join(root, '.sprintengine')
  assert.equal(await sidecarLinkOnPath(sidecar, join(sidecar, 'modules', 'a', 'k.json')), null)
  mkdirSync(join(sidecar, 'modules'), { recursive: true })
  symlinkSync(folder(), join(sidecar, 'modules', 'a'))
  assert.equal(await sidecarLinkOnPath(sidecar, join(sidecar, 'modules', 'a', 'k.json')), join(sidecar, 'modules', 'a'))
})
