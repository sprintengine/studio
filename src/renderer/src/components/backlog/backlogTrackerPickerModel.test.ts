import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { NormalizedIssue } from '../../../../shared/electron-api'
import type { BacklogItemLink } from '../../utils/backlog'
import {
  backlogIssueLinkIndex,
  isIssueInBacklog,
  issueIndexKey,
  materializeReport,
  trackerIssueStateChip,
} from './backlogTrackerPickerModel'

function issueLink(overrides: Partial<BacklogItemLink> & { kind: string; id: string }): BacklogItemLink {
  return {
    id: 'tracker:issue',
    moduleId: 'tracker',
    type: 'issue',
    label: overrides.label ?? 'PROJ-1',
    target: { kind: overrides.kind, id: overrides.id, url: 'https://tracker/x' },
  }
}

function issue(overrides: Partial<NormalizedIssue> = {}): NormalizedIssue {
  return {
    provider: 'jira',
    connectionId: 'trk-1',
    externalId: '10023',
    nativeKey: 'PROJ-141',
    title: 'Relay ledger purge',
    bodyMarkdown: '',
    state: { category: 'open', nativeName: 'Open' },
    labels: [],
    url: 'https://tracker/PROJ-141',
    comments: [],
    ...overrides,
  }
}

test('backlogIssueLinkIndex collects only issue-typed links keyed by provider + externalId', () => {
  const items = [
    { links: [issueLink({ kind: 'jira.issue', id: '10023' })] },
    { links: [issueLink({ kind: 'github.issue', id: 'acme/web#1' })] },
    // Non-issue links (execution / agent) and non-.issue kinds are ignored.
    {
      links: [
        { id: 'run', moduleId: 'se', type: 'execution', label: 'run', target: { kind: 'sprintengine.run', id: 'r1' } },
      ] as BacklogItemLink[],
    },
    { links: [] },
  ]
  const index = backlogIssueLinkIndex(items)
  assert.equal(index.size, 2)
  assert.ok(index.has(issueIndexKey('jira', '10023')))
  assert.ok(index.has(issueIndexKey('github', 'acme/web#1')))
  assert.ok(isIssueInBacklog(index, 'jira', '10023'))
  assert.ok(!isIssueInBacklog(index, 'jira', '99999'))
  // Same externalId under a different provider is a distinct identity.
  assert.ok(!isIssueInBacklog(index, 'linear', '10023'))
})

test('trackerIssueStateChip tones by structural category, labels by verbatim native name', () => {
  assert.deepEqual(trackerIssueStateChip(issue({ state: { category: 'open', nativeName: 'In Progress' } })), {
    tone: 'neutral',
    label: 'In Progress',
  })
  assert.deepEqual(trackerIssueStateChip(issue({ state: { category: 'closed', nativeName: 'Done' } })), {
    tone: 'good',
    label: 'Done',
  })
  // A blank native name falls back to the category word, never an empty chip.
  assert.equal(trackerIssueStateChip(issue({ state: { category: 'closed', nativeName: '  ' } })).label, 'Closed')
})

test('materializeReport states added/refreshed and never hides failures', () => {
  assert.equal(
    materializeReport({ added: 3, refreshed: 0, failed: [] }),
    'Added 3 — native keys stay visible, and the items keep themselves fresh.',
  )
  assert.equal(
    materializeReport({ added: 2, refreshed: 1, failed: [] }),
    'Added 2 and refreshed 1 — native keys stay visible, and the items keep themselves fresh.',
  )
  assert.equal(
    materializeReport({ added: 0, refreshed: 2, failed: [] }),
    'Refreshed 2 — native keys stay visible, and the items keep themselves fresh.',
  )
  // A partial failure names the native key + the provider's reason.
  const partial = materializeReport({
    added: 1,
    refreshed: 0,
    failed: [{ key: 'PROJ-9', reason: 'Rate limited — retry in 60s.' }],
  })
  assert.match(partial, /Added 1/)
  assert.match(partial, /1 issue couldn’t be added: PROJ-9 \(Rate limited — retry in 60s\.\)\./)
  // An all-failure result never reads as a success.
  assert.equal(
    materializeReport({ added: 0, refreshed: 0, failed: [{ key: '#1', reason: 'Not found.' }] }),
    '1 issue couldn’t be added: #1 (Not found.).',
  )
})
