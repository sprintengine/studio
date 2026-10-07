import { expect, test } from 'vitest'

import { parseSendTurnInput } from './conversation-ipc-inputs'

test('a send from a window carries its files attached by path, each an absolute path, or is refused', () => {
  const sent = parseSendTurnInput({
    sessionId: 'session',
    message: 'Summarise',
    files: [{ path: '/Users/dev/notes.pdf' }, { path: 'C:\\Users\\dev\\plan.docx' }],
  })
  expect(sent).toMatchObject({
    ok: true,
    input: { message: 'Summarise', files: [{ path: '/Users/dev/notes.pdf' }, { path: 'C:\\Users\\dev\\plan.docx' }] },
  })
  expect(parseSendTurnInput({ sessionId: 'session', message: 'x', files: [] })).toMatchObject({ ok: true })
  expect(
    (parseSendTurnInput({ sessionId: 'session', message: 'x', files: [] }) as { input: object }).input,
  ).not.toHaveProperty('files')
  expect(parseSendTurnInput({ sessionId: 'session', message: 'x', files: [{ path: 'notes.pdf' }] })).toEqual({
    ok: false,
    message: 'Attached files must be absolute paths, at most 50.',
  })
})
