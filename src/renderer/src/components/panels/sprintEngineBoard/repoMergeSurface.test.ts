import assert from 'node:assert/strict'

import {
  REPO_PR_STATE_LABEL,
  REPO_PR_STATE_TONE,
  repoPullRequestState,
  type RepoPullRequestState,
} from './repoMergeSurface'
import { pullRequestTone, type PullRequestState } from '../../../../../shared/git/pull-request'
import { STATUS_TONE_COLOR_VAR } from '../../ui/tokens'

// The per-repo pull request model. The module exists so that no two surfaces can
// disagree about what "Open" means or which tone a merged branch carries — and
// the tone half of that promise was only true within this module: it kept its own
// map, and it said CLOSED was muted neutral where the rest of the app was moving
// to the danger red GitHub itself uses.
//
// Epic pull-request-marks, decision 2: one shared tone map serves every surface.
// What is asserted below is the derivation, not the three literals — a copy that
// happened to agree today is exactly the thing that drifts.

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

const REAL_STATES: PullRequestState[] = ['open', 'merged', 'closed']

run('the three real states take their tone from the shared map', () => {
  for (const state of REAL_STATES) {
    assert.equal(
      REPO_PR_STATE_TONE[state],
      pullRequestTone(state),
      `${state} must ink the way every other surface inks it`,
    )
  }
  assert.equal(REPO_PR_STATE_TONE.closed, 'error', 'closed is the danger red, not a muted neutral')
  assert.equal(REPO_PR_STATE_TONE.merged, 'merged')
  assert.equal(REPO_PR_STATE_TONE.open, 'accent')
})

run('every tone resolves to a real status colour', () => {
  for (const state of Object.keys(REPO_PR_STATE_TONE) as RepoPullRequestState[]) {
    assert.ok(STATUS_TONE_COLOR_VAR[REPO_PR_STATE_TONE[state]], `${state} resolves to a token`)
  }
  assert.equal(
    new Set(REAL_STATES.map((state) => REPO_PR_STATE_TONE[state])).size,
    3,
    'three states, three tones — none of them collapses into another',
  )
})

run('`none` is the absence of a pull request, not a fourth state', () => {
  // Decision 3: nothing is drawn unless a pull request definitely exists. `none`
  // therefore takes no tone from the pull request map — it is neutral, and it
  // must never be given the closed one, which would say a pull request existed
  // and ended.
  assert.equal(REPO_PR_STATE_TONE.none, 'neutral')
  assert.notEqual(REPO_PR_STATE_TONE.none, REPO_PR_STATE_TONE.closed)
  assert.equal(REPO_PR_STATE_LABEL.none, 'No pull request')
})

run('a repo resolves to the state its record actually supports', () => {
  const repo = (over: Record<string, unknown>) =>
    ({
      id: 'x',
      root: '.',
      worktreePath: '.x/worktree',
      branchName: 'sprintengine/x',
      pullRequestUrl: null,
      pullRequestError: null,
      pullRequestState: null,
      ...over,
    }) as never

  assert.equal(repoPullRequestState(repo({ pullRequestState: 'merged' })), 'merged')
  assert.equal(repoPullRequestState(repo({ pullRequestState: 'closed' })), 'closed')
  // A URL and no read-back state is an OPEN pull request, not an unknown one.
  assert.equal(repoPullRequestState(repo({ pullRequestUrl: 'https://x/pull/1' })), 'open')
  // No URL and no state is no pull request at all.
  assert.equal(repoPullRequestState(repo({})), 'none')
  assert.equal(repoPullRequestState(repo({ pullRequestError: 'push rejected' })), 'none')
})

if (failures > 0) throw new Error(`${failures} repoMergeSurface contract(s) failed`)
console.log('ok - repoMergeSurface: one tone map, and `none` is not a fourth state')
