import assert from 'node:assert/strict'

import { pullRequestComment, runCompletedComment, runStartedComment } from './messages'

// Verifies the write-back comment bodies (MC-1640 / T10): plain human copy, the
// goal carried through, PR links listed and de-duplicated, singular/plural
// wording, and no leaked internals. These are the exact strings a team sees on
// the tracker, so their wording is contract.

async function main(): Promise<void> {
  testStarted()
  testPullRequestSingularAndPlural()
  testCompletedSummaryWithAndWithoutPrs()
  testNoAgentJargon()

  console.log('tracker-writeback-messages tests passed')
}

function testStarted(): void {
  const body = runStartedComment({ goal: 'Fix the login bug' })
  assert.match(body, /Sprint started/)
  assert.match(body, /Working on: Fix the login bug/)
  assert.match(body, /posted automatically by Multicode/)

  // An empty goal degrades gracefully — no dangling "Working on:".
  assert.doesNotMatch(runStartedComment({ goal: '   ' }), /Working on:/)
}

function testPullRequestSingularAndPlural(): void {
  const one = pullRequestComment({ goal: 'x', pullRequestUrls: ['https://h/pull/1'] })
  assert.match(one, /Pull request opened/)
  assert.match(one, /- https:\/\/h\/pull\/1/)

  const many = pullRequestComment({ goal: 'x', pullRequestUrls: ['https://h/pull/1', 'https://h/pull/2', 'https://h/pull/1'] })
  assert.match(many, /Pull requests opened/)
  // The duplicate is collapsed.
  assert.equal(many.match(/pull\/1/g)?.length, 1)
}

function testCompletedSummaryWithAndWithoutPrs(): void {
  const withPrs = runCompletedComment({ goal: 'Ship it', pullRequestUrls: ['https://h/pull/9'], taskCount: 4 })
  assert.match(withPrs, /Sprint completed/)
  assert.match(withPrs, /Goal: Ship it/)
  assert.match(withPrs, /All 4 tasks finished/)
  assert.match(withPrs, /Pull request:/)
  assert.match(withPrs, /https:\/\/h\/pull\/9/)

  const noPrs = runCompletedComment({ goal: 'Ship it', pullRequestUrls: [], taskCount: 1 })
  assert.match(noPrs, /All 1 task finished/)
  assert.doesNotMatch(noPrs, /Pull request/)
}

function testNoAgentJargon(): void {
  const bodies = [
    runStartedComment({ goal: 'g' }),
    pullRequestComment({ goal: 'g', pullRequestUrls: ['u'] }),
    runCompletedComment({ goal: 'g', pullRequestUrls: [], taskCount: 2 }),
  ]
  for (const body of bodies) {
    assert.doesNotMatch(body, /projection|statePath|roster|agentId|token|secret/i)
  }
}

void main()
