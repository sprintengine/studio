import assert from 'node:assert/strict'
import { canonicalPullRequestUrl, classifyPullRequestUrl, parsePullRequestUrl } from './pr-url'
import { test } from 'vitest'

test('pr-url', async () => {
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
    assert.deepEqual(parsePullRequestUrl('https://github.com/acme/app/pull/7/files'), {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 7,
    })
    assert.deepEqual(parsePullRequestUrl('https://github.com/acme/app/pull/7/commits'), {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 7,
    })
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

  run('a GHES host on a non-default port keeps the port', () => {
    // A self-hosted server behind `https://github.example.com:8443` is reachable
    // only WITH the port: the canonical URL is what is stored, what the link
    // opens and what `gh pr view <url>` is handed, and a port dropped from any of
    // those points at a host that does not answer (or is not the one gh has auth
    // for, which never settles).
    const parsed = parsePullRequestUrl('https://github.example.com:8443/acme/app/pull/77')
    assert.ok(parsed && 'provider' in parsed, 'a ported GHES URL still parses')
    if (parsed && 'provider' in parsed) {
      assert.deepEqual(parsed, {
        provider: 'github-enterprise',
        host: 'github.example.com',
        port: '8443',
        owner: 'acme',
        repo: 'app',
        number: 77,
      })
      assert.equal(canonicalPullRequestUrl(parsed), 'https://github.example.com:8443/acme/app/pull/77')
    }
    // The default port is not a port: every github.com URL is untouched.
    assert.deepEqual(parsePullRequestUrl('https://github.com:443/acme/app/pull/2'), {
      provider: 'github',
      host: 'github.com',
      owner: 'acme',
      repo: 'app',
      number: 2,
    })
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
})

test('every forge’s pull request URL is read off its path, on any host', () => {
  const cases: Array<[string, ReturnType<typeof classifyPullRequestUrl>]> = [
    [
      'https://github.com/acme/app/pull/12/files?w=1#diff',
      {
        forge: 'github',
        url: 'https://github.com/acme/app/pull/12',
        repositoryUrl: 'https://github.com/acme/app',
        number: 12,
      },
    ],
    [
      'https://ghe.example.com:8443/acme/app/pull/3',
      {
        forge: 'github',
        url: 'https://ghe.example.com:8443/acme/app/pull/3',
        repositoryUrl: 'https://ghe.example.com:8443/acme/app',
        number: 3,
      },
    ],
    [
      'https://gitlab.com/acme/platform/app/-/merge_requests/41/diffs',
      {
        forge: 'gitlab',
        url: 'https://gitlab.com/acme/platform/app/-/merge_requests/41',
        repositoryUrl: 'https://gitlab.com/acme/platform/app',
        number: 41,
      },
    ],
    [
      'https://codeberg.org/acme/app/pulls/7',
      {
        forge: 'gitea',
        url: 'https://codeberg.org/acme/app/pulls/7',
        repositoryUrl: 'https://codeberg.org/acme/app',
        number: 7,
      },
    ],
    [
      'https://bitbucket.org/acme/app/pull-requests/9/overview',
      {
        forge: 'bitbucket',
        url: 'https://bitbucket.org/acme/app/pull-requests/9',
        repositoryUrl: 'https://bitbucket.org/acme/app',
        number: 9,
      },
    ],
    [
      'https://git.example.com/projects/ACME/repos/app/pull-requests/5',
      {
        forge: 'bitbucket',
        url: 'https://git.example.com/projects/ACME/repos/app/pull-requests/5',
        repositoryUrl: 'https://git.example.com/projects/ACME/repos/app',
        number: 5,
      },
    ],
    [
      'https://dev.azure.com/acme/platform/_git/app/pullrequest/77',
      {
        forge: 'azure-devops',
        url: 'https://dev.azure.com/acme/platform/_git/app/pullrequest/77',
        repositoryUrl: 'https://dev.azure.com/acme/platform/_git/app',
        number: 77,
      },
    ],
  ]
  for (const [raw, expected] of cases) assert.deepEqual(classifyPullRequestUrl(raw), expected, raw)

  // A doubtful match is no match.
  for (const raw of [
    'https://github.com/acme/app/pull/new/feature',
    'https://github.com/acme/app/pull/12.diff',
    'https://github.com/acme/app/issues/12',
    'https://github.com/acme/app/pulls',
    'https://api.github.com/repos/acme/app/pulls/12',
    'https://gitea.example.com/api/v1/repos/acme/app/pulls/12',
    'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature',
    'https://gitlab.com/api/v4/projects/1/merge_requests/2',
    'https://bitbucket.org/acme/app/pull-requests/new?source=feature',
    'https://codeberg.org/acme/app/compare/main...feature',
    'https://dev.azure.com/acme/platform/_git/app/pullrequestcreate?sourceRef=feature',
    'ftp://github.com/acme/app/pull/1',
    'not a url',
  ]) {
    assert.equal(classifyPullRequestUrl(raw), null, raw)
  }
})
