import { expect, test } from 'vitest'
import { codexCompactRequest, codexConversationCommands } from './codex'

const cwd = '/Users/dev/app'
const listed = (skills: unknown[]) => ({ data: [{ cwd, skills, errors: [] }] })

test('Codex offers /compact, then each enabled skill as a $name mention', () => {
  expect(
    codexConversationCommands(
      listed([
        {
          name: 'release-notes',
          description: 'Write release notes from the merged changes, in the long form written for the model.',
          interface: { shortDescription: 'Write release notes' },
          scope: 'system',
          enabled: true,
        },
        { name: 'acme:changelog', description: 'Draft a changelog entry', scope: 'user', enabled: true },
        { name: 'retired', description: 'Switched off', scope: 'user', enabled: false },
      ]),
      cwd,
    ),
  ).toEqual([
    { name: 'compact', description: 'Summarise the conversation to free context', source: 'cli' },
    { name: 'release-notes', description: 'Write release notes', insertText: '$release-notes ', source: 'skill' },
    { name: 'acme:changelog', description: 'Draft a changelog entry', insertText: '$acme:changelog ', source: 'skill' },
  ])
})

test('Codex reads the skills listed for the folder it asked about', () => {
  const response = {
    data: [
      { cwd: '/Users/dev/other', skills: [{ name: 'elsewhere', description: '', enabled: true }] },
      { cwd, skills: [{ name: 'here', description: 'This folder', enabled: true }] },
    ],
  }
  expect(codexConversationCommands(response, cwd).map((command) => command.name)).toEqual(['compact', 'here'])
  expect(codexConversationCommands({ error: 'no data' }, cwd).map((command) => command.name)).toEqual(['compact'])
})

test('/compact on its own runs; with anything riding along it is refused; anything else is not /compact', () => {
  expect(codexCompactRequest('/compact')).toBe('run')
  expect(codexCompactRequest('/compact \n')).toBe('run')
  expect(codexCompactRequest('/compact keep the API notes')).toBe('refuse')
  // Instructions on a later line, or a mentioned file's context, would be dropped too.
  expect(codexCompactRequest('/compact\nfocus on the parser')).toBe('refuse')
  expect(codexCompactRequest('/compact\n\nMentioned file: src/app.ts')).toBe('refuse')
  expect(codexCompactRequest('/compact', 1)).toBe('refuse')
  expect(codexCompactRequest('/compaction plan')).toBeNull()
  expect(codexCompactRequest('please /compact')).toBeNull()
})
