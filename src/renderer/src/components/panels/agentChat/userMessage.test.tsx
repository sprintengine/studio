import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AssistantTurnBlock, UserTimelineRow, type TimelineChrome } from './timelineRows'
import type { TranscriptEntry } from './conversationProjection'
import { ConversationTransportProvider, type ConversationTransport } from './conversationTransport'
import { ConfirmDialogProvider } from '../../ui/ConfirmDialog'

type UserEntry = Extract<TranscriptEntry, { kind: 'user' }>

const chrome: TimelineChrome = { assistantName: 'Claude Code', onRetry: () => undefined, retryDisabled: false }
const user = (text: string, extra: Partial<UserEntry> = {}): UserEntry => ({
  kind: 'user',
  id: 'u1',
  seq: 4,
  text,
  ...extra,
})

test('a message renders as markdown: a pasted fence is code and a newline stays a line break', () => {
  const html = renderToStaticMarkup(<UserTimelineRow entry={user('first\nsecond\n\n```sh\nnpm test\n```')} />)
  expect(html).toMatch(/first<br\/>\s*second/)
  expect(html).toContain('npm test')
  expect(html).toContain('<pre')
})

test('each message is announced by who wrote it, out of sight', () => {
  const mine = renderToStaticMarkup(<UserTimelineRow entry={user('hi')} />)
  expect(mine).toContain('<h3 class="sr-only select-none">You said</h3>')
  const reply = renderToStaticMarkup(
    <AssistantTurnBlock
      entry={{ kind: 'assistant', turnId: 't1', text: 'Hello.', reasoning: '', status: 'complete' }}
      tools={[]}
      decisions={[]}
      chrome={chrome}
    />,
  )
  expect(reply).toContain('<h3 class="sr-only select-none">Claude Code</h3>')
})

test('Edit from here is offered only where the provider and the transport can go back', () => {
  const restore = () => undefined
  const offered = renderToStaticMarkup(
    <ConfirmDialogProvider>
      <UserTimelineRow entry={user('hi')} chrome={{ ...chrome, rewindEnabled: true, onRestoreDraft: restore }} />
    </ConfirmDialogProvider>,
  )
  expect(offered).toContain('Edit from here')
  expect(renderToStaticMarkup(<UserTimelineRow entry={user('hi')} chrome={chrome} />)).not.toContain('Edit from here')
  // A bubble not yet in the transcript has nothing to go back to.
  expect(
    renderToStaticMarkup(
      <UserTimelineRow
        entry={user('hi', { seq: undefined })}
        chrome={{ ...chrome, rewindEnabled: true, onRestoreDraft: restore }}
      />,
    ),
  ).not.toContain('Edit from here')
  const remote = { kind: 'remote', capabilities: {} } as unknown as ConversationTransport
  expect(
    renderToStaticMarkup(
      <ConversationTransportProvider value={remote}>
        <UserTimelineRow entry={user('hi')} chrome={{ ...chrome, rewindEnabled: true, onRestoreDraft: restore }} />
      </ConversationTransportProvider>,
    ),
  ).not.toContain('Edit from here')
})
