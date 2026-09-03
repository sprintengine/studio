import assert from 'node:assert/strict'
import { test } from 'node:test'

import { derivePlanSourcedGoal } from './sprintengineTrackerSeeding'

// What survives of the tracker-seeding seam after MC-2359. The proxy-identity
// readers this file used to cover went with materialization: there are no
// mirrored tracker items to parse an identity out of, and a sprint started from
// a tracker issue composes its own seed rather than refreshing a file on disk.

const ISSUE_SEED = `# Login redirect loops on SSO

**State:** Open

The redirect bounces between the IdP and the app.
`

test('derivePlanSourcedGoal makes the first heading the run goal (§2: title-as-goal)', () => {
  assert.equal(
    derivePlanSourcedGoal(ISSUE_SEED, 'backlog/2026-07-15-jira-PROJ-17-login.md'),
    'Login redirect loops on SSO',
  )
})

test('derivePlanSourcedGoal falls back to the filename stem when the seed has no heading', () => {
  assert.equal(
    derivePlanSourcedGoal('Just a body with no markdown heading.\n', 'backlog/fix-the-login-bug.md'),
    'fix the login bug',
  )
})
