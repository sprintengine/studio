import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConversationPeekCard } from './ConversationPeekCard'
import type { AgentTabIdentity } from './AgentTabIdentityPopover'
import { test } from 'vitest'

test('AgentTabIdentityPopover', async () => {
  // QA for what an agent TAB's hover card now is. The card itself is
  // `ConversationPeekCard` (its own suite covers the facts); this one holds the
  // tab-specific rulings: 2026-09-09, when it became ONE agent's card — the
  // tab's own — with no roster to move it elsewhere; and 2026-10-04, when the
  // card became a glance, and the tab's took no place lines because the window
  // around it already says them.
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

  function tabCard(identity: AgentTabIdentity = TAB): string {
    return renderToStaticMarkup(<ConversationPeekCard identity={identity} now={NOW} />)
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

  run('the tab card names the agent, its model and its state', () => {
    const markup = tabCard()
    assert.match(markup, /planner-agent/, 'names the agent')
    assert.match(markup, /Model: claude-opus-4-8 · Claude Code/, 'shows the exact model and its runtime')
    assert.match(markup, /Working/, 'shows the status label')
    assert.equal(markup.includes('Copy session id'), false, 'the session id went with the reader')
  })

  run('a paused or idle tab card reads its age on its own clock, not the tab’s draw time', () => {
    // The card formats `aged` against the clock it reads as it renders, so a
    // tab drawn once and hovered much later still says how long it has been.
    const paused = tabCard({
      ...TAB,
      status: { kind: 'attention', label: 'Paused', aged: { label: 'Paused', since: Date.now() - 2 * 60_000 } },
    })
    assert.match(paused, /Paused · 2m/)
    const typed = tabCard({
      ...TAB,
      status: { kind: 'idle', label: 'Idle', aged: { label: 'Last typed', since: Date.now() - 12 * 60_000 } },
    })
    assert.match(typed, /Last typed · 12m/)
    const fresh = tabCard({
      ...TAB,
      status: { kind: 'idle', label: 'Idle', aged: { label: 'Last typed', since: Date.now() - 5_000 } },
    })
    assert.match(fresh, /Idle/, 'under a minute the plain label stands')
    assert.equal(fresh.includes('Last typed'), false)
  })

  run('the tab card has no place lines — the window around it says them', () => {
    const markup = tabCard()
    assert.equal(/Machine:|Branch:/.test(markup), false)
    assert.equal(/<dl[\s>]/.test(markup), false, 'and no definition list')
  })

  run('and no conversation: the rail shows that now', () => {
    assert.equal(tabCard().includes('conversation-peek-thread'), false)
  })

  run('a tab whose agent has no session yet is still identified', () => {
    const markup = tabCard({ ...TAB, agent: { ...SELF, sessionId: '' } })
    assert.match(markup, /planner-agent/, 'the tab is still named')
  })

  run('the tab card is its own agent’s, with no way to move it to another', () => {
    const markup = tabCard()
    assert.equal(/role="radiogroup"/.test(markup), false, 'no roster')
    assert.equal(/role="radio"/.test(markup), false, 'no discs')
    assert.equal(markup.includes('agents'), false, 'and the header never counts the chat’s terminals')
    assert.match(markup, /planner-agent/, 'the tab you hovered is the conversation shown')
  })

  run('the tab card draws this agent’s own subagents and context', () => {
    const markup = tabCard({
      ...TAB,
      agent: {
        ...SELF,
        activeSubagents: 3,
        contextUsage: { usedPercentage: 61, at: NOW, contextWindowSize: 200_000 },
      },
    })
    assert.match(markup, />3 running</, 'the corner says what it is doing')
    assert.match(markup, /Context: 122k \/ 200k tokens · 61%/, 'the context line reads this session')
  })

  if (failures !== 0) process.exit(1)
})
