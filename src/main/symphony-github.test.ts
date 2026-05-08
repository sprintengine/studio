import assert from 'node:assert/strict'
import { upsertGitHubIssues, type SymphonyGitHubIssue } from './symphony-github'
import type { GitHubRepoRef } from './git-github'

const repo: GitHubRepoRef = {
  owner: 'acme',
  repo: 'widgets',
  webUrl: 'https://github.com/acme/widgets',
}

function issue(patch: Partial<SymphonyGitHubIssue> = {}): SymphonyGitHubIssue {
  return {
    number: 7,
    title: 'Initial remote title',
    body: 'Initial remote body',
    htmlUrl: 'https://github.com/acme/widgets/issues/7',
    updatedAt: '2026-05-07T12:00:00Z',
    ...patch,
  }
}

{
  const state = {}

  const first = upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:01:00Z')
  const second = upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:02:00Z')

  assert.equal(first.created, 1)
  assert.equal(second.created, 0)
  assert.equal(second.updated, 1)
  assert.equal(second.tasks.length, 1)
  assert.equal(second.tasks[0].id, 'GH-7')
}

{
  const state = {}

  upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:01:00Z')
  const result = upsertGitHubIssues(
    state,
    repo,
    [issue({
      title: 'Updated remote title',
      body: 'Updated remote body',
      updatedAt: '2026-05-07T13:00:00Z',
    })],
    '2026-05-07T13:01:00Z'
  )

  assert.equal(result.tasks[0].title, 'Updated remote title')
  assert.equal(result.tasks[0].description, 'Updated remote body')
  assert.equal(result.tasks[0].source?.syncStatus, 'remote_changed')
}

{
  const state = {}

  upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:01:00Z')
  const task = upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:02:00Z').tasks[0]
  task.description = 'Local execution brief'

  const result = upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:03:00Z')

  assert.equal(result.tasks[0].description, 'Local execution brief')
  assert.equal(result.tasks[0].source?.syncStatus, 'local_changed')
}

{
  const state = {}

  upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:01:00Z')
  const task = upsertGitHubIssues(state, repo, [issue()], '2026-05-07T12:02:00Z').tasks[0]
  task.description = 'Local execution brief'

  const result = upsertGitHubIssues(
    state,
    repo,
    [issue({
      body: 'Remote body changed too',
      updatedAt: '2026-05-07T13:00:00Z',
    })],
    '2026-05-07T13:01:00Z'
  )

  assert.equal(result.tasks[0].description, 'Local execution brief')
  assert.equal(result.tasks[0].source?.body, 'Remote body changed too')
  assert.equal(result.tasks[0].source?.syncStatus, 'conflict')
}
