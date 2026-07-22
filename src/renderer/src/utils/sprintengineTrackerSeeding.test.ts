import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  derivePlanSourcedGoal,
  matchProxyItemByIssue,
  parseProxyTrackerIdentity,
} from './sprintengineTrackerSeeding'

// Regression coverage for the tracker sprint-seeding seam (MC-1639 / plan §3.6),
// which shipped in T9 with no test of its own. These three pure functions decide
// whether a Backlog launch takes the fresh-issue proxy path (§2 "the issue title
// as goal, fresh body/comments in the seed") or the byte-identical native path,
// and they encode the §3.4 underscore-frontmatter contract. Verifying them here
// stops a silent regression from routing a proxy item down the native path (a
// stale seed) or a native item down the proxy path (a phantom refresh).

// A faithful proxy file exactly as the T6 writer emits it: flat underscore
// external_* keys (external_id quoted, as a Jira numeric id is), Multicode-owned
// triage keys alongside, then the mirrored issue heading as the body's first line.
const PROXY_JIRA = `---
external_provider: jira
external_connection: trk-abc
external_id: "10023"
external_key: PROJ-17
external_url: https://acme.atlassian.net/browse/PROJ-17
status: in_progress
type: bug
---
# Login redirect loops on SSO

**State:** Open

The redirect bounces between the IdP and the app.
`

const NATIVE_ITEM = `---
status: idea
type: feature
difficulty: m
---
# Add a keyboard shortcut for Quick Open

A plain local backlog item with no tracker identity.
`

test('parseProxyTrackerIdentity reads the flat underscore external identity of a proxy file', () => {
  assert.deepEqual(parseProxyTrackerIdentity(PROXY_JIRA), {
    provider: 'jira',
    connectionId: 'trk-abc',
    externalId: '10023',
    nativeKey: 'PROJ-17',
    url: 'https://acme.atlassian.net/browse/PROJ-17',
  })
})

test('parseProxyTrackerIdentity returns null for a native item so it takes the byte-identical native path', () => {
  assert.equal(parseProxyTrackerIdentity(NATIVE_ITEM), null)
})

test('parseProxyTrackerIdentity returns null when a required identity key is missing', () => {
  // external_id stripped: without a stable id there is nothing to re-fetch, so the
  // launch must fall back to the on-disk snapshot rather than invent an issue.
  const withoutId = PROXY_JIRA.replace('external_id: "10023"\n', '')
  assert.equal(parseProxyTrackerIdentity(withoutId), null)
})

test('parseProxyTrackerIdentity rejects the dotted key form (only underscore keys round-trip)', () => {
  // The §3.4 trap: the frontmatter key charset excludes the dot, so a dotted
  // top-level key never parses. If the writer/reader ever drifted back to a dotted
  // form the identity would silently vanish — this pins the underscore contract.
  const dotted = PROXY_JIRA
    .replace('external_provider: jira', 'external.provider: jira')
    .replace('external_connection: trk-abc', 'external.connection: trk-abc')
    .replace('external_id: "10023"', 'external.id: "10023"')
  assert.equal(parseProxyTrackerIdentity(dotted), null)
})

test('parseProxyTrackerIdentity returns null for an unrecognized provider value', () => {
  const gitlab = PROXY_JIRA.replace('external_provider: jira', 'external_provider: gitlab')
  assert.equal(parseProxyTrackerIdentity(gitlab), null)
})

type TestItem = {
  relativePath: string
  path: string
  sourceContent: string
  links: ReadonlyArray<{ type: string; target?: { kind?: string; id?: string } }>
}

function proxyRow(overrides: Partial<TestItem>): TestItem {
  return {
    relativePath: 'backlog/2026-07-15-jira-PROJ-17.md',
    path: '/repo/backlog/2026-07-15-jira-PROJ-17.md',
    sourceContent: PROXY_JIRA,
    links: [{ type: 'issue', target: { kind: 'jira.issue', id: '10023' } }],
    ...overrides,
  }
}

test('matchProxyItemByIssue finds the proxy item by its issue link kind + external id', () => {
  const wanted = proxyRow({ relativePath: 'backlog/wanted.md' })
  const other = proxyRow({
    relativePath: 'backlog/other.md',
    links: [{ type: 'issue', target: { kind: 'jira.issue', id: '99999' } }],
  })
  const found = matchProxyItemByIssue([other, wanted], 'jira', '10023')
  assert.equal(found?.relativePath, 'backlog/wanted.md')
})

test('matchProxyItemByIssue ignores a non-issue link even when its kind and id coincide', () => {
  // An execution/run link that happened to carry a matching target must not be
  // mistaken for the issue link the materializer stamps — only `issue` links map.
  const executionOnly = proxyRow({
    links: [{ type: 'execution', target: { kind: 'jira.issue', id: '10023' } }],
  })
  assert.equal(matchProxyItemByIssue([executionOnly], 'jira', '10023'), null)
})

test('matchProxyItemByIssue returns null when no item mirrors the issue', () => {
  const github = proxyRow({ links: [{ type: 'issue', target: { kind: 'github.issue', id: '10023' } }] })
  assert.equal(matchProxyItemByIssue([github], 'jira', '10023'), null)
})

test('derivePlanSourcedGoal makes the issue title the run goal (§2: title-as-goal)', () => {
  assert.equal(
    derivePlanSourcedGoal(PROXY_JIRA, 'backlog/2026-07-15-jira-PROJ-17-login.md'),
    'Login redirect loops on SSO',
  )
})

test('derivePlanSourcedGoal falls back to the filename stem when the seed has no heading', () => {
  assert.equal(
    derivePlanSourcedGoal('Just a body with no markdown heading.\n', 'backlog/fix-the-login-bug.md'),
    'fix the login bug',
  )
})
