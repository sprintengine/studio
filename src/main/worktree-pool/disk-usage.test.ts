import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'

import { measureDiskUsage, parseDuOutput } from './disk-usage'

test('du output becomes a total and the largest top-level entries, the rest summed', () => {
  const usage = parseDuOutput(
    ['300\t/w/node_modules', '40\t/w/out', '8\t/w/src', '4\t/w/.git', '2\t/w/docs', '360\t/w', ''].join('\n'),
    '/w/',
    5,
  )
  assert.deepEqual(usage, {
    bytes: 360 * 1024,
    measuredAt: 5,
    parts: [
      { name: 'node_modules', bytes: 300 * 1024 },
      { name: 'out', bytes: 40 * 1024 },
      { name: 'src', bytes: 8 * 1024 },
      { name: '.git', bytes: 4 * 1024 },
      { name: '…', bytes: 8 * 1024 },
    ],
  })
  assert.equal(parseDuOutput('du: cannot read\n', '/w', 0), null, 'no total, no answer')
})

test('a real tree measures at least what is in it, its biggest folder first', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sprintengine-disk-usage-')))
  try {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(root, 'node_modules', 'pkg', 'blob'), Buffer.alloc(256 * 1024, 1))
    await writeFile(join(root, 'README.md'), '# hi\n')
    const usage = await measureDiskUsage(root)
    assert.ok(usage)
    assert.ok(usage.bytes >= 256 * 1024, `${usage.bytes}`)
    assert.equal(usage.parts[0]?.name, 'node_modules')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
