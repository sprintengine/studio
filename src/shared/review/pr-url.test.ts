import assert from 'node:assert/strict'
import { canonicalPullRequestUrl, parsePullRequestUrl } from './pr-url'

const tests: Array<{ name: string; body: () => void }> = []
function run(name: string, body: () => void): void {
  tests.push({ name, body })
}

run('github.com PR resolves to the github provider', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/acme/app/pull/123'), {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'app',
    number: 123,
  })
})

run('a non-github host resolves to github-enterprise', () => {
  assert.deepEqual(parsePullRequestUrl('https://ghe.example.com/team/service/pull/42'), {
    provider: 'github-enterprise',
    host: 'ghe.example.com',
    owner: 'team',
    repo: 'service',
    number: 42,
  })
})

run('trailing /files and /commits segments are ignored', () => {
  assert.equal(parsePullRequestUrl('https://github.com/acme/app/pull/7/files')?.number, 7)
  assert.equal(parsePullRequestUrl('https://github.com/acme/app/pull/7/commits')?.number, 7)
})

run('query-string noise does not defeat the match', () => {
  const parsed = parsePullRequestUrl('https://github.com/acme/app/pull/9?diff=split&w=1')
  assert.deepEqual(parsed, { provider: 'github', host: 'github.com', owner: 'acme', repo: 'app', number: 9 })
})

run('Bitbucket Server URLs return the typed unsupported marker', () => {
  assert.deepEqual(parsePullRequestUrl('https://bitbucket.example.com/projects/PROJ/repos/svc/pull-requests/5'), {
    unsupported: 'bitbucket',
  })
})

run('Bitbucket Cloud URLs return the typed unsupported marker', () => {
  assert.deepEqual(parsePullRequestUrl('https://bitbucket.org/workspace/repo/pull-requests/5'), {
    unsupported: 'bitbucket',
  })
})

run('non-PR and malformed URLs return null', () => {
  assert.equal(parsePullRequestUrl('https://github.com/acme/app'), null)
  assert.equal(parsePullRequestUrl('https://github.com/acme/app/pull/notanumber'), null)
  assert.equal(parsePullRequestUrl('https://github.com/acme/app/pull/0'), null)
  assert.equal(parsePullRequestUrl('ftp://github.com/acme/app/pull/1'), null)
  assert.equal(parsePullRequestUrl('just some words'), null)
  assert.equal(parsePullRequestUrl('   '), null)
})

run('a repository literally named "pull" still parses', () => {
  assert.deepEqual(parsePullRequestUrl('https://github.com/acme/pull/pull/3'), {
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    repo: 'pull',
    number: 3,
  })
})

run('canonicalPullRequestUrl strips query and trailing noise', () => {
  const parsed = parsePullRequestUrl('https://github.com/acme/app/pull/9/files?diff=split')
  assert.ok(parsed && 'provider' in parsed)
  if (parsed && 'provider' in parsed) {
    assert.equal(canonicalPullRequestUrl(parsed), 'https://github.com/acme/app/pull/9')
  }
})

function main(): void {
  let failed = false
  for (const test of tests) {
    try {
      test.body()
      console.log(`ok - ${test.name}`)
    } catch (error) {
      failed = true
      console.error(`not ok - ${test.name}`)
      console.error(error)
    }
  }
  if (failed) process.exit(1)
  console.log('pr-url.test.ts: ok')
}

main()
