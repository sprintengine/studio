import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import type { ConversationCommandCatalog } from '../../shared/conversation/commands'
import { createConversationCommandsDiskCache } from './disk-cache'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-commands-cache-'))
  dirs.push(dir)
  return join(dir, 'nested', 'conversation-commands-cache.json')
}

const catalog = (cwd: string, fetchedAt = 100): ConversationCommandCatalog => ({
  cli: 'claude-code',
  cwd,
  commands: [{ name: 'compact', description: 'Free up context', aliases: ['squash'], source: 'cli' }],
  fetchedAt,
})

test('a recorded list is written and read back by the next run', async () => {
  const file = await cacheFile()
  const first = createConversationCommandsDiskCache({ file, debounceMs: 0 })
  expect(await first.load()).toEqual([])
  first.record(catalog('/Users/dev/app'))
  await first.flush()
  expect(await createConversationCommandsDiskCache({ file }).load()).toEqual([catalog('/Users/dev/app')])
})

test('only the most recently answered lists are kept', async () => {
  const file = await cacheFile()
  const cache = createConversationCommandsDiskCache({ file, maxEntries: 2, debounceMs: 0 })
  await cache.load()
  cache.record(catalog('/Users/dev/one'))
  cache.record(catalog('/Users/dev/two'))
  cache.record(catalog('/Users/dev/one', 200))
  cache.record(catalog('/Users/dev/three'))
  await cache.flush()
  const stored = await createConversationCommandsDiskCache({ file }).load()
  expect(stored.map((entry) => [entry.cwd, entry.fetchedAt])).toEqual([
    ['/Users/dev/one', 200],
    ['/Users/dev/three', 100],
  ])
})

test('a failed list, or one nothing answered, is never written', async () => {
  const file = await cacheFile()
  const cache = createConversationCommandsDiskCache({ file, debounceMs: 0 })
  cache.record({ ...catalog('/Users/dev/app'), error: 'timed out' })
  cache.record(catalog('/Users/dev/app', 0))
  await cache.flush()
  await expect(readFile(file, 'utf8')).rejects.toThrow()
})

test('a corrupt or foreign file reads as an empty cache, and bad rows are dropped', async () => {
  const file = await cacheFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '{ not json')
  expect(await createConversationCommandsDiskCache({ file }).load()).toEqual([])
  await writeFile(file, JSON.stringify({ version: 99, catalogs: [catalog('/Users/dev/app')] }))
  expect(await createConversationCommandsDiskCache({ file }).load()).toEqual([])
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      catalogs: [
        {
          cli: 'claude-code',
          cwd: '/Users/dev/app',
          fetchedAt: 5,
          commands: [
            { name: 'ok', source: 'cli' },
            { name: 'bad', source: 'elsewhere' },
            { name: 'two words', source: 'cli' },
          ],
        },
        { cli: 'claude-code', fetchedAt: 5, commands: [] },
        'junk',
      ],
    }),
  )
  expect(await createConversationCommandsDiskCache({ file }).load()).toEqual([
    { cli: 'claude-code', cwd: '/Users/dev/app', fetchedAt: 5, commands: [{ name: 'ok', source: 'cli' }] },
  ])
})

test('a list recorded before the file is read is not replaced by the older one in it', async () => {
  const file = await cacheFile()
  const earlier = createConversationCommandsDiskCache({ file, debounceMs: 0 })
  earlier.record(catalog('/Users/dev/app', 100))
  earlier.record(catalog('/Users/dev/other', 100))
  await earlier.flush()
  const cache = createConversationCommandsDiskCache({ file, debounceMs: 0 })
  cache.record(catalog('/Users/dev/app', 300))
  await cache.flush()
  const stored = await createConversationCommandsDiskCache({ file }).load()
  expect(stored.map((entry) => [entry.cwd, entry.fetchedAt])).toEqual([
    ['/Users/dev/other', 100],
    ['/Users/dev/app', 300],
  ])
})
