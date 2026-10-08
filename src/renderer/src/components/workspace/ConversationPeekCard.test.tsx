import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConversationPeekCard, contextUsageText, type ConversationPeekIdentity } from './ConversationPeekCard'
import { RemoteMachineGlyph, WslMachineGlyph } from '../AppIcons'
import type { BranchPullRequest } from '../../../../shared/git/pull-request'
import { test } from 'vitest'

test('ConversationPeekCard', async () => {
  // QA for the conversation peek's card — the presentational half of the hover
  // surface both anchors share. What matters here is what the card SAYS: one
  // line per fact it was handed (machine, branch, model, context), no
  // line for a fact it was not, and that the conversation reader it used to be
  // (the thread, the file list, the session id) stayed cut.
  //
  // The kit's Tooltip runs a useLayoutEffect the static renderer no-ops; React
  // says so once per render and that warning is the one line of noise filtered.
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
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE

  const AGENT: ConversationPeekIdentity['agent'] = {
    sessionId: 'e4b3d55c-d78c-4687',
    cli: 'claude-code',
    model: 'claude-opus-5',
    pullRequests: [],
    activeSubagents: 0,
    contextUsage: null,
  }

  const IDENTITY: ConversationPeekIdentity = {
    name: 'Deara Shea',
    place: { machine: { label: 'studio-mini', kind: 'remote' }, branch: 'fix/peek-card' },
    status: { kind: 'working', label: 'Working' },
    agent: AGENT,
  }

  function card(
    over: {
      identity?: Partial<ConversationPeekIdentity>
      agent?: Partial<ConversationPeekIdentity['agent']>
    } = {},
  ): string {
    return renderToStaticMarkup(
      <ConversationPeekCard
        identity={{
          ...IDENTITY,
          ...over.identity,
          agent: { ...AGENT, ...over.agent },
        }}
        now={NOW}
      />,
    )
  }

  // --- The facts: one line each, where the chat runs before what it runs ------
  run('the card lists machine, branch, model and context, in that order', () => {
    const markup = card()
    const at = (needle: string) => {
      const index = markup.indexOf(needle)
      assert.ok(index >= 0, `${needle} is on the card`)
      return index
    }
    assert.ok(at('aria-label="Machine: studio-mini"') < at('aria-label="Branch: fix/peek-card"'))
    assert.ok(at('aria-label="Branch: fix/peek-card"') < at('aria-label="Model: claude-opus-5 · Claude Code"'))
    assert.equal(markup.includes('Project:'), false, 'the row already sits under its project')
  })

  run('a glance, not a dossier: four lines at most, and no footer', () => {
    const markup = card({ agent: { contextUsage: { usedPercentage: 42, at: NOW, contextWindowSize: 200_000 } } })
    assert.equal(markup.match(/<li/g)?.length, 4, 'machine, branch, model, context')
    assert.equal(markup.includes('border-t'), false, 'no prompt-cache footer under a divider')
  })

  run('a fact nobody knows draws no line, rather than an empty one', () => {
    const markup = card({ identity: { place: { machine: null, branch: 'main' } } })
    assert.match(markup, /Branch: main/)
    assert.equal(markup.includes('Machine:'), false, 'this computer is the unmarked default')
  })

  run('the tab’s card, which has no place, still says the model', () => {
    const markup = card({ identity: { place: null } })
    assert.equal(/Project:|Machine:|Branch:/.test(markup), false, 'the window around a tab already says these')
    assert.match(markup, /Model: claude-opus-5 · Claude Code/)
  })

  run('a model the agent never chose reads as the default, never blank', () => {
    const markup = card({ agent: { model: null } })
    assert.match(markup, /Model: Default model · Claude Code/)
  })

  run('the machine line wears the glyph of its kind', () => {
    const wsl = card({
      identity: { place: { machine: { label: 'WSL: Ubuntu', kind: 'wsl' }, branch: null } },
    })
    assert.match(wsl, /Machine: WSL: Ubuntu/)
    // Compared against the glyphs themselves rather than a copy of their
    // paths, so redrawing a machine mark does not fail a test about which
    // mark the line wears.
    const wslMark = renderToStaticMarkup(<WslMachineGlyph className="icon-xs" />)
    const remoteMark = renderToStaticMarkup(<RemoteMachineGlyph className="icon-xs" />)
    assert.notEqual(wslMark, remoteMark, 'the two kinds draw different marks')
    assert.ok(wsl.includes(wslMark), 'a WSL machine wears the WSL mark')
    assert.equal(wsl.includes(remoteMark), false)
    const remote = card({
      identity: { place: { machine: { label: 'studio', kind: 'remote' }, branch: null } },
    })
    assert.ok(remote.includes(remoteMark), 'any other machine wears the remote mark')
    assert.equal(remote.includes(wslMark), false)
  })

  // --- What the reader used to carry, and no longer does ---------------------
  run('there is no thread, no file list and no session id', () => {
    const markup = card()
    assert.equal(markup.includes('conversation-peek-thread'), false, 'the rail shows the conversation now')
    assert.equal(markup.includes('Files changed in this session'), false)
    assert.equal(markup.includes('Copy session id'), false)
    assert.equal(markup.includes('e4b3d55c'), false)
    assert.equal(/role="radiogroup"|role="radio"/.test(markup), false, 'and still no agent selector')
  })

  // --- The corner: the sidebar's mark and one word (mockup frame 2) ----------
  run('a working agent wears the sidebar’s own working mark and the word, never a status dot', () => {
    const markup = card()
    assert.match(markup, /working-mark/, 'the sidebar’s mark, so the row and the card agree')
    assert.match(markup, />Working</, 'and the word beside it')
    assert.equal(
      /status-dot|animate-pulse/.test(markup),
      false,
      'a pulsing disc six pixels from the mark would be two vocabularies for one fact',
    )
  })

  run('subagents replace the word rather than being added beside it', () => {
    const markup = card({ agent: { activeSubagents: 2 } })
    assert.match(markup, />2 running</, 'says what it is doing, not merely that it is doing something')
    assert.equal(markup.includes('>Working<'), false, 'and does not say both')
    assert.match(markup, /aria-label="2 running"/, 'the state travels in words, on the mark')
    assert.match(markup, /working-mark/, 'the mark stays: it is still working')
  })

  run('an idle agent drops the mark and takes the quieter ink', () => {
    const idle = card({ identity: { status: { kind: 'idle', label: 'Idle · 12m' } } })
    assert.match(idle, />Idle · 12m</, 'says how long, not a bare "Idle"')
    assert.equal(idle.includes('working-mark'), false, 'nothing is running, so nothing moves')
    // Read the CORNER's own class attribute, not the whole card: `text.subtle`
    // is on half the markup — the ages, the file glyph, the notes — so a match
    // anywhere would pass whatever ink the corner actually took.
    const cornerInk = (markup: string): string => markup.match(/<span class="(ml-auto[^"]*)"/)?.[1] ?? ''
    assert.match(cornerInk(idle), /--text-subtle/, 'idle recedes')
    assert.match(
      cornerInk(card({ identity: { status: { kind: 'attention', label: 'Waiting' } } })),
      /--text-muted/,
      'a chat that wants you does not',
    )
  })

  run('waiting and failed keep their labels and lose the mark', () => {
    for (const label of ['Waiting', 'Failed']) {
      const markup = card({ identity: { status: { kind: 'attention', label } } })
      assert.match(markup, new RegExp(`>${label}<`), `${label} still says so`)
      assert.equal(markup.includes('working-mark'), false, `${label} is not motion`)
    }
  })

  run('a subagent count is ignored unless the agent is actually working', () => {
    const markup = card({
      identity: { status: { kind: 'idle', label: 'Idle · 3m' } },
      agent: { activeSubagents: 4 },
    })
    assert.match(markup, />Idle · 3m</, 'a stale count must not claim work that stopped')
    assert.equal(markup.includes('4 running'), false)
  })

  run('a card with no status at all draws no corner', () => {
    const markup = card({ identity: { status: null } })
    assert.equal(markup.includes('working-mark'), false)
    assert.equal(markup.includes('Working'), false)
  })

  // --- Context: tokens, and the ring as the line's glyph ----------------------
  run('the context line says tokens against the window, and the percent', () => {
    const markup = card({ agent: { contextUsage: { usedPercentage: 42, at: NOW, contextWindowSize: 200_000 } } })
    assert.match(markup, /Context: 84k \/ 200k tokens · 42%/)
    assert.match(markup, /stroke-dasharray="15\.83 37\.70"/, 'and the ring sweeps that same value')
    assert.equal(markup.includes('Context 42% used'), false, 'the ring is decorative here — no second tooltip')
  })

  run('without a window size the line says the percent alone', () => {
    const markup = card({ agent: { contextUsage: { usedPercentage: 38, at: NOW } } })
    assert.match(markup, /Context: 38% of context used/)
  })

  run('past eighty per cent the ring turns the sidebar’s attention gold', () => {
    const markup = card({ agent: { contextUsage: { usedPercentage: 84, at: NOW, contextWindowSize: 200_000 } } })
    assert.match(markup, /var\(--tone-warn\)/, 'a compaction is coming, which is worth a glance')
  })

  run('nothing reported means no context line — not a line at zero', () => {
    assert.equal(card().includes('Context:'), false)
  })

  run('token counts read the way the turn footer reads them', () => {
    assert.equal(
      contextUsageText({ usedPercentage: 33, at: NOW, contextWindowSize: 128_000 }),
      '42.2k / 128k tokens · 33%',
    )
  })

  run('a one-million window reads in millions on the right and thousands on the left', () => {
    assert.equal(
      contextUsageText({ usedPercentage: 12, at: NOW, contextWindowSize: 1_000_000 }),
      '120k / 1M tokens · 12%',
    )
  })

  // --- The pull request on the head line (pull-request-marks, frame 3) -------
  //
  // What the words say is held in `PullRequestMark.test.tsx`; what is held here
  // is that the head carries it, in the right place, in the right shape.
  const pullRequest = (over: Partial<BranchPullRequest> & { number: number }): BranchPullRequest => ({
    url: `https://github.com/acme/sprintengine/pull/${over.number}`,
    repoKey: 'github.com/acme/sprintengine',
    repoName: 'sprintengine',
    title: `Pull request ${over.number}`,
    state: 'open',
    isDraft: false,
    openedAt: NOW - 12 * MINUTE,
    stateAt: NOW,
    ...over,
  })

  run('the head reads title · pull request · live corner, in that order', () => {
    const markup = card({
      agent: { pullRequests: [pullRequest({ number: 418, title: 'Extensions icon carries its unread count' })] },
    })
    const at = (needle: string) => {
      const index = markup.indexOf(needle)
      assert.ok(index >= 0, `${needle} is on the card`)
      return index
    }
    assert.ok(at('Deara Shea') < at('data-pull-request-mark'), 'the title before the pull request')
    assert.ok(at('data-pull-request-mark') < at('Working'), 'and the live corner last')
    assert.match(
      markup,
      /aria-label="Pull request 418, open: Extensions icon carries its unread count\. Open it on GitHub"/,
    )
  })

  run('the title is still the only thing on the head that yields width', () => {
    const markup = card({ agent: { pullRequests: [pullRequest({ number: 418 })] } })
    assert.match(markup, /truncate min-w-0 flex-1 text-heading/, 'the title keeps its ellipsis and its flex')
    const markIndex = markup.indexOf('data-pull-request-mark')
    assert.ok(markIndex > 0, 'the mark is on the head')
    // The mark is a control GROUP now (the split button's primary half, alone
    // when there is one pull request), so what must not shrink is the group and
    // the tooltip wrapper around it, not the inner button.
    const beforeTheMark = markup.slice(0, markIndex)
    assert.match(
      beforeTheMark.slice(-400),
      /flex shrink-0 items-center/,
      'the mark sits in a slot that holds its width',
    )
  })

  run('a conversation that opened nothing draws no mark at all', () => {
    const markup = card()
    assert.equal(markup.includes('data-pull-request-mark'), false)
    assert.equal(markup.includes('Pull request'), false)
  })

  run('one pull request is a plain link; a second grows the chevron beside it', () => {
    const one = card({ agent: { pullRequests: [pullRequest({ number: 418 })] } })
    assert.equal(one.includes('aria-haspopup="menu"'), false, 'a one-row menu says nothing')

    const two = card({
      agent: {
        pullRequests: [
          pullRequest({ number: 421 }),
          pullRequest({ number: 411, state: 'merged', openedAt: NOW - 2 * HOUR }),
        ],
      },
    })
    assert.match(two, /aria-haspopup="menu"/, 'the split control appears at two')
    assert.match(two, /aria-expanded="false"/, 'and says whether its menu is up')
    assert.match(two, /aria-label="All pull requests from this conversation, 2"/)
    assert.match(two, /Pull request 421, open/, 'the primary is still the most recent open one')
  })

  if (failures > 0) {
    console.error(`ConversationPeekCard.test.tsx: ${failures} failing`)
    process.exit(1)
  }
  console.log('ConversationPeekCard.test.tsx: ok')
})
