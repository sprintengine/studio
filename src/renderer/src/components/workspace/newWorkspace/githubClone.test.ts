import assert from 'node:assert/strict'

import { filterGitHubRepos, resolveCloneSource } from './githubClone'
import { validateCloneUrl } from '../../../../../shared/git-clone-url'
import type { GitHubRepoSummary } from '../../../../../shared/electron-api'
import { test } from 'vitest'

test('githubClone', async () => {
  // --- validateCloneUrl -------------------------------------------------------
  {
    const https = validateCloneUrl('https://github.com/octocat/multicode')
    assert.ok(https.ok, 'a github web URL is a valid clone source')
    assert.equal(https.ok && https.url, 'https://github.com/octocat/multicode', 'kept verbatim minus nothing')
    assert.equal(https.ok && https.repoName, 'multicode', 'repo name from the last path segment')
    assert.equal(https.ok && https.httpsHost, 'github.com', 'host surfaces for token routing')
  }
  {
    const suffixed = validateCloneUrl('https://github.com/octocat/multicode.git/')
    assert.ok(suffixed.ok, '.git suffix and trailing slash are accepted')
    assert.equal(suffixed.ok && suffixed.repoName, 'multicode', '.git is stripped from the name')
  }
  {
    const scp = validateCloneUrl('git@github.com:octocat/multicode.git')
    assert.ok(scp.ok, 'scp-style ssh is a valid clone source')
    assert.equal(scp.ok && scp.httpsHost, null, 'no https host — the token must never ride ssh')
    assert.equal(scp.ok && scp.repoName, 'multicode')
  }
  {
    const sshUrl = validateCloneUrl('ssh://git@github.com/octocat/multicode.git')
    assert.ok(sshUrl.ok, 'ssh:// URLs are accepted')
  }
  {
    const pageUrl = validateCloneUrl('https://github.com/octocat/multicode/tree/main/src')
    assert.ok(pageUrl.ok, 'a github.com page URL with a sub-path is accepted')
    assert.equal(pageUrl.ok && pageUrl.url, 'https://github.com/octocat/multicode', 'normalized to the repo root')
    assert.equal(pageUrl.ok && pageUrl.repoName, 'multicode')
  }
  {
    const otherHost = validateCloneUrl('https://gitlab.example.com/group/sub/repo.git')
    assert.ok(otherHost.ok, 'non-github https hosts keep their full path')
    assert.equal(
      otherHost.ok && otherHost.url,
      'https://gitlab.example.com/group/sub/repo.git',
      'no truncation off github.com',
    )
    assert.equal(otherHost.ok && otherHost.repoName, 'repo')
  }
  assert.equal(validateCloneUrl('').ok, false, 'blank is rejected')
  assert.equal(validateCloneUrl('-oProxyCommand=evil').ok, false, 'a leading dash never reaches git argv')
  assert.equal(validateCloneUrl('ext::sh -c whoami').ok, false, 'exotic transports are rejected')
  assert.equal(validateCloneUrl('file:///etc').ok, false, 'file transport is rejected')
  assert.equal(validateCloneUrl('http://github.com/a/b').ok, false, 'plain http is rejected')
  assert.equal(validateCloneUrl('https://user:pass@github.com/a/b').ok, false, 'embedded credentials are rejected')
  assert.equal(validateCloneUrl('https://github.com/').ok, false, 'a URL with no repo path is rejected')
  assert.equal(validateCloneUrl('not a url').ok, false, 'whitespace is rejected')

  // --- resolveCloneSource -----------------------------------------------------
  const repo: GitHubRepoSummary = {
    fullName: 'octocat/weather-api',
    name: 'weather-api',
    owner: 'octocat',
    isPrivate: true,
    description: 'Standalone service',
    cloneUrl: 'https://github.com/octocat/weather-api.git',
    defaultBranch: 'main',
    pushedAt: '2026-08-30T00:00:00Z',
  }

  {
    const picked = resolveCloneSource(repo, '')
    assert.ok(picked.source, 'a picked repo resolves')
    assert.equal(picked.source?.url, repo.cloneUrl, 'the API clone_url is used verbatim')
    assert.equal(picked.source?.repoName, 'weather-api', 'folder leaf comes from the repo name')
  }
  {
    const blank = resolveCloneSource(null, '   ')
    assert.equal(blank.source, null, 'nothing chosen resolves to nothing')
    assert.equal(blank.error, null, 'a blank draft is not an error')
  }
  {
    const pasted = resolveCloneSource(null, 'https://github.com/foo/bar')
    assert.equal(pasted.source?.repoName, 'bar', 'a pasted URL resolves its repo name')
  }
  {
    const invalid = resolveCloneSource(null, 'ftp://nope')
    assert.equal(invalid.source, null)
    assert.ok(invalid.error, 'an unparseable non-blank draft carries its error inline')
  }

  // --- filterGitHubRepos ------------------------------------------------------
  const repos: GitHubRepoSummary[] = [
    repo,
    { ...repo, fullName: 'octocat/multicode', name: 'multicode', description: 'SprintEngine Studio desktop app' },
  ]
  assert.equal(filterGitHubRepos(repos, '').length, 2, 'no filter returns everything')
  assert.equal(filterGitHubRepos(repos, 'WEATHER').length, 1, 'full-name match, case-insensitive')
  assert.equal(filterGitHubRepos(repos, 'desktop app').length, 1, 'description matches too')
  assert.equal(filterGitHubRepos(repos, 'zzz').length, 0, 'no match filters all')

  console.log('githubClone tests passed')
})
