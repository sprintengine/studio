import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConversationPeekCard } from './ConversationPeekCard'
import type { AgentTabIdentity } from './AgentTabIdentityPopover'
import type { ConversationPeek } from '../../../../shared/conversation-peek'

// QA for what an agent TAB's hover card now is. The card itself is
// `ConversationPeekCard` (its own suite covers the message half); this one holds
// the tab-specific ruling of 2026-09-07: the identity card stopped being six
// definition rows and became the conversation, and the four rows that were
// repeating the window are gone for good.
//
// The portal/hover half cannot be server-rendered, so this exercises the card
// with a tab-shaped identity — which is exactly what the popover hands it.
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return
  consoleError(...args)
}

let failures = 0
function run(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

const NOW = 1_800_000_000_000

const SELF = {
  sessionId: 'a21ac8e7-548f-6f89',
  name: 'planner-agent',
  initials: 'PA',
  cli: 'claude-code' as const,
  model: 'claude-opus-4-8',
  status: { tone: 'good' as const, pulse: true, label: 'Working' },
}

const TAB: AgentTabIdentity = {
  name: 'planner-agent',
  taskId: null,
  status: { tone: 'good', pulse: true, label: 'Working' },
  // A tab opens the card on ITS OWN agent, so the tab's agent always leads the
  // roster it is handed — see `WorkspaceLayout`, which reorders the chat's
  // roster to put it first.
  roster: [SELF],
}

const PEEK: ConversationPeek = {
  sessionId: SELF.sessionId,
  source: 'transcript',
  first: {
    id: 'm1',
    text: 'Freeze the title after the first prompt and put the rest on the hover.',
    at: NOW - 3 * 3_600_000,
    attachments: [],
    truncatedChars: 0,
  },
  since: [
    {
      id: 'm2',
      text: 'Drop the role row from the tab card while you are in there',
      at: NOW - 32 * 60_000,
      attachments: [],
      truncatedChars: 0,
    },
  ],
  totalMessages: 2,
}

function tabCard(identity: AgentTabIdentity = TAB, peek: ConversationPeek | null = PEEK): string {
  return renderToStaticMarkup(
    <ConversationPeekCard
      identity={identity}
      peek={peek}
      loading={false}
      now={NOW}
      copied={false}
      onCopySession={() => {}}
      onOpenAttachment={() => {}}
    />,
  )
}

run('the tab card keeps the two facts that earned their place', () => {
  const markup = tabCard()
  assert.match(markup, /planner-agent/, 'names the agent')
  assert.match(markup, /claude-opus-4-8/, 'shows the exact model')
  assert.match(markup, /a21ac8e7…6f89/, 'shows the session id, elided in the middle')
  assert.match(markup, /aria-label="Copy session id"/, 'and the session keeps its copy button')
  assert.match(markup, /Working/, 'shows the status label')
})

run('Role, Runtime and Checkout are gone, and so is the label column that held them up', () => {
  const markup = tabCard()
  for (const gone of ['No role', 'General agent', 'Claude Code', 'Main checkout']) {
    assert.equal(markup.includes(gone), false, `"${gone}" is not a thing the tab card says any more`)
  }
  assert.equal(/<dl[\s>]/.test(markup), false, 'no definition list — the label column went with the rows')
})

run('the space they freed is the conversation', () => {
  const markup = tabCard()
  assert.match(markup, /Freeze the title after the first prompt/, 'the message that started the work')
  assert.match(markup, /Drop the role row from the tab card/, 'and everything sent since')
})

run('a sprint agent still names the task it is claimed on', () => {
  const markup = tabCard({ ...TAB, taskId: 'MC-1444' })
  assert.match(markup, /MC-1444/, 'the task id survived the cull')
})

run('a tab whose agent has no session yet is still identified', () => {
  const markup = tabCard({ ...TAB, roster: [] }, null)
  assert.match(markup, /planner-agent/, 'the tab is still named')
  assert.equal(markup.includes('Copy session id'), false, 'nothing to copy, so no button')
})

run('the tab card opens on its own agent, and lists the chat’s others beside it', () => {
  const markup = tabCard({
    ...TAB,
    name: 'Retry budget for stalled sprints',
    roster: [
      SELF,
      {
        sessionId: 'other-1',
        name: 'Lir Lynch',
        initials: 'LL',
        cli: 'codex',
        model: 'gpt-5-codex',
        status: { tone: 'neutral', pulse: false, label: 'Idle' },
      },
    ],
  })
  assert.match(markup, /Conversation with planner-agent/, 'the tab you hovered is the conversation shown')
  assert.match(markup, /aria-label="Lir Lynch — Idle"/, 'the chat’s other terminal is one disc away')
  assert.match(markup, /2 agents/, 'and the header counts them')
})

process.exit(failures === 0 ? 0 : 1)
