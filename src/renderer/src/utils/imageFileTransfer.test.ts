import assert from 'node:assert/strict'
import { test } from 'vitest'

import {
  isPathInside,
  pastedImagePaths,
  pathsForPathlessFiles,
  readPastedImagePaths,
  splitShellWords,
} from './imageFileTransfer'

test('a pasted screenshot path is read however it was quoted', () => {
  const path = '/var/folders/x1/T/TemporaryItems/Screenshot 2026-09-27 at 22.41.31.png'
  assert.deepEqual(pastedImagePaths(`'${path}'`), [path])
  assert.deepEqual(pastedImagePaths(`"${path}"`), [path])
  assert.deepEqual(pastedImagePaths(path.replace(/ /g, '\\ ')), [path])
  assert.deepEqual(pastedImagePaths(`${path}\n`), [path], 'a trailing newline is not part of the path')
  assert.deepEqual(pastedImagePaths(path), [path], 'one path pasted bare keeps its spaces')
})

test('several pasted image paths are each read, in order', () => {
  assert.deepEqual(pastedImagePaths("'/Users/dev/a b.png' /Users/dev/c.JPG\n/Users/dev/d\\ e.webp"), [
    '/Users/dev/a b.png',
    '/Users/dev/c.JPG',
    '/Users/dev/d e.webp',
  ])
  assert.deepEqual(pastedImagePaths('file:///Users/dev/shot%201.gif'), ['/Users/dev/shot 1.gif'])
  assert.deepEqual(pastedImagePaths('C:\\Users\\dev\\Pictures\\shot.png'), ['C:\\Users\\dev\\Pictures\\shot.png'])
  assert.deepEqual(pastedImagePaths('"C:\\Users\\dev\\shot one.png"'), ['C:\\Users\\dev\\shot one.png'])
})

test('a paste that is anything more than image paths stays text', () => {
  for (const text of [
    '',
    'look at /Users/dev/a.png',
    '/Users/dev/notes.txt',
    'relative/shot.png',
    "'/Users/dev/unclosed.png",
    '/Users/dev/a.png and more words',
    '/Users/dev/a.png\n/Users/dev/b.pdf',
    '~/Desktop/shot.png',
    '/Users/dev/compare this with /Users/dev/shot.png',
  ]) {
    assert.equal(pastedImagePaths(text), null, JSON.stringify(text))
  }
})

test('an image inside the project is typed as its path; only one from outside attaches', () => {
  const roots = ['/Users/dev/repo']
  assert.equal(pastedImagePaths('/Users/dev/repo/public/logo.png', roots), null, 'the agent can open it itself')
  assert.equal(pastedImagePaths("'/Users/dev/repo/docs/shot one.png'", roots), null)
  assert.deepEqual(pastedImagePaths('/Users/dev/Downloads/logo.png', roots), ['/Users/dev/Downloads/logo.png'])
  assert.deepEqual(pastedImagePaths('/var/folders/x1/T/shot.png', roots), ['/var/folders/x1/T/shot.png'])
  assert.deepEqual(
    pastedImagePaths('/Users/dev/repository-assets/a.png', roots),
    ['/Users/dev/repository-assets/a.png'],
    'a sibling that shares the prefix is outside',
  )
  assert.equal(
    pastedImagePaths('/Users/dev/Downloads/a.png /Users/dev/repo/b.png', roots),
    null,
    'a paste naming both kinds stays text whole',
  )
  assert.equal(pastedImagePaths('C:\\Users\\dev\\Repo\\shot.png', ['c:/Users/dev/Repo/']), null)
  assert.deepEqual(pastedImagePaths('/Users/dev/repo/a.png', ['']), ['/Users/dev/repo/a.png'], 'no root, no rule')
})

test('a path is inside a folder only at a separator', () => {
  assert.equal(isPathInside('/Users/dev/repo', '/Users/dev/repo/'), true)
  assert.equal(isPathInside('/Users/dev/repo/a/b.png', '/Users/dev/repo'), true)
  assert.equal(isPathInside('/Users/dev/repo2/b.png', '/Users/dev/repo'), false)
  assert.equal(isPathInside('D:\\work\\a.png', 'd:\\Work'), true)
})

test('words split the way a shell splits them', () => {
  assert.deepEqual(splitShellWords(`a 'b c' "d \\" e" f\\ g`), ['a', 'b c', 'd " e', 'f g'])
  assert.equal(splitShellWords('ends with \\'), null)
})

test('pasted paths are read into image files at paste time, or not at all', async () => {
  const read = async (path: string) => {
    if (path.endsWith('gone.png'))
      throw new Error(
        "Error invoking remote method 'fs:read-image-data-url': Error: ENOENT: no such file or directory, stat",
      )
    return 'data:image/png;base64,iVBORw0K'
  }
  const read1 = await readPastedImagePaths(['/Users/dev/Screenshot one.png'], read)
  assert.equal(read1.ok, true)
  if (read1.ok) {
    assert.equal(read1.files[0]?.name, 'Screenshot one.png')
    assert.equal(read1.files[0]?.type, 'image/png')
    assert.equal(read1.files[0]?.size, 6)
  }
  assert.deepEqual(await readPastedImagePaths(['/Users/dev/a.png', '/Users/dev/gone.png'], read), {
    ok: false,
    message: 'Could not attach gone.png: the file no longer exists.',
  })
})

test('a file with no path is uploaded where the shell can, and refused by name where it cannot', async () => {
  const file = { name: 'report.pdf' } as File
  const withApi = async (api: unknown, run: () => Promise<void>) => {
    const holder = globalThis as { window?: unknown }
    const before = holder.window
    holder.window = { api }
    try {
      await run()
    } finally {
      holder.window = before
    }
  }
  await withApi({ clientCapabilities: ['file-uploads'], uploadFiles: async () => ['/srv/up/report.pdf'] }, async () =>
    assert.deepEqual(await pathsForPathlessFiles([file]), { paths: ['/srv/up/report.pdf'], message: null }),
  )
  await withApi(
    {
      clientCapabilities: ['file-uploads'],
      uploadFiles: async () => {
        throw new Error('That file is over 50 MB, too large to upload.')
      },
    },
    async () =>
      assert.deepEqual(await pathsForPathlessFiles([file]), {
        paths: [],
        message: 'That file is over 50 MB, too large to upload.',
      }),
  )
  // A desktop window has no uploads: the drop is refused as before.
  await withApi({}, async () => {
    const answer = await pathsForPathlessFiles([file])
    assert.deepEqual(answer.paths, [])
    assert.match(answer.message ?? '', /report\.pdf has no path on disk/u)
  })
})
