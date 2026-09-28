import { expect, test } from 'vitest'

import { leadingCommandFor, leadingSlashCommand } from './leading-command'
import { publishConversationCommands } from './registry'

test('a message that opens with a command names it, with or without arguments', () => {
  expect(leadingSlashCommand('/context')).toBe('context')
  expect(leadingSlashCommand('/review HEAD~1')).toBe('review')
  expect(leadingSlashCommand('/acme:deploy staging\nand then some')).toBe('acme:deploy')
})

test('a path, a slash later in the message, or a lone slash is prose', () => {
  expect(leadingSlashCommand('/Users/dev/app is the folder')).toBeNull()
  expect(leadingSlashCommand('please /compact')).toBeNull()
  expect(leadingSlashCommand(' /compact')).toBeNull()
  expect(leadingSlashCommand('/')).toBeNull()
})

test('without a command list, a top-level folder or a dotted name reads as a path', () => {
  expect(leadingSlashCommand('/tmp is full')).toBeNull()
  expect(leadingSlashCommand('/Volumes is on the other disk')).toBeNull()
  expect(leadingSlashCommand('/etc.conf looks wrong')).toBeNull()
})

test('with the list the CLI reported, only a name or alias on it is a command', () => {
  const known = [
    { name: 'review', source: 'cli' as const },
    { name: 'usage', aliases: ['cost'], source: 'cli' as const },
  ]
  expect(leadingSlashCommand('/review 12', known)).toBe('review')
  expect(leadingSlashCommand('/cost', known)).toBe('cost')
  expect(leadingSlashCommand('/deploy now', known)).toBeNull()
})

test('the list for the chat’s CLI and folder is the one consulted', () => {
  publishConversationCommands({ cli: 'grok', cwd: '/Users/dev/leading', commands: [{ name: 'plan', source: 'cli' }] })
  expect(leadingCommandFor('/plan it', { cli: 'grok', cwd: '/Users/dev/leading/' })).toBe('plan')
  expect(leadingCommandFor('/deploy', { cli: 'grok', cwd: '/Users/dev/leading' })).toBeNull()
  // No list for the folder yet: judged by its look.
  expect(leadingCommandFor('/deploy', { cli: 'grok', cwd: '/Users/dev/elsewhere' })).toBe('deploy')
})
