import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { AgentTabIdentityCard, type AgentTabIdentity } from './AgentTabIdentityPopover'

// QA for the agent-tab identity card content. The card is the presentational
// half of the hover popout (the portal/hover half can't be server-rendered), so
// this exercises the field logic that matters: model vs CLI-default fallback,
// role line, runtime/task rows, and the copyable session id.

function card(identity: AgentTabIdentity, copied = false): string {
  return renderToStaticMarkup(
    <AgentTabIdentityCard identity={identity} copied={copied} onCopy={() => {}} />,
  )
}

const ROLELESS: AgentTabIdentity = {
  name: 'planner-agent',
  roleLabel: 'No role',
  model: 'claude-opus-4-8',
  cli: 'claude-code',
  cliLabel: 'Claude Code',
  sessionId: 'a21ac8e7-548f-6f89',
  taskId: null,
  worktree: null,
  status: { tone: 'good', pulse: true, label: 'Working' },
  lastMessage: null,
}

// --- Roleless agent: model + runtime + session, no task --------------------
const roleless = card(ROLELESS)
assert.match(roleless, /planner-agent/, 'shows the agent name')
assert.match(roleless, /No role/, 'an agent with no role says so, and is never called a General agent')
assert.equal(/General agent/.test(roleless), false, '"General agent" is not a thing the app says')
assert.match(roleless, /claude-opus-4-8/, 'shows the exact model as text')
assert.match(roleless, /Claude Code/, 'shows the friendly runtime label')
assert.match(roleless, /a21ac8e7-548f-6f89/, 'shows the session id')
assert.match(roleless, /aria-label="Copy session id"/i, 'exposes a copy affordance for the session id')
assert.match(roleless, /Working/, 'shows the status label')
assert.equal(/>Task</.test(roleless), false, 'roleless agent shows no Task row')

// --- Model unset reads "CLI default", never blank --------------------------
const noModel = card({ ...ROLELESS, model: null })
assert.match(noModel, /CLI default/, 'null model falls back to "CLI default"')
assert.equal(/claude-opus-4-8/.test(noModel), false, 'no stale model string when unset')

// --- Sprint agent: role + task ---------------------------------------------
const sprint = card({
  ...ROLELESS,
  name: 'nuclear-reviewer',
  roleLabel: 'Nuclear · sprint',
  model: 'claude-sonnet-4-6',
  taskId: 'MC-1444',
  status: { tone: 'warn', pulse: false, label: 'Blocked — needs input' },
})
assert.match(sprint, /Nuclear · sprint/, 'shows the sprint role line')
assert.match(sprint, /MC-1444/, 'shows the claimed task id')
assert.match(sprint, /Blocked — needs input/, 'shows the blocked status label')

// --- Checkout: main checkout vs a named worktree branch --------------------
assert.match(roleless, /Checkout/, 'always shows a Checkout row')
assert.match(roleless, /Main checkout/, 'a main-checkout agent says so plainly')

const onWorktree = card({
  ...ROLELESS,
  worktree: { branch: 'feat/tab-identity', cwd: '/tmp/wt/feat-tab-identity' },
})
assert.match(onWorktree, /feat\/tab-identity/, 'a worktree agent shows its branch')
assert.equal(/Main checkout/.test(onWorktree), false, 'worktree agent is not labelled main checkout')
assert.match(onWorktree, /title="\/tmp\/wt\/feat-tab-identity"/, 'worktree cwd is available on hover')

// --- Last message: on THIS card, never a second hover surface --------------
// An agent tab used to open the identity card and a prompt-peek popover at the
// same time, one over the other. The message is a row here now; the row clamps
// and carries the full text in its own tooltip, because a prompt has no length
// limit and a card that grew with it would cover the work it describes.
const withMessage = card({
  ...ROLELESS,
  lastMessage: { text: 'Rewrite the door bar so it lifts into the app strip', at: Date.now() - 60_000 },
})
assert.match(withMessage, /Last message/, 'the card carries a Last message row')
assert.match(withMessage, /Rewrite the door bar/, 'and the message itself')
assert.match(withMessage, /line-clamp-2/, 'clamped, so a long prompt cannot grow the card without bound')
assert.equal(
  /Last message/.test(roleless),
  false,
  'a tab with no captured prompt shows no empty row',
)

// --- Paused agent: status reads "Paused", never "Idle" ---------------------
const paused = card({
  ...ROLELESS,
  status: { tone: 'neutral', pulse: false, label: 'Paused · 13m' },
})
assert.match(paused, /Paused · 13m/, 'a suspended agent reads Paused with elapsed time')
assert.equal(/>Idle</.test(paused), false, 'paused agent never shows an Idle status')

// --- Never-started agent: no session row, no copy button -------------------
const noSession = card({ ...ROLELESS, sessionId: null })
assert.equal(/Copy session id/i.test(noSession), false, 'no copy button without a session id')
assert.equal(/>Session</.test(noSession), false, 'no Session row without a session id')

// --- Copied flash flips the copy button's accessible name ------------------
const copiedMarkup = card(ROLELESS, true)
assert.match(copiedMarkup, /aria-label="Session id copied"/i, 'copied state announces success')

console.log('AgentTabIdentityPopover.test.tsx: all assertions passed')
