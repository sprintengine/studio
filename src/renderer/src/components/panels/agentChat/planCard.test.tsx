import { expect, test } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { planBody, planIsLong, planTitle } from './planCard'
import { ResolvedDecisionRow } from './timelineRows'
import type { TranscriptEntry } from './conversationProjection'

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
  expect(approved).not.toContain('Show full plan')
  const long = renderToStaticMarkup(
    <ResolvedDecisionRow
      entry={plan(Array.from({ length: 30 }, (_, index) => `- step ${index}`).join('\n'), { status: 'denied' })}
    />,
  )
  expect(long).toContain('Show full plan')
  expect(long).toContain('mask-image')
  expect(long).toContain('Proposed plan')
  expect(long).toContain('Sent back for more planning')
})

test('a plan request with no text keeps the one-line record', () => {
  const html = renderToStaticMarkup(<ResolvedDecisionRow entry={plan('  ')} />)
  expect(html).toContain('Proposed a plan')
  expect(html).not.toContain('data-conversation-plan')
})
