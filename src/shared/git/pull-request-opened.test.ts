import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  isPullRequestCreation,
  PULL_REQUEST_OUTPUT_SCAN_CHARS,
  readOpenedPullRequest,
  toolCommandOf,
} from './pull-request-opened'

const PR = 'https://github.com/acme/app/pull/12'

// What `gh pr create` prints: the progress line on stderr, the URL last.
const GH_OUTPUT = `\nCreating pull request for feature/marks into main in acme/app\n\n${PR}\n`

test('the gate is the call: a create command or a create tool', () => {
  for (const command of [
    'gh pr create --fill',
    'cd ../site && gh  pr   create --title "Marks" --body-file /tmp/body.md',
    '/opt/homebrew/bin/gh pr create',
    'glab mr create --fill --yes',
    'git push -o merge_request.create origin HEAD',
    'git push --push-option=merge_request.create -o merge_request.target=main origin feature',
  ]) {
    assert.equal(isPullRequestCreation({ name: 'Bash', command }), true, command)
  }
  for (const command of [
    'gh pr list --state all',
    'gh pr view 12 --web',
    'glab mr view 4',
    'git push origin feature',
    'git push -o ci.skip origin feature',
    'echo merge_request.create',
  ]) {
    assert.equal(isPullRequestCreation({ name: 'Bash', command }), false, command)
  }
  for (const name of [
    'mcp__github__create_pull_request',
    'mcp__gitlab__create_merge_request',
    'github_create_pull_request',
    'gitea.create_pull_request',
  ]) {
    assert.equal(isPullRequestCreation({ name }), true, name)
  }
  for (const name of ['mcp__github__list_pull_requests', 'mcp__github__get_pull_request', 'pull_request.link']) {
    assert.equal(isPullRequestCreation({ name }), false, name)
  }
  // The command is read off the input under every spelling the CLIs use.
  assert.equal(toolCommandOf({ command: ['bash', '-lc', 'gh pr create'] }), 'bash -lc gh pr create')
  assert.equal(toolCommandOf({ cmd: 'gh pr create' }), 'gh pr create')
  assert.equal(toolCommandOf('gh pr create'), null)
  assert.equal(isPullRequestCreation({ name: 'shell', input: { command: ['bash', '-lc', 'gh pr create'] } }), true)
})

test('the evidence is the result: a pull request URL in what the call returned', () => {
  assert.deepEqual(readOpenedPullRequest({ name: 'Bash', command: 'gh pr create', output: GH_OUTPUT }), {
    url: PR,
    forge: 'github',
  })
  // Claude Code's Bash result is an object; its JSON ends the URL where the string did.
  assert.deepEqual(
    readOpenedPullRequest({
      name: 'Bash',
      input: { command: 'gh pr create' },
      output: { stdout: `${PR}\n`, stderr: 'Creating pull request', interrupted: false },
    }),
    { url: PR, forge: 'github' },
  )
  assert.deepEqual(
    readOpenedPullRequest({
      name: 'Bash',
      command: 'glab mr create --fill --yes',
      output:
        '\nCreating merge request for feature into main in acme/app\n\n!4 Marks (feature)\n https://gitlab.example.com/acme/app/-/merge_requests/4\n',
    }),
    { url: 'https://gitlab.example.com/acme/app/-/merge_requests/4', forge: 'gitlab' },
  )
  // An MCP result names API URLs before the page; only the page is a pull request.
  assert.deepEqual(
    readOpenedPullRequest({
      name: 'mcp__github__create_pull_request',
      output: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ url: 'https://api.github.com/repos/acme/app/pulls/12', html_url: PR }),
          },
        ],
      },
    }),
    { url: PR, forge: 'github' },
  )

  // Not openings.
  assert.equal(readOpenedPullRequest({ name: 'Bash', command: 'gh pr create', output: 'aborted' }), null)
  assert.equal(readOpenedPullRequest({ name: 'Bash', command: 'gh pr list', output: PR }), null)
  assert.equal(readOpenedPullRequest({ name: 'Bash', command: 'gh pr create', output: GH_OUTPUT, failed: true }), null)
  assert.equal(
    readOpenedPullRequest({
      name: 'Bash',
      command: 'gh pr create',
      output: `a pull request for branch "feature" into branch "main" already exists:\n${PR}`,
    }),
    null,
  )
  assert.equal(
    readOpenedPullRequest({
      name: 'Bash',
      command: 'git push && gh pr create',
      output:
        "remote: Create a pull request for 'feature' on GitHub by visiting:\nremote:   https://github.com/acme/app/pull/new/feature\n",
    }),
    null,
  )
})

test('a long output is read at both ends', () => {
  const noise = 'x'.repeat(PULL_REQUEST_OUTPUT_SCAN_CHARS * 2)
  assert.deepEqual(readOpenedPullRequest({ name: 'Bash', command: 'gh pr create', output: `${noise}\n${PR}\n` }), {
    url: PR,
    forge: 'github',
  })
  assert.deepEqual(
    readOpenedPullRequest({
      name: 'mcp__gitea__create_pull_request',
      output: `{"html_url":"https://codeberg.org/acme/app/pulls/3"}${noise}`,
    }),
    { url: 'https://codeberg.org/acme/app/pulls/3', forge: 'gitea' },
  )
  // A URL the head's cut runs through is not believed: `/pull/1` of `/pull/1234`.
  const half = PULL_REQUEST_OUTPUT_SCAN_CHARS / 2
  const cut = `${'y'.repeat(half - 'https://github.com/acme/app/pull/1'.length)}https://github.com/acme/app/pull/1234`
  assert.equal(readOpenedPullRequest({ name: 'Bash', command: 'gh pr create', output: `${cut}${noise}` }), null)
})
