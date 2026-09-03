import assert from 'node:assert/strict'

import { parseBacklogFrontmatter } from '../backlog/frontmatter'
import type { NormalizedIssue } from './types'
import { composeIssueMarkdown, issueSprintGoal } from './issue-markdown'

// The seed a tracker-sourced sprint is started from (MC-2358/MC-2359). It is
// written into the run's own gitignored directory — never into backlog/ — so
// these assertions are about what an architect reads, not about a stored item.

function issue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    provider: 'jira',
    connectionId: 'conn-1',
    externalId: '10023',
    nativeKey: 'PROJ-17',
    title: 'Login redirect loops on SSO',
    bodyMarkdown: 'The redirect bounces between the IdP and the app.',
    state: { category: 'open', nativeName: 'In Progress' },
    labels: [],
    url: 'https://acme.atlassian.net/browse/PROJ-17',
    comments: [],
    ...overrides,
  }
}

function testCarriesTheIdentityTheRunBoardReads(): void {
  const { fields } = parseBacklogFrontmatter(composeIssueMarkdown(issue()))
  assert.equal(fields.external_provider, 'jira')
  assert.equal(fields.external_key, 'PROJ-17')
  assert.equal(fields.external_url, 'https://acme.atlassian.net/browse/PROJ-17')
}

// Acceptance criteria usually live in the comments rather than the description,
// so a seed that drops them hands the architect half the brief.
function testIncludesTheCommentThread(): void {
  const markdown = composeIssueMarkdown(
    issue({
      comments: [
        { author: 'r.okafor', body: 'Only reproduces with SAML, not OIDC.', createdAt: '2026-09-01' },
        { body: '' },
      ],
    }),
  )
  assert.match(markdown, /## Comments/)
  assert.match(markdown, /Only reproduces with SAML/)
  assert.match(markdown, /r\.okafor · 2026-09-01/)
  // An empty comment is marked rather than rendered as a blank gap.
  assert.match(markdown, /_\(empty comment\)_/)
}

// The marker must not read as "a local copy we keep in step" — that framing is
// what made the old proxy items a second writer.
function testSaysTheTrackerIsTheSystemOfRecord(): void {
  const markdown = composeIssueMarkdown(issue(), { capturedAt: '2026-09-03T00:00:00.000Z' })
  assert.match(markdown, /Snapshot of this Jira issue, taken 2026-09-03T00:00:00\.000Z/)
  assert.match(markdown, /system of record/)
  assert.doesNotMatch(markdown, /mirrors an external issue|replaced when it refreshes/)
}

function testStateFactsAndFallbacks(): void {
  assert.match(composeIssueMarkdown(issue()), /\*\*State:\*\* In Progress/)
  // No description is stated plainly rather than left as an empty section.
  assert.match(composeIssueMarkdown(issue({ bodyMarkdown: '   ' })), /_No description provided\._/)
  // A closed issue with no native state name still reads honestly.
  assert.match(
    composeIssueMarkdown(issue({ state: { category: 'closed', nativeName: '' } })),
    /\*\*State:\*\* Closed/,
  )
}

function testGoalKeepsTheNativeKey(): void {
  assert.equal(issueSprintGoal(issue()), 'PROJ-17 — Login redirect loops on SSO')
  assert.equal(issueSprintGoal(issue({ title: '  ' })), 'PROJ-17')
}

testCarriesTheIdentityTheRunBoardReads()
testIncludesTheCommentThread()
testSaysTheTrackerIsTheSystemOfRecord()
testStateFactsAndFallbacks()
testGoalKeepsTheNativeKey()
console.log('issue-markdown.test.ts: all assertions passed')
