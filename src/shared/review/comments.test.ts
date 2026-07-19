import assert from 'node:assert/strict'
import {
  validateReviewComment,
  validateReviewWorkspaceState,
  type ReviewComment,
  type ReviewWorkspaceState,
} from './comments'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

function validComment(): ReviewComment {
  return {
    id: 'c-1',
    path: 'src/a.ts',
    anchor: { side: 'new', startLine: 3, endLine: 3 },
    body: 'Should this handle the empty case?',
    createdAt: '2026-07-17T11:00:00Z',
    sync: { state: 'pending' },
  }
}

function validState(): ReviewWorkspaceState {
  return {
    schemaVersion: 1,
    changeSetId: 'cs-1',
    readFiles: ['src/a.ts'],
    activeStepId: 'step-a',
    diffView: 'side-by-side',
    comments: [validComment()],
  }
}

function commentErrors(mutate: (c: ReviewComment) => void): string[] {
  const comment = JSON.parse(JSON.stringify(validComment())) as ReviewComment
  mutate(comment)
  const result = validateReviewComment(comment)
  return result.ok ? [] : result.errors
}

function stateErrors(mutate: (s: ReviewWorkspaceState) => void): string[] {
  const state = JSON.parse(JSON.stringify(validState())) as ReviewWorkspaceState
  mutate(state)
  const result = validateReviewWorkspaceState(state)
  return result.ok ? [] : result.errors
}

run('a valid comment and a valid workspace state round-trip', () => {
  assert.ok(validateReviewComment(validComment()).ok)
  assert.ok(validateReviewWorkspaceState(validState()).ok)
})

run('every sync state validates with its required fields', () => {
  assert.ok(validateReviewComment({ ...validComment(), sync: { state: 'posting' } }).ok)
  assert.ok(
    validateReviewComment({
      ...validComment(),
      sync: { state: 'posted', url: 'https://x/1', postedAt: '2026-07-17T11:05:00Z' },
    }).ok,
  )
  assert.ok(validateReviewComment({ ...validComment(), sync: { state: 'failed', error: 'rate limited' } }).ok)
})

run('an unknown sync state is rejected, naming it', () => {
  const errors = commentErrors((c) => ((c.sync as { state: string }).state = 'syncing'))
  assert.match(errors.join('\n'), /sync\.state has unknown value "syncing"/)
})

run('a posted sync missing its url is rejected', () => {
  const errors = commentErrors((c) => (c.sync = { state: 'posted', postedAt: '2026-07-17T11:05:00Z' } as never))
  assert.match(errors.join('\n'), /sync\.url must be a non-empty string/)
})

run('an empty comment body is rejected', () => {
  const errors = commentErrors((c) => (c.body = ''))
  assert.match(errors.join('\n'), /body must be a non-empty string/)
})

run('a comment with a malformed anchor is rejected', () => {
  const errors = commentErrors((c) => (c.anchor.endLine = 0))
  assert.match(errors.join('\n'), /anchor\.endLine must be a positive integer/)
})

run('an unknown diffView is rejected', () => {
  const errors = stateErrors((s) => ((s as { diffView: string }).diffView = 'unified'))
  assert.match(errors.join('\n'), /diffView has unknown value "unified"/)
})

run('a non-array readFiles is rejected', () => {
  const errors = stateErrors((s) => ((s as { readFiles: unknown }).readFiles = 'src/a.ts'))
  assert.match(errors.join('\n'), /readFiles must be a string array/)
})

run('a bad schemaVersion is rejected, naming the version', () => {
  const errors = stateErrors((s) => ((s as { schemaVersion: number }).schemaVersion = 9))
  assert.match(errors.join('\n'), /state\.schemaVersion must be 1; got 9/)
})

run('an invalid nested comment surfaces a path-qualified error', () => {
  const errors = stateErrors((s) => (s.comments[0].id = ''))
  assert.match(errors.join('\n'), /comments\[0\]\.id must be a non-empty string/)
})

run('unknown extra keys are tolerated for forward compat', () => {
  const state = JSON.parse(JSON.stringify(validState())) as ReviewWorkspaceState & { future?: unknown }
  state.future = { later: true }
  assert.ok(validateReviewWorkspaceState(state).ok)
})

function main(): void {
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      console.error(`not ok - ${test.name}`)
      throw error
    }
  }
  console.log('comments.test.ts: ok')
}

main()
