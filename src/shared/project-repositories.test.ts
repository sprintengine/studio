import assert from 'node:assert/strict'
import { test } from 'vitest'

import { projectRepositoriesInstructions, projectRepositoryOf, type ProjectRepositories } from './project-repositories'

const acme: ProjectRepositories = {
  root: '/Users/dev/acme',
  source: { kind: 'children' },
  repositories: [
    { path: '/Users/dev/acme/api', relativePath: 'api', name: 'api' },
    { path: '/Users/dev/acme/services/billing', relativePath: 'services/billing', name: 'billing' },
  ],
  truncated: false,
}

test('the instruction names the folder, every repository, and says to run git inside each', () => {
  const text = projectRepositoriesInstructions(acme)
  assert.ok(text)
  assert.match(text, /`\/Users\/dev\/acme`\) is not itself a Git repository/u)
  assert.match(text, /holds 2 repositories/u)
  assert.match(text, /^- `api\/`$/mu)
  assert.match(text, /^- `services\/billing\/`$/mu)
  assert.match(text, /git -C <repository> status/u)
  assert.doesNotMatch(text, /and more/u)
})

test('one repository reads as one, and a truncated list says there are more', () => {
  const one = projectRepositoriesInstructions({ ...acme, repositories: acme.repositories.slice(0, 1) })
  assert.match(one ?? '', /holds one repository/u)
  assert.match(projectRepositoriesInstructions({ ...acme, truncated: true }) ?? '', /^- and more, not listed here$/mu)
})

test('a folder with no repositories has no instruction', () => {
  assert.equal(projectRepositoriesInstructions(null), null)
  assert.equal(projectRepositoriesInstructions({ ...acme, repositories: [] }), null)
})

test('a project-relative path is found in its repository, the deepest one first', () => {
  const repositories = [{ relativePath: 'services' }, { relativePath: 'services/billing' }, { relativePath: 'api' }]
  assert.deepEqual(projectRepositoryOf(repositories, 'api/src/user.ts'), {
    repository: { relativePath: 'api' },
    inner: 'src/user.ts',
  })
  assert.deepEqual(projectRepositoryOf(repositories, 'services/billing/main.go'), {
    repository: { relativePath: 'services/billing' },
    inner: 'main.go',
  })
  assert.equal(projectRepositoryOf(repositories, 'apiary/readme.md'), null)
  assert.equal(projectRepositoryOf(repositories, 'README.md'), null)
})
