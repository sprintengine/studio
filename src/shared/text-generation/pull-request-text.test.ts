import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildPullRequestTextPrompt,
  followsConventionalCommits,
  MAX_PULL_REQUEST_PATCH_CHARS,
  readPullRequestTextOutput,
} from './pull-request-text'

test('a repository follows Conventional Commits when most of its recent subjects do', () => {
  const conventional = Array.from({ length: 12 }, (_, i) => `fix(scope${i}): do thing ${i}`)
  assert.equal(followsConventionalCommits(conventional), true)
  assert.equal(followsConventionalCommits([...conventional, 'Merge branch main']), true, 'merges aside')
  assert.equal(followsConventionalCommits(conventional.slice(0, 5)), false, 'too few to say')
  assert.equal(followsConventionalCommits(conventional.map((subject, i) => (i % 2 ? 'Update stuff' : subject))), false)
})

test('the prompt carries the convention, the template and the diff, each cut to size', () => {
  const prompt = buildPullRequestTextPrompt({
    base: 'main',
    head: 'feature/marks',
    commits: 'feat: marks',
    diffStat: ' a.ts | 1 +',
    patch: 'x'.repeat(MAX_PULL_REQUEST_PATCH_CHARS + 10),
    template: '### What changed and why',
    conventionalCommits: true,
  })
  assert.match(prompt, /"feature\/marks" into "main"/)
  assert.match(prompt, /Conventional Commits/)
  assert.match(prompt, /follows the repository template/)
  assert.match(prompt, /\[truncated\]/)
  const plain = buildPullRequestTextPrompt({
    base: 'main',
    head: 'x',
    commits: '',
    diffStat: '',
    patch: '',
    template: null,
    conventionalCommits: false,
  })
  assert.doesNotMatch(plain, /Template:/)
  assert.doesNotMatch(plain, /Conventional Commits/)
})

test('a draft is read from structured output or text, and a title is one bounded line', () => {
  assert.deepEqual(readPullRequestTextOutput({ title: '"Fix the marks."', body: ' Body \n' }), {
    title: 'Fix the marks',
    body: 'Body',
  })
  assert.deepEqual(readPullRequestTextOutput('```json\n{"title":"Fix it","body":"b"}\n```'), {
    title: 'Fix it',
    body: 'b',
  })
  assert.equal(readPullRequestTextOutput({ title: '', body: 'b' }), null)
  assert.equal(readPullRequestTextOutput('no json here'), null)
  assert.equal(readPullRequestTextOutput({ title: 'マークを表示する', body: '' })?.title, 'マークを表示する')
  assert.equal(readPullRequestTextOutput({ title: '1234 --- 56', body: '' }), null, 'no letters at all')
  assert.equal(readPullRequestTextOutput({ title: '修正', body: '' })?.title, '修正', 'two characters that are words')
  assert.equal(readPullRequestTextOutput({ title: 'ok', body: '' }), null, 'two Latin letters are not')
  assert.equal(readPullRequestTextOutput({ title: 'x'.repeat(500), body: '' })?.title.length, 120)
})
