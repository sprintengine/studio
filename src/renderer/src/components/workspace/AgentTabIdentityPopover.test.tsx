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

const GENERAL: AgentTabIdentity = {
  name: 'planner-agent',
  roleLabel: 'General agent',
  model: 'claude-opus-4-8',
  cli: 'claude-code',
  cliLabel: 'Claude Code',
  sessionId: 'a21ac8e7-548f-6f89',
  taskId: null,
  worktree: null,
  status: { tone: 'good', pulse: true, label: 'Working' },
}

// --- General agent: model + runtime + session, no task ---------------------
const general = card(GENERAL)
assert.match(general, /planner-agent/, 'shows the agent name')
assert.match(general, /General agent/, 'shows the role line')
assert.match(general, /claude-opus-4-8/, 'shows the exact model as text')
assert.match(general, /Claude Code/, 'shows the friendly runtime label')
assert.match(general, /a21ac8e7-548f-6f89/, 'shows the session id')
assert.match(general, /aria-label="Copy session id"/i, 'exposes a copy affordance for the session id')
assert.match(general, /Working/, 'shows the status label')
assert.equal(/>Task</.test(general), false, 'general agent shows no Task row')

// --- Model unset reads "CLI default", never blank --------------------------
const noModel = card({ ...GENERAL, model: null })
assert.match(noModel, /CLI default/, 'null model falls back to "CLI default"')
assert.equal(/claude-opus-4-8/.test(noModel), false, 'no stale model string when unset')

// --- Sprint agent: role + task ---------------------------------------------
const sprint = card({
  ...GENERAL,
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
assert.match(general, /Checkout/, 'always shows a Checkout row')
assert.match(general, /Main checkout/, 'a main-checkout agent says so plainly')

const onWorktree = card({
  ...GENERAL,
  worktree: { branch: 'feat/tab-identity', cwd: '/tmp/wt/feat-tab-identity' },
})
assert.match(onWorktree, /feat\/tab-identity/, 'a worktree agent shows its branch')
assert.equal(/Main checkout/.test(onWorktree), false, 'worktree agent is not labelled main checkout')
assert.match(onWorktree, /title="\/tmp\/wt\/feat-tab-identity"/, 'worktree cwd is available on hover')

// --- Paused agent: status reads "Paused", never "Idle" ---------------------
const paused = card({
  ...GENERAL,
  status: { tone: 'neutral', pulse: false, label: 'Paused · 13m' },
})
assert.match(paused, /Paused · 13m/, 'a suspended agent reads Paused with elapsed time')
assert.equal(/>Idle</.test(paused), false, 'paused agent never shows an Idle status')

// --- Never-started agent: no session row, no copy button -------------------
const noSession = card({ ...GENERAL, sessionId: null })
assert.equal(/Copy session id/i.test(noSession), false, 'no copy button without a session id')
assert.equal(/>Session</.test(noSession), false, 'no Session row without a session id')

// --- Copied flash flips the copy button's accessible name ------------------
const copiedMarkup = card(GENERAL, true)
assert.match(copiedMarkup, /aria-label="Session id copied"/i, 'copied state announces success')

console.log('AgentTabIdentityPopover.test.tsx: all assertions passed')
