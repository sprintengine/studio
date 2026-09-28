import { expect, test } from 'vitest'

import type { ConversationCommand, ConversationCommandCatalog } from '../../shared/conversation/commands'
import type { ConversationCommandsDiskCache } from './disk-cache'
import { conversationCommandsFor, publishConversationCommands } from './registry'
import { createConversationCommandsService } from './service'

// The registry is process-wide, so each test asks about a folder of its own.
let folders = 0
const folder = () => `/Users/dev/service-${++folders}`

const row = (name: string): ConversationCommand => ({ name, source: 'cli' })

/** A probe that publishes what it is handed, when the test says so. */
function controlledProbe() {
  const asked: Array<{ cli: string; cwd: string; cliRuntimes?: unknown }> = []
  const pending: Array<() => void> = []
  const probe = (input: { cli: string; cwd: string; cliRuntimes?: unknown }) => {
    asked.push(input)
    return new Promise<ConversationCommand[] | null>((resolve) => {
      pending.push(() => {
        const commands = [row(`fresh-${asked.length}`)]
        publishConversationCommands({ cli: input.cli, cwd: input.cwd, commands })
        resolve(commands)
      })
    })
  }
  return { probe, asked, answer: () => pending.shift()?.() }
}

function memoryCache(stored: ConversationCommandCatalog[]) {
  const recorded: ConversationCommandCatalog[] = []
  const cache: ConversationCommandsDiskCache = {
    load: async () => stored,
    record: (catalog) => recorded.push(catalog),
    flush: async () => undefined,
  }
  return { cache, recorded }
}

test('a cached list is served at once and a refresh started behind it', async () => {
  const cwd = folder()
  const { probe, asked, answer } = controlledProbe()
  const { cache, recorded } = memoryCache([{ cli: 'claude-code', cwd, commands: [row('cached')], fetchedAt: 1 }])
  const service = createConversationCommandsService({ probe, cache, now: () => 10 * 60_000 })
  const first = await service.list({ cli: 'claude-code', cwd })
  expect(first.commands).toEqual([row('cached')])
  expect(first.fetchedAt).toBe(1)
  expect(asked).toHaveLength(1)
  answer()
  await Promise.resolve()
  expect(conversationCommandsFor('claude-code', cwd).commands).toEqual([row('fresh-1')])
  // Every good list is written back to the cache.
  expect(recorded.at(-1)?.commands).toEqual([row('fresh-1')])
  await service.dispose()
})

test('a fresh list is served without asking the CLI again, unless a refresh is asked for', async () => {
  const cwd = folder()
  const { probe, asked } = controlledProbe()
  publishConversationCommands({ cli: 'claude-code', cwd, commands: [row('known')], fetchedAt: 1_000 })
  const service = createConversationCommandsService({ probe, now: () => 2_000 })
  expect((await service.list({ cli: 'claude-code', cwd })).commands).toEqual([row('known')])
  expect(asked).toHaveLength(0)
  await service.list({ cli: 'claude-code', cwd, refresh: true })
  expect(asked).toHaveLength(1)
})

test('a list nothing is known about waits for the probe, and two asks share one probe', async () => {
  const cwd = folder()
  const { probe, asked, answer } = controlledProbe()
  const service = createConversationCommandsService({
    probe,
    cliRuntimes: () => ({ 'claude-code': { command: '/Users/dev/bin/claude' } }),
  })
  const first = service.list({ cli: 'claude-code', cwd })
  const second = service.list({ cli: 'claude-code', cwd })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(asked).toEqual([
    { cli: 'claude-code', cwd, cliRuntimes: { 'claude-code': { command: '/Users/dev/bin/claude' } } },
  ])
  answer()
  expect((await first).commands).toEqual([row('fresh-1')])
  expect((await second).commands).toEqual([row('fresh-1')])
})

test('a probe slower than the cold wait is answered with what there is, and pushes its list later', async () => {
  const cwd = folder()
  const { probe, answer } = controlledProbe()
  const service = createConversationCommandsService({ probe, coldWaitMs: 5 })
  expect(await service.list({ cli: 'codex', cwd })).toEqual({ cli: 'codex', cwd, commands: [], fetchedAt: 0 })
  answer()
  await Promise.resolve()
  expect(conversationCommandsFor('codex', cwd).commands).toEqual([row('fresh-1')])
})

test('a peek answers with what is held and never asks the CLI', async () => {
  const cwd = folder()
  const { probe, asked } = controlledProbe()
  const service = createConversationCommandsService({ probe, coldWaitMs: 5 })
  expect((await service.list({ cli: 'claude-code', cwd, probe: false })).fetchedAt).toBe(0)
  publishConversationCommands({ cli: 'claude-code', cwd, commands: [row('held')], fetchedAt: 1 })
  expect((await service.list({ cli: 'claude-code', cwd, probe: false })).commands).toEqual([row('held')])
  expect(asked).toHaveLength(0)
  await service.dispose()
})

test('no more than two CLIs are asked at once; the rest wait their turn', async () => {
  const { probe, asked, answer } = controlledProbe()
  const service = createConversationCommandsService({ probe, coldWaitMs: 1 })
  const folders = [folder(), folder(), folder()]
  await Promise.all(folders.map((cwd) => service.list({ cli: 'claude-code', cwd })))
  expect(asked.map((input) => input.cwd)).toEqual(folders.slice(0, 2))
  answer()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(asked.map((input) => input.cwd)).toEqual(folders)
  answer()
  answer()
  await service.dispose()
})
