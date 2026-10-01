import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { cloneTree } from './clone-tree'

let scratch = ''

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true })
  scratch = ''
})

test('files, folders and symlinks are copied', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sprintengine-clone-tree-'))
  const source = join(scratch, 'src')
  await mkdir(join(source, 'nested'), { recursive: true })
  await writeFile(join(source, 'nested', 'a.txt'), 'a\n')
  await symlink('nested/a.txt', join(source, 'link'))
  await cloneTree(source, join(scratch, 'dst'))
  assert.equal(await readFile(join(scratch, 'dst', 'nested', 'a.txt'), 'utf8'), 'a\n')
  assert.equal(await readlink(join(scratch, 'dst', 'link')), 'nested/a.txt')
})

// A FIFO opened for copying blocks until a writer appears, which never happens:
// the clone used to hang for good and pin a threadpool thread.
test.skipIf(process.platform === 'win32')('a FIFO is skipped rather than waited on', async () => {
  scratch = await mkdtemp(join(tmpdir(), 'sprintengine-clone-tree-'))
  const source = join(scratch, 'src')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'kept.txt'), 'kept\n')
  execFileSync('mkfifo', [join(source, 'pipe')])

  const outcome = await Promise.race([
    cloneTree(source, join(scratch, 'dst')).then(() => 'done'),
    new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3000).unref()),
  ])
  assert.equal(outcome, 'done')
  assert.equal(await readFile(join(scratch, 'dst', 'kept.txt'), 'utf8'), 'kept\n')
  await assert.rejects(lstat(join(scratch, 'dst', 'pipe')), { code: 'ENOENT' })
})
