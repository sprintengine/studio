import assert from 'node:assert/strict'

import { mapGitHubIssueState, mapJiraStatusCategory, mapLinearStateType, normalizeIssueState } from './state-mapping'

// The normalization contract (plan §3.1): open/closed is derived from the
// tracker's STRUCTURAL category, never a display name. Each fixture row pairs a
// raw structural value with a deliberately misleading display name to prove the
// display name is ignored.

type Fixture = { structural: string; nativeName: string; expected: 'open' | 'closed' }

const JIRA_FIXTURE: Fixture[] = [
  { structural: 'new', nativeName: 'Done backlog', expected: 'open' }, // name says "Done" but category is new
  { structural: 'indeterminate', nativeName: 'In Review', expected: 'open' },
  { structural: 'done', nativeName: 'Shipped', expected: 'closed' }, // renamed "Done" still closes
  { structural: 'DONE', nativeName: 'Complete', expected: 'closed' }, // case-insensitive
]

const LINEAR_FIXTURE: Fixture[] = [
  { structural: 'backlog', nativeName: 'Icebox', expected: 'open' },
  { structural: 'unstarted', nativeName: 'Todo', expected: 'open' },
  { structural: 'started', nativeName: 'Done-ish', expected: 'open' }, // name says done, type says started
  { structural: 'completed', nativeName: 'Merged', expected: 'closed' },
  { structural: 'canceled', nativeName: 'Won’t do', expected: 'closed' },
]

const GITHUB_FIXTURE: Fixture[] = [
  { structural: 'open', nativeName: 'Closed-looking', expected: 'open' },
  { structural: 'closed', nativeName: 'Resolved', expected: 'closed' },
  { structural: 'CLOSED', nativeName: 'Done', expected: 'closed' },
]

function main(): void {
  for (const row of JIRA_FIXTURE) {
    assert.equal(mapJiraStatusCategory(row.structural), row.expected, `jira ${row.structural}`)
    assert.deepEqual(normalizeIssueState({ provider: 'jira', statusCategoryKey: row.structural, nativeName: row.nativeName }), {
      category: row.expected,
      nativeName: row.nativeName,
    })
  }

  for (const row of LINEAR_FIXTURE) {
    assert.equal(mapLinearStateType(row.structural), row.expected, `linear ${row.structural}`)
    assert.deepEqual(normalizeIssueState({ provider: 'linear', stateType: row.structural, nativeName: row.nativeName }), {
      category: row.expected,
      nativeName: row.nativeName,
    })
  }

  for (const row of GITHUB_FIXTURE) {
    assert.equal(mapGitHubIssueState(row.structural), row.expected, `github ${row.structural}`)
    assert.deepEqual(normalizeIssueState({ provider: 'github', state: row.structural, nativeName: row.nativeName }), {
      category: row.expected,
      nativeName: row.nativeName,
    })
  }

  // An unknown Jira/Linear structural value defaults OPEN (never silently closed).
  assert.equal(mapJiraStatusCategory('custom-weird-key'), 'open')
  assert.equal(mapLinearStateType('triage'), 'open')

  console.log('tracker-state-mapping tests passed')
}

main()
