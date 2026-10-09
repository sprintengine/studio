import { expect, test } from 'vitest'

import type { ConversationEvent, ConversationFileActivity } from '../conversation-runtime'
import { applyFileActivityEvent, FILE_ACTIVITY_LIMIT, FILE_ACTIVITY_RETAIN_MS, fileActivityOf } from './fileActivity'

const ROOT = '/Users/dev/app'

function event(
  type: ConversationEvent['type'],
  payload: Record<string, unknown>,
  createdAt = 1_000,
): ConversationEvent {
  return { type, payload, createdAt, sessionId: 's1', seq: 1 } as unknown as ConversationEvent
}

function fold(events: ConversationEvent[]): ConversationFileActivity[] {
  let list: ConversationFileActivity[] = []
  for (const each of events) list = applyFileActivityEvent(list, each, ROOT) ?? list
  return list
}

test('a read reads, an edit, a write and a notebook edit edit, and nothing else is file activity', () => {
  expect(fileActivityOf('file_read', 'Read', { file_path: `${ROOT}/a.ts` }, ROOT)).toEqual({
    verb: 'reading',
    paths: [`${ROOT}/a.ts`],
  })
  expect(fileActivityOf('file_edit', 'Edit', { file_path: `${ROOT}/a.ts` }, ROOT)?.verb).toBe('editing')
  expect(fileActivityOf('file_write', 'Write', { path: `${ROOT}/a.ts` }, ROOT)?.verb).toBe('editing')
  expect(fileActivityOf('other', 'NotebookEdit', { notebook_path: `${ROOT}/n.ipynb` }, ROOT)).toEqual({
    verb: 'editing',
    paths: [`${ROOT}/n.ipynb`],
  })
  expect(fileActivityOf('command', 'Bash', { command: 'cat a.ts' }, ROOT)).toBeNull()
  expect(fileActivityOf('search', 'Grep', { path: ROOT, pattern: 'x' }, ROOT)).toBeNull()
  expect(fileActivityOf('file_read', 'Read', {}, ROOT)).toBeNull()
})

test('every path a call names is placed against the root, once each', () => {
  // A patch across files with no top-level path, one of them moved, and a
  // relative path that climbs back into the root.
  const patch = fileActivityOf(
    'file_edit',
    'Edit',
    { edits: [{ path: 'src/a.ts' }, { path: 'src/b.ts', movePath: 'lib/b.ts' }, { path: 'src/../src/a.ts' }] },
    ROOT,
  )
  expect(patch?.paths).toEqual([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`, `${ROOT}/lib/b.ts`])
  // The locations an ACP agent lists beside its input.
  expect(fileActivityOf('file_read', 'read', { locations: [{ path: 'docs/x.md' }] }, ROOT)?.paths).toEqual([
    `${ROOT}/docs/x.md`,
  ])
  // Windows separators come out `/`-separated.
  expect(fileActivityOf('file_read', 'Read', { file_path: 'C:\\repo\\a.ts' }, 'C:\\repo')?.paths).toEqual([
    'C:/repo/a.ts',
  ])
  // A home-relative path cannot be placed.
  expect(fileActivityOf('file_read', 'Read', { file_path: '~/notes.md' }, ROOT)).toBeNull()
})

test('a call starts running, ends on its final output, and a streamed chunk does not end it', () => {
  const started = fold([event('tool_started', { toolUseId: 't1', kind: 'file_read', input: { file_path: 'a.ts' } })])
  expect(started).toEqual([{ path: `${ROOT}/a.ts`, verb: 'reading', toolUseId: 't1', startedAt: 1_000 }])
  const partial = applyFileActivityEvent(started, event('tool_output', { toolUseId: 't1', partial: true }), ROOT)
  expect(partial).toBeNull()
  const ended = applyFileActivityEvent(started, event('tool_output', { toolUseId: 't1' }, 1_200), ROOT)
  expect(ended?.[0]?.endedAt).toBe(1_200)
})

test("a spawned agent's step carries its lane and outlives the turn; the conversation's own call does not", () => {
  const list = fold([
    event('tool_started', { toolUseId: 'own', kind: 'file_edit', input: { file_path: 'a.ts' } }),
    event('tool_started', {
      toolUseId: 'step',
      kind: 'file_read',
      parentToolUseId: 'lane-1',
      input: { file_path: 'b.ts' },
    }),
    event('turn_completed', {}, 2_000),
  ])
  expect(list.find((entry) => entry.toolUseId === 'own')?.endedAt).toBe(2_000)
  const step = list.find((entry) => entry.toolUseId === 'step')
  expect(step?.laneId).toBe('lane-1')
  expect(step?.endedAt).toBeUndefined()
  // A steered turn's end is not the session's: the work goes on.
  const steered = fold([
    event('tool_started', { toolUseId: 'own', kind: 'file_edit', input: { file_path: 'a.ts' } }),
    event('turn_completed', { steered: true }),
  ])
  expect(steered[0]?.endedAt).toBeUndefined()
})

test('finished calls are let go after the retention and past the cap; a running one never is', () => {
  // Times from 1: an event stamped 0 is read as stamped now.
  const reads = Array.from({ length: FILE_ACTIVITY_LIMIT + 4 }, (_, index) => [
    event(
      'tool_started',
      { toolUseId: `r${index}`, kind: 'file_read', input: { file_path: `f${index}.ts` } },
      index + 1,
    ),
    event('tool_output', { toolUseId: `r${index}` }, index + 1),
  ]).flat()
  const running = event('tool_started', { toolUseId: 'edit', kind: 'file_edit', input: { file_path: 'x.ts' } }, 1)
  const capped = fold([running, ...reads])
  expect(capped).toHaveLength(FILE_ACTIVITY_LIMIT)
  expect(capped.some((entry) => entry.toolUseId === 'edit')).toBe(true)
  expect(capped.at(-1)?.toolUseId).toBe(`r${FILE_ACTIVITY_LIMIT + 3}`)

  const late = fold([
    running,
    ...reads.slice(0, 2),
    event(
      'tool_started',
      { toolUseId: 'later', kind: 'file_read', input: { file_path: 'y.ts' } },
      FILE_ACTIVITY_RETAIN_MS + 10,
    ),
  ])
  expect(late.map((entry) => entry.toolUseId)).toEqual(['edit', 'later'])
})
