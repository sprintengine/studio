import { expect, test } from 'vitest'

import { attachedFileName, parseConversationAttachedFiles } from '../src/attachedFiles.js'
import { projectConversation, userEntryFromLocalTurn } from '../src/conversationProjection.js'

test('a message’s files are absolute paths on any system, each once; anything else is no list at all', () => {
  expect(
    parseConversationAttachedFiles([
      { path: '/Users/dev/notes.pdf' },
      { path: 'C:\\Users\\dev\\plan.docx' },
      { path: '\\\\build-box\\share\\deck.pptx' },
      { path: '/Users/dev/notes.pdf', extra: true },
    ]),
  ).toEqual([
    { path: '/Users/dev/notes.pdf' },
    { path: 'C:\\Users\\dev\\plan.docx' },
    { path: '\\\\build-box\\share\\deck.pptx' },
  ])
  for (const value of [
    undefined,
    'notes.pdf',
    [{ path: 'notes.pdf' }],
    [{ path: '' }],
    [{ path: '/Users/dev/re\nport.pdf' }],
    ['/Users/dev/notes.pdf'],
    Array.from({ length: 51 }, (_, i) => ({ path: `/Users/dev/${i}.pdf` })),
  ])
    expect(parseConversationAttachedFiles(value), JSON.stringify(value)).toBeNull()
  expect(attachedFileName('C:\\Users\\dev\\plan.docx')).toBe('plan.docx')
})

test('a user entry carries the files its user_message recorded, and an optimistic one its own', () => {
  const event = {
    id: 'e1',
    seq: 1,
    sessionId: 's',
    workspaceId: 'w',
    agentId: 'a',
    providerId: 'p',
    modelId: 'm',
    type: 'user_message' as const,
    createdAt: 1,
    payload: { turnId: 't1', text: 'Summarise', files: [{ path: '/Users/dev/notes.pdf' }] },
  }
  const [entry] = projectConversation([event]).entries
  expect(entry).toMatchObject({ kind: 'user', text: 'Summarise', files: [{ path: '/Users/dev/notes.pdf' }] })
  // A recorded list a reader cannot read leaves the bubble without cards, not without its words.
  const [unread] = projectConversation([{ ...event, payload: { ...event.payload, files: 'nope' } }]).entries
  expect(unread).toMatchObject({ kind: 'user', text: 'Summarise' })
  expect((unread as { files?: unknown }).files).toBeUndefined()
  expect(userEntryFromLocalTurn({ id: 'local', text: '', files: [{ path: '/Users/dev/notes.pdf' }] })).toMatchObject({
    files: [{ path: '/Users/dev/notes.pdf' }],
  })
})
