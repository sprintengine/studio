import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationEvent, ConversationEventType } from '../../../../../shared/conversation-runtime'
import { CommandOutputRow } from './commandOutputRow'
import { projectConversation, type CommandOutputEntry } from './conversationProjection'
import { deriveConversationTimelineRows } from './conversationTimeline'
import { applyEvent, createConversationProjectionState } from './incrementalConversationProjection'
import { TimelineRow, type TimelineChrome } from './timelineRows'

function event(type: ConversationEventType, at: number, payload: Record<string, unknown> = {}): ConversationEvent {
  return {
    id: `event-${at}`,
    sessionId: 'session',
    workspaceId: 'workspace',
    agentId: 'agent',
    providerId: 'claude-agent',
    modelId: 'sonnet',
    type,
    createdAt: at,
    payload,
  }
}

const CONTEXT_OUTPUT = '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| Messages | 10 |'

// `/context` as the transcript stores it: the message, the output, the end.
const contextTurn = [
  event('user_message', 0, { turnId: 't1', text: '/context' }),
  event('turn_started', 1, { turnId: 't1' }),
  event('command_output', 2, { turnId: 't1', command: 'context', output: CONTEXT_OUTPUT }),
  event('turn_completed', 3, { turnId: 't1' }),
]

const chrome: TimelineChrome = { assistantName: 'Claude Code', onRetry: () => undefined, retryDisabled: false }

test("a command's output is its turn's entry, after the message and in place of a reply", () => {
  const { entries } = projectConversation(contextTurn)
  expect(entries.map((entry) => entry.kind)).toEqual(['user', 'commandOutput', 'assistant'])
  expect(entries[1]).toEqual({
    kind: 'commandOutput',
    id: 'event-2',
    turnId: 't1',
    command: 'context',
    output: CONTEXT_OUTPUT,
    createdAt: 2,
  })
  // The turn itself has nothing to say, so it draws no row of its own.
  const rows = deriveConversationTimelineRows(entries, false)
  expect(rows.map((row) => row.kind)).toEqual(['user', 'commandOutput'])
})

test('the live projection adds the output as it arrives, as a reload replays it', () => {
  let state = createConversationProjectionState(contextTurn.slice(0, 2))
  for (const next of contextTurn.slice(2)) state = applyEvent(state, next)
  expect(state.projection.entries).toEqual(projectConversation(contextTurn).entries)
})

test('markdown output renders as markdown in a block headed by its command, with a copy glyph, and is copied as content', () => {
  const { entries } = projectConversation(contextTurn)
  const row = deriveConversationTimelineRows(entries, false).find((candidate) => candidate.kind === 'commandOutput')!
  const html = renderToStaticMarkup(<TimelineRow row={row} chrome={chrome} />)
  expect(html).toContain('data-conversation-row-kind="commandOutput"')
  expect(html).not.toMatch(/data-conversation-row-kind="commandOutput"[^>]*data-copy-exclude/)
  expect(html).toContain('/context')
  expect(html).toContain('data-command-output-markdown')
  // The heading and the table are drawn, not shown as their markdown.
  expect(html).toMatch(/<h2[^>]*>Context Usage<\/h2>/)
  expect(html).toContain('<table')
  expect(html).not.toContain('| Messages | 10 |')
  expect(html).toContain('aria-label="Copy output"')
})

const entry = (extra: Partial<CommandOutputEntry>): CommandOutputEntry => ({
  kind: 'commandOutput',
  id: 'e1',
  output: 'plain',
  createdAt: 0,
  ...extra,
})

test('output carrying terminal colours is drawn with them', () => {
  const html = renderToStaticMarkup(
    <CommandOutputRow entry={entry({ command: 'usage', output: '\u001b[31mred\u001b[0m ok' })} />,
  )
  expect(html).toContain('red')
  expect(html).not.toContain('\u001b')
  expect(html).toContain('var(--terminal-bg)')
  expect(html).not.toContain('data-command-output-markdown')
})

test("a note about a command reads as a line, not as the command's output", () => {
  const html = renderToStaticMarkup(
    <CommandOutputRow
      entry={entry({ command: 'clear', note: true, output: 'Claude Code started a new conversation.' })}
    />,
  )
  expect(html).toContain('data-command-output-note')
  expect(html).not.toContain('Copy output')
  expect(html).not.toContain('font-mono')
})

test('a report keeps its lines as printed, and its HTML as text', () => {
  const html = renderToStaticMarkup(
    <CommandOutputRow
      entry={entry({ command: 'context', output: '**Model:** sonnet\n**Tokens:** 9.7k\n<b>raw</b>' })}
    />,
  )
  expect(html).toMatch(/Model:<\/strong> sonnet<br\/?>/)
  expect(html).not.toContain('<b>raw</b>')
})
