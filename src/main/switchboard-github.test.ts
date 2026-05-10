import assert from 'node:assert/strict'
import { nextGitHubPageUrl } from './switchboard-github'

{
  const header = '<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last"'
  assert.equal(nextGitHubPageUrl(header), 'https://api.github.com/repositories/1/issues?page=2')
}

{
  const header = '<https://api.github.com/repositories/1/issues?page=1>; rel="prev", <https://api.github.com/repositories/1/issues?page=5>; rel="last"'
  assert.equal(nextGitHubPageUrl(header), null)
}

{
  assert.equal(nextGitHubPageUrl(null), null)
}
