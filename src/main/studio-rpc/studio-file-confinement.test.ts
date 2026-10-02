import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'vitest'

import { OUTSIDE_CHAT_FOLDERS, confineToRoots, isPlainAbsolutePath } from './studio-file-confinement'

// What the chat surface may stat or read: a file really inside a chat's
// folders, named by its one plain spelling. A traversal, a symlink out, or
// another spelling of a path is refused, so a wider scope later cannot read
// the rest of the disk through these methods.

const made: string[] = []
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function layout() {
  // Real paths throughout: on macOS the temp folder is itself behind a symlink.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'studio-confine-')))
  made.push(base)
  const workspace = join(base, 'app')
  const elsewhere = join(base, 'elsewhere')
  await mkdir(join(workspace, 'shots'), { recursive: true })
  await mkdir(elsewhere)
  await writeFile(join(workspace, 'shots', 'a.png'), 'png')
  await writeFile(join(elsewhere, 'secret.png'), 'png')
  await symlink(join(elsewhere, 'secret.png'), join(workspace, 'shots', 'escape.png'))
  await symlink(join(workspace, 'shots', 'a.png'), join(workspace, 'alias.png'))
  return { base, workspace, elsewhere }
}

const refused = (result: Awaited<ReturnType<typeof confineToRoots>>) => (result.ok ? null : result.message)

test('a file inside a chat’s folder is read by its real path; one outside is refused', async () => {
  const { workspace, elsewhere } = await layout()
  assert.deepEqual(await confineToRoots(join(workspace, 'shots', 'a.png'), [workspace]), {
    ok: true,
    path: join(workspace, 'shots', 'a.png'),
  })
  assert.equal(refused(await confineToRoots(join(elsewhere, 'secret.png'), [workspace])), OUTSIDE_CHAT_FOLDERS)
  // A folder named with a trailing separator, as a transcript names one, is that folder.
  assert.deepEqual(await confineToRoots(`${workspace}/shots/`, [workspace]), {
    ok: true,
    path: join(workspace, 'shots'),
  })
  // A file not written yet is judged by the folder it would be in.
  assert.equal((await confineToRoots(join(workspace, 'shots', 'later.png'), [workspace])).ok, true)
  assert.equal(refused(await confineToRoots(join(elsewhere, 'later.png'), [workspace])), OUTSIDE_CHAT_FOLDERS)
  // A root that is gone is passed over, not taken as the whole disk.
  assert.equal(
    refused(await confineToRoots(join(workspace, 'shots', 'a.png'), [join(workspace, 'gone')])),
    OUTSIDE_CHAT_FOLDERS,
  )
})

test('a symlink that leads out of the folder is refused; one that stays inside is followed', async () => {
  const { workspace } = await layout()
  assert.equal(refused(await confineToRoots(join(workspace, 'shots', 'escape.png'), [workspace])), OUTSIDE_CHAT_FOLDERS)
  assert.deepEqual(await confineToRoots(join(workspace, 'alias.png'), [workspace]), {
    ok: true,
    path: join(workspace, 'shots', 'a.png'),
  })
})

test('a traversal, or any spelling of a path but its plain one, is refused before the disk is asked', async () => {
  const { workspace, base } = await layout()
  for (const spelling of [
    `${workspace}/shots/../../elsewhere/secret.png`,
    `${workspace}/shots/../shots/a.png`,
    `${workspace}/./shots/a.png`,
    `${workspace}//shots/a.png`,
    'shots/a.png',
    `${workspace}/shots/a.png\0.txt`,
  ])
    assert.equal(
      refused(await confineToRoots(spelling, [workspace])),
      'That path is not written plainly; name the file by its own path.',
      spelling,
    )
  assert.equal(
    refused(await confineToRoots(42, [workspace])),
    'That path is not written plainly; name the file by its own path.',
  )
  // On a disk that ignores case, the same file under another case is another spelling.
  const upper = join(base, 'APP', 'shots', 'a.png')
  const sameFile = await realpath(upper).catch(() => null)
  if (sameFile)
    assert.equal(
      refused(await confineToRoots(upper, [workspace])),
      'That path is not written plainly; name the file by its own path.',
    )
})

test('on Windows, device and UNC prefixes, short names, streams and trailing dots are other spellings', () => {
  assert.equal(isPlainAbsolutePath('C:\\Users\\dev\\app\\a.png', 'win32'), true)
  assert.equal(isPlainAbsolutePath('C:\\Users\\dev\\app\\', 'win32'), true)
  for (const spelling of [
    '\\\\?\\C:\\Users\\dev\\app\\a.png',
    '\\\\.\\C:\\Users\\dev\\app\\a.png',
    '\\\\build-box\\share\\a.png',
    'C:Users\\dev\\a.png',
    'C:\\Users\\dev\\app\\..\\secret.png',
    'C:\\Users\\dev\\APP~1\\a.png',
    'C:\\Users\\dev\\app\\a.png:hidden',
    'C:\\Users\\dev\\app\\a.png.',
    'C:\\Users\\dev\\app\\a.png ',
    'C:\\Users\\dev\\app/a.png',
  ])
    assert.equal(isPlainAbsolutePath(spelling, 'win32'), false, spelling)
})
