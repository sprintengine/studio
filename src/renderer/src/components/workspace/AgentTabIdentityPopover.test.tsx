import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConversationPeekCard } from './ConversationPeekCard'
import type { AgentTabIdentity } from './AgentTabIdentityPopover'
import type { ConversationPeek } from '../../../../shared/conversation-peek'
import { test } from 'vitest'

test('AgentTabIdentityPopover', async () => {
  // QA for what an agent TAB's hover card now is. The card itself is
  // `ConversationPeekCard` (its own suite covers the message half); this one holds
  // the tab-specific rulings: 2026-09-07, when the identity card stopped being six
  // definition rows and became the conversation; and 2026-09-09, when it became
  // ONE agent's card — the tab's own — with no roster to move it elsewhere.
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

  const SELF: AgentTabIdentity['agent'] = {
    sessionId: 'a21ac8e7-548f-6f89',
    cli: 'claude-code',
    model: 'claude-opus-4-8',
    fileChanges: [],
    pullRequests: [],
    activeSubagents: 0,
    contextUsage: null,
  }

  const TAB: AgentTabIdentity = {
    name: 'planner-agent',
    status: { kind: 'working', label: 'Working' },
    // A tab's card is ITS OWN agent's — see `WorkspaceLayout`, which builds this
    // from the tab's agent record and that agent's session snapshot.
    agent: SELF,
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
    images: [],
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

  // Both anchors show the same head, because both are this one card (epic
  // pull-request-marks): a pull request opened by the agent behind THIS tab is on
  // the tab's card exactly as it is on the sidebar row's.
  run('the tab’s card wears the same pull request mark the sidebar row does', () => {
    const markup = tabCard({
      ...TAB,
      agent: {
        ...SELF,
        pullRequests: [
          {
            url: 'https://github.com/acme/sprintengine/pull/418',
            repoKey: 'github.com/acme/sprintengine',
            repoName: 'sprintengine',
            number: 418,
            title: 'Extensions icon carries its unread count',
            state: 'open',
            isDraft: false,
            openedAt: NOW - 12 * 60_000,
            stateAt: NOW,
          },
        ],
      },
    })
    assert.match(
      markup,
      /aria-label="Pull request 418, open: Extensions icon carries its unread count\. Open it on GitHub"/,
    )
    assert.match(markup, /data-pull-request-mark/)
  })

  run('a tab whose agent opened nothing draws no mark', () => {
    assert.equal(tabCard().includes('data-pull-request-mark'), false)
  })

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

  run('a tab whose agent has no session yet is still identified', () => {
    const markup = tabCard({ ...TAB, agent: { ...SELF, sessionId: '' } }, null)
    assert.match(markup, /planner-agent/, 'the tab is still named')
    assert.equal(markup.includes('Copy session id'), false, 'nothing to copy, so no button')
  })

  run('the tab card is its own agent’s, with no way to move it to another', () => {
    const markup = tabCard()
    assert.equal(/role="radiogroup"/.test(markup), false, 'no roster')
    assert.equal(/role="radio"/.test(markup), false, 'no discs')
    assert.equal(markup.includes('agents'), false, 'and the header never counts the chat’s terminals')
    assert.match(markup, /planner-agent/, 'the tab you hovered is the conversation shown')
  })

  run('the tab card draws this agent’s own files, subagents and context', () => {
    const markup = tabCard({
      ...TAB,
      agent: {
        ...SELF,
        activeSubagents: 3,
        contextUsage: { usedPercentage: 61, at: NOW },
        fileChanges: [
          { path: '/repo/src/main/agent-state.ts', additions: 12, deletions: 3, edits: 1, lastEditedAt: NOW },
        ],
      },
    })
    assert.match(markup, />3 running</, 'the corner says what it is doing')
    assert.match(markup, /aria-label="Context 61% used"/, 'the ring reads this session')
    assert.match(markup, /aria-label="Open the diff for \/repo\/src\/main\/agent-state\.ts"/, 'and its edits open')
  })

  if (failures !== 0) process.exit(1)
})
