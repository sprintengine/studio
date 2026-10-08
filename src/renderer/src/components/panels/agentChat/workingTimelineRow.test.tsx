import { afterEach, expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import { WorkingTimelineRow } from './timelineRows'
import { setConversationDisclosures } from './conversationViewState'

// The live line under a running turn, with the agent's latest thought on a
// line of its own while the turn's steps are folded away.

const row = {
  kind: 'working' as const,
  id: 'working-indicator-row',
  stage: 'tool' as const,
  label: 'Reading pricing.css…',
  turnId: 'turn-thought',
  latestThought: 'Start with the card grid.',
}

afterEach(() => setConversationDisclosures(':', ['fold:turn-thought'], false))

test('the thought shows under the label while the turn is folded', () => {
  const html = renderToStaticMarkup(<WorkingTimelineRow row={row} />)
  expect(html).toContain('Reading pricing.css…')
  expect(html).toContain('data-latest-thought')
  expect(html).toContain('Start with the card grid.')
})

test('with the fold open the thought is on screen in full, so the line leaves it out', () => {
  setConversationDisclosures(':', ['fold:turn-thought'], true)
  const html = renderToStaticMarkup(<WorkingTimelineRow row={row} />)
  expect(html).not.toContain('Start with the card grid.')
})

test('a row with no thought draws the label alone', () => {
  const html = renderToStaticMarkup(<WorkingTimelineRow row={{ ...row, latestThought: undefined }} />)
  expect(html).not.toContain('data-latest-thought')
})
