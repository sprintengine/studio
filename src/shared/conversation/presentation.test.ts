import { test, expect } from 'vitest'
import { presentToolItem, summarizeToolGroup, type PresentableTool } from './presentation'
import type { ConversationToolKind } from '../conversation-runtime'

const kinds: ConversationToolKind[] = [
  'command',
  'file_read',
  'file_edit',
  'file_write',
  'search',
  'list',
  'web',
  'mcp',
  'subagent',
  'todo',
  'other',
]
const states = ['running', 'ok', 'error', 'declined', 'stopped', 'done'] as const
for (const kind of kinds)
  for (const status of states) {
    test(`${kind} has a bounded deterministic title when ${status}`, () => {
      const item: PresentableTool = {
        kind,
        status,
        name: 'Example',
        input: { path: '/workspace/app.ts', command: 'npm test', query: 'hello' },
      }
      const presentation = presentToolItem(item)
      expect(presentation.title.length).toBeLessThanOrEqual(72)
      expect(presentation).toEqual(presentToolItem(item))
      expect(presentation.icon).toBe(kind)
      if (status === 'running') expect(presentation.tone).toBe('running')
    })
  }
test('groups largest counts first with natural plurals', () => {
  expect(
    summarizeToolGroup([
      ...Array.from({ length: 3 }, () => ({ name: 'Read' })),
      ...Array.from({ length: 2 }, () => ({ name: 'Bash' })),
      { name: 'Edit' },
    ]),
  ).toBe('Read 3 files, ran 2 commands and edited 1 file')
  expect(summarizeToolGroup([{ name: 'ls' }, { name: 'ls' }])).toBe('Listed 2 directories')
})
test('command failure is neutral with exit status, runtime failure is an error', () => {
  expect(presentToolItem({ name: 'Bash', status: 'error', exitCode: 1 })).toMatchObject({
    tone: 'neutral',
    subtitle: 'exit 1',
  })
  expect(presentToolItem({ name: 'Bash', status: 'error' }).tone).toBe('error')
})
test('malformed data and unknown names stay readable', () => {
  expect(presentToolItem(null as unknown as PresentableTool).title).toBe('Tool')
  expect(presentToolItem({ name: 'custom' }).title).toBe('custom')
  expect(presentToolItem({ name: 'Read', input: { file_path: '/very/long/parent/file.ts' } }).title).toBe(
    'Read file.ts',
  )
})
