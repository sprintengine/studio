import assert from 'node:assert/strict'

import { createRunIssueLookup } from './run-issue-lookup'

// MC-2359: a run's tracker issue comes from the sidecar the launch wrote beside
// the run state, not from scanning the backlog for a proxy item that links back.

const STATE_PATH = '/repo/.multi-code/sprintengine/eng-423/run.yaml'

function lookupReturning(raw: string | null) {
  return createRunIssueLookup({ readRunSource: async () => raw })
}

async function testReadsTheRunsIssueReference(): Promise<void> {
  const lookup = lookupReturning(
    JSON.stringify({
      provider: 'linear',
      connectionId: 'conn-1',
      externalId: 'issue-uuid',
      nativeKey: 'ENG-423',
      url: 'https://linear.app/acme/issue/ENG-423',
      capturedAt: '2026-09-03T00:00:00.000Z',
    }),
  )
  const issues = await lookup.issuesForRun({ workspaceRoot: '/repo', statePath: STATE_PATH })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].provider, 'linear')
  assert.equal(issues[0].connectionId, 'conn-1')
  assert.equal(issues[0].externalId, 'issue-uuid')
  assert.equal(issues[0].nativeKey, 'ENG-423')
  // The notice metadata names the run — there is no backlog item to point at.
  assert.match(issues[0].relativePath, /sprintengine\/eng-423/)
}

// The common case by far: most runs are not started from a tracker at all.
async function testNoSidecarMeansNoIssues(): Promise<void> {
  const lookup = lookupReturning(null)
  assert.deepEqual(await lookup.issuesForRun({ workspaceRoot: '/repo', statePath: STATE_PATH }), [])
}

// Posting to a guessed issue would be worse than posting nothing.
async function testCorruptSidecarPostsNothing(): Promise<void> {
  const lookup = lookupReturning('{ not json')
  assert.deepEqual(await lookup.issuesForRun({ workspaceRoot: '/repo', statePath: STATE_PATH }), [])
}

async function testUnknownProviderIsRefused(): Promise<void> {
  const lookup = lookupReturning(
    JSON.stringify({ provider: 'trello', connectionId: 'c', externalId: 'x', nativeKey: 'T-1' }),
  )
  assert.deepEqual(await lookup.issuesForRun({ workspaceRoot: '/repo', statePath: STATE_PATH }), [])
}

async function testMissingNativeKeyFallsBackToTheExternalId(): Promise<void> {
  const lookup = lookupReturning(JSON.stringify({ provider: 'jira', connectionId: 'c', externalId: '10023' }))
  const issues = await lookup.issuesForRun({ workspaceRoot: '/repo', statePath: STATE_PATH })
  assert.equal(issues[0].nativeKey, '10023')
}

async function main(): Promise<void> {
  await testReadsTheRunsIssueReference()
  await testNoSidecarMeansNoIssues()
  await testCorruptSidecarPostsNothing()
  await testUnknownProviderIsRefused()
  await testMissingNativeKeyFallsBackToTheExternalId()
  console.log('run-issue-lookup.test.ts: all assertions passed')
}

void main()
