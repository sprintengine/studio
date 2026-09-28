import { expect, test } from 'vitest'
import { acpConversationCommands } from './acp'

test('an ACP command keeps its name, description and input hint', () => {
  expect(
    acpConversationCommands([
      { name: 'review', description: 'Review the changes' },
      { name: 'plan', description: 'Plan before editing', input: { hint: '<objective>' } },
    ]),
  ).toEqual([
    { name: 'review', description: 'Review the changes', source: 'cli' },
    { name: 'plan', description: 'Plan before editing', argumentHint: '<objective>', source: 'cli' },
  ])
})

test("a command's source tag becomes its source and leaves its description", () => {
  expect(
    acpConversationCommands([
      { name: 'triage', description: 'Sort the open issues. (builtin skill)' },
      { name: 'release-notes', description: 'Write release notes. (user skill)' },
      { name: 'changelog', description: 'Draft a changelog entry. (global)' },
      { name: 'status', description: 'Show the session status' },
    ]).map(({ name, description, source }) => [name, description, source]),
  ).toEqual([
    ['triage', 'Sort the open issues.', 'skill'],
    ['release-notes', 'Write release notes.', 'skill'],
    ['changelog', 'Draft a changelog entry.', 'custom'],
    ['status', 'Show the session status', 'cli'],
  ])
})

test('commands that end the terminal session or switch approvals behind the preset are not offered', () => {
  expect(
    acpConversationCommands([
      { name: 'exit', description: 'Leave' },
      { name: 'quit', description: 'Leave' },
      { name: 'always-approve', description: 'Toggle always-approve mode', input: { hint: 'on|off' } },
      { name: 'compact', description: 'Compress conversation history' },
    ]).map((command) => command.name),
  ).toEqual(['compact'])
})

test('malformed, untypeable and repeated entries from the agent are dropped', () => {
  expect(
    acpConversationCommands([
      null,
      { description: 'no name' },
      { name: 'two words', description: 'cannot be typed back' },
      { name: '/init', description: 'guided AGENTS.md setup', input: { hint: 42 } },
      { name: 'init', description: 'a second init' },
      { name: 'plain' },
    ]),
  ).toEqual([
    { name: 'init', description: 'guided AGENTS.md setup', source: 'cli' },
    { name: 'plain', source: 'cli' },
  ])
  expect(acpConversationCommands(undefined)).toEqual([])
})
