// @vitest-environment jsdom
import { expect, test } from 'vitest'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { revealMatch } from '../../../utils/revealMatch'
import { planBody, planIsLong, planTitle } from './planCard'
import { ResolvedDecisionRow } from './timelineRows'
import type { TranscriptEntry } from './conversationProjection'
import { ConversationLinkProvider } from './conversationLinks'

type Approval = Extract<TranscriptEntry, { kind: 'approval' }>
const plan = (text: string, extra: Partial<Approval> = {}): Approval => ({
  kind: 'approval',
  requestId: 'plan-1',
  summary: 'Plan',
  requestKind: 'plan',
  plan: text,
  status: 'approved',
  ...extra,
})

test('the title is the plan’s first heading, and the body does not repeat it', () => {
  expect(planTitle('# Move the cache\n\n1. Read\n2. Write')).toBe('Move the cache')
  expect(planTitle('Intro line\n\n## Steps ##\n- one')).toBe('Steps')
  expect(planTitle('- just a list')).toBeNull()
  expect(planBody('# Move the cache\n\n1. Read\n2. Write')).toBe('1. Read\n2. Write')
  expect(planBody('Intro\n# Later')).toBe('Intro\n# Later')
})

test('a plan past a screenful rests collapsed', () => {
  expect(planIsLong('short')).toBe(false)
  expect(planIsLong(Array.from({ length: 21 }, (_, index) => `- step ${index}`).join('\n'))).toBe(true)
  expect(planIsLong('x'.repeat(901))).toBe(true)
})

test('an answered plan stays readable in the transcript with its outcome', () => {
  const approved = renderToStaticMarkup(<ResolvedDecisionRow entry={plan('# Move the cache\n\n1. Read the config')} />)
  expect(approved).toContain('data-conversation-plan')
  expect(approved).toContain('Move the cache')
  expect(approved).toContain('Read the config')
  expect(approved).toContain('Plan approved')
  expect(approved).toContain('aria-label="Copy plan"')
  // The card spans the conversation column; the reading measure is the
  // one-line records'.
  expect(approved).not.toContain('max-w-[68ch]')
  const long = renderToStaticMarkup(
    <ResolvedDecisionRow
      entry={plan(Array.from({ length: 30 }, (_, index) => `- step ${index}`).join('\n'), { status: 'denied' })}
    />,
  )
  expect(long).toContain('Proposed plan')
  expect(long).toContain('Sent back for more planning')
  // With no conversation to open it from, the card is the only place to
  // read the plan, so nothing is held back.
  expect(long).toContain('step 29')
  expect(long).not.toContain('mask-image')
  expect(long).not.toContain('Open plan')
})

test('inside a conversation a long plan rests as a preview that opens in the pane', () => {
  const inConversation = (entry: Approval) =>
    renderToStaticMarkup(
      <ConversationLinkProvider workspaceId="ws" agentId="agent" cwd="/repo" workspaceRoot="/repo">
        <ResolvedDecisionRow entry={entry} />
      </ConversationLinkProvider>,
    )
  const long = inConversation(plan(Array.from({ length: 30 }, (_, index) => `- step ${index}`).join('\n')))
  expect(long).toContain('mask-image')
  expect(long).toContain('Open plan')
  expect(long).not.toContain('Show full plan')
  const short = inConversation(plan('# Move the cache\n\n1. Read the config'))
  expect(short).toContain('Open plan')
  expect(short).not.toContain('mask-image')
})

test('a find that lands past the preview shows the whole plan, and searches only what the plan wrote', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const long = (title: string) => `${title}${Array.from({ length: 30 }, (_, index) => `- step ${index}`).join('\n')}`
  const render = (entry: Approval) =>
    act(async () =>
      root.render(
        <ConversationLinkProvider workspaceId="ws" agentId="agent" cwd="/repo" workspaceRoot="/repo">
          <ResolvedDecisionRow entry={entry} />
        </ConversationLinkProvider>,
      ),
    )
  try {
    await render(plan(long('# Ship it\n\n')))
    const segments = host.querySelectorAll('[data-chat-find-segment="plan:plan-1"]')
    expect([...segments].map((element) => element.textContent?.trim().slice(0, 6))).toEqual(['Ship i', 'step 0'])
    expect(host.innerHTML).toContain('mask-image')
    await act(async () => revealMatch(segments[1]!.lastChild!))
    expect(host.innerHTML).not.toContain('mask-image')

    // A plan with no heading of its own: the card's fallback title is not the plan's text.
    await render(plan(long(''), { requestId: 'plan-2' }))
    const untitled = host.querySelectorAll('[data-chat-find-segment="plan:plan-2"]')
    expect(untitled).toHaveLength(1)
    expect(untitled[0]!.textContent).not.toContain('Proposed plan')
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})

test('a plan request with no text keeps the one-line record', () => {
  const html = renderToStaticMarkup(<ResolvedDecisionRow entry={plan('  ')} />)
  expect(html).toContain('Proposed a plan')
  expect(html).not.toContain('data-conversation-plan')
})
