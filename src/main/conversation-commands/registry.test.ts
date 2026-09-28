import { expect, test } from 'vitest'

import { conversationCommandsFor, onConversationCommandsChanged, publishConversationCommands } from './registry'

const compact = { name: 'compact', source: 'cli' as const }

test('a folder nothing has reported for has an empty list that nothing has answered', () => {
  expect(conversationCommandsFor('claude-code', '/Users/dev/empty')).toEqual({
    cli: 'claude-code',
    cwd: '/Users/dev/empty',
    commands: [],
    fetchedAt: 0,
  })
})

test('a published list is kept per CLI and folder and told to every listener', () => {
  const heard: string[] = []
  const stop = onConversationCommandsChanged((catalog) => heard.push(`${catalog.cli} ${catalog.cwd}`))
  publishConversationCommands({ cli: 'claude-code', cwd: '/Users/dev/a', commands: [compact] })
  stop()
  publishConversationCommands({ cli: 'codex', cwd: '/Users/dev/a', commands: [] })
  expect(conversationCommandsFor('claude-code', '/Users/dev/a').commands).toEqual([compact])
  expect(conversationCommandsFor('codex', '/Users/dev/a').commands).toEqual([])
  expect(heard).toEqual(['claude-code /Users/dev/a'])
})

test('a failed ask keeps the last good list and says why', () => {
  publishConversationCommands({ cli: 'claude-code', cwd: '/Users/dev/b', commands: [compact], fetchedAt: 1234 })
  publishConversationCommands({ cli: 'claude-code', cwd: '/Users/dev/b', commands: [], error: 'timed out' })
  expect(conversationCommandsFor('claude-code', '/Users/dev/b')).toEqual({
    cli: 'claude-code',
    cwd: '/Users/dev/b',
    commands: [compact],
    fetchedAt: 1234,
    error: 'timed out',
  })
})

test('a list restored from an earlier run keeps the time it was answered', () => {
  publishConversationCommands({ cli: 'grok', cwd: '/Users/dev/c', commands: [compact], fetchedAt: 42 })
  expect(conversationCommandsFor('grok', '/Users/dev/c').fetchedAt).toBe(42)
})

test('a list published for a session’s folder is found under the spelling the composer asks with', () => {
  // A session publishes under the folder it was started with; the composer asks
  // with the workspace's folder, which can differ by a trailing separator.
  publishConversationCommands({ cli: 'claude-code', cwd: '/Users/dev/app', commands: [compact] })
  expect(conversationCommandsFor('claude-code', '/Users/dev/app/').commands).toEqual([compact])
  expect(conversationCommandsFor('claude-code', '/Users/dev//app/.').commands).toEqual([compact])
  // A Windows folder matches whatever the drive's case and the slashes' direction.
  publishConversationCommands({ cli: 'codex', cwd: 'C:\\Users\\dev\\app\\', commands: [compact] })
  expect(conversationCommandsFor('codex', 'c:/Users/dev/app').commands).toEqual([compact])
  // A different folder is a different list.
  expect(conversationCommandsFor('claude-code', '/Users/dev/app2').commands).toEqual([])
})
