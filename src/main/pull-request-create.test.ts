import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { test } from 'vitest'

import type { BranchPullRequestsRead } from './github/branch-pull-request'
import type { GhRunner } from './github/gh'
import { createPullRequestCreator } from './pull-request-create'

// The chat's "Create PR" against real git: a bare "origin" and a clone of it.
// `gh` and the branch lookup are stand-ins, so nothing reaches GitHub.

const exec = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Dev',
      GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'Dev',
      GIT_COMMITTER_EMAIL: 'dev@example.com',
    },
  })
  return stdout.trim()
}

async function commit(cwd: string, file: string, text: string, message: string): Promise<void> {
  await writeFile(path.join(cwd, file), text)
  await git(cwd, 'add', file)
  await git(cwd, 'commit', '-q', '-m', message)
}

/** A clone of a bare origin, `main` pushed, `origin/HEAD` recorded, on a feature branch with one commit. */
async function checkout(): Promise<{ clone: string; origin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'sprintengine-pr-create-'))
  const origin = path.join(root, 'origin.git')
  const clone = path.join(root, 'app')
  await exec('git', ['init', '-q', '--bare', '-b', 'main', origin])
  await exec('git', ['init', '-q', '-b', 'main', clone])
  await git(clone, 'remote', 'add', 'origin', origin)
  await commit(clone, 'README.md', 'app\n', 'chore: start')
  await git(clone, 'push', '-q', '-u', 'origin', 'main')
  await git(clone, 'remote', 'set-head', 'origin', 'main')
  await git(clone, 'checkout', '-q', '-b', 'feature/marks')
  await commit(clone, 'marks.ts', 'export const marks = 1\n', 'feat: marks')
  // The remote reads as GitHub; pushes still go to the bare repository.
  await git(clone, 'remote', 'set-url', 'origin', 'git@github.com:acme/app.git')
  await git(clone, 'remote', 'set-url', '--push', 'origin', origin)
  return { clone, origin }
}

function lookupOf(read: BranchPullRequestsRead) {
  const asked: string[] = []
  return {
    asked,
    listBranch: async (input: { gitRoot: string; branch: string }) => {
      asked.push(input.branch)
      return read
    },
  }
}

const NONE: BranchPullRequestsRead = { settled: true, pullRequests: [] }

test('a branch with committed, unproposed work is ready; uncommitted work and an open pull request are not', async () => {
  const { clone } = await checkout()
  const lookup = lookupOf(NONE)
  const creator = createPullRequestCreator({ listBranch: lookup.listBranch })
  const state = await creator.state(clone)
  assert.deepEqual(state.readiness, { ready: true })
  assert.equal(state.branch, 'feature/marks')
  assert.equal(state.base, 'main')
  assert.equal(state.forge, 'github')

  await writeFile(path.join(clone, 'scratch.txt'), 'wip\n')
  assert.deepEqual((await creator.state(clone)).readiness, { ready: false, reason: 'uncommitted' }, 'untracked counts')
  await exec('rm', [path.join(clone, 'scratch.txt')])

  const open = createPullRequestCreator({
    listBranch: lookupOf({
      settled: true,
      pullRequests: [
        {
          url: 'https://github.com/acme/app/pull/3',
          repoKey: 'github.com/acme/app',
          repoName: 'app',
          number: 3,
          title: 'Someone else’s',
          state: 'open',
          isDraft: false,
          openedAt: 1,
          stateAt: 1,
        },
      ],
    }).listBranch,
  })
  assert.deepEqual((await open.state(clone)).readiness, { ready: false, reason: 'open-pull-request' })

  await git(clone, 'checkout', '-q', 'main')
  assert.deepEqual((await creator.state(clone)).readiness, { ready: false, reason: 'default-branch' })
})

test('a merged pull request carried the commits until new ones come', async () => {
  const { clone } = await checkout()
  const head = await git(clone, 'rev-parse', 'HEAD')
  const merged: BranchPullRequestsRead = {
    settled: true,
    pullRequests: [
      {
        url: 'https://github.com/acme/app/pull/2',
        repoKey: 'github.com/acme/app',
        repoName: 'app',
        number: 2,
        title: 'Marks',
        state: 'merged',
        isDraft: false,
        openedAt: 1,
        stateAt: 1,
        headRefOid: head,
      },
    ],
  }
  const creator = createPullRequestCreator({
    listBranch: lookupOf(merged).listBranch,
    now: (() => {
      let at = 0
      return () => (at += 60_000)
    })(),
  })
  assert.deepEqual((await creator.state(clone)).readiness, { ready: false, reason: 'nothing-to-propose' })
  await commit(clone, 'more.ts', 'export const more = 2\n', 'feat: more marks')
  assert.deepEqual((await creator.state(clone)).readiness, { ready: true })
})

test('the push sets an upstream the first time, then pushes only what the remote lacks', async () => {
  const { clone, origin } = await checkout()
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: true })
  assert.equal(await git(origin, 'rev-parse', 'refs/heads/feature/marks'), await git(clone, 'rev-parse', 'HEAD'))
  assert.equal(await git(clone, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/feature/marks')
  assert.deepEqual(await creator.push(clone), { ok: true, pushed: false })
})

test('GitHub: gh creates it with the body from a file, and an existing one is taken rather than failed', async () => {
  const { clone } = await checkout()
  const calls: Array<{ args: string[]; body: string }> = []
  let answer = { found: true, code: 0, stdout: 'https://github.com/acme/app/pull/12\n', stderr: '' }
  const gh: GhRunner = {
    available: async () => true,
    run: async (args) => {
      calls.push({ args, body: await readFile(args[args.indexOf('--body-file') + 1], 'utf8') })
      return answer
    },
  }
  const creator = createPullRequestCreator({ gh, listBranch: lookupOf(NONE).listBranch })
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '## Why\n\nMarks.' }), {
    ok: true,
    kind: 'created',
    url: 'https://github.com/acme/app/pull/12',
  })
  assert.deepEqual(calls[0].args.slice(0, 8), [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'feature/marks',
    '--title',
    'feat: marks',
  ])
  assert.equal(calls[0].body, '## Why\n\nMarks.')

  answer = {
    found: true,
    code: 1,
    stdout: '',
    stderr:
      'a pull request for branch "feature/marks" into branch "main" already exists:\nhttps://github.com/acme/app/pull/12\n',
  }
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '' }), {
    ok: true,
    kind: 'existing',
    url: 'https://github.com/acme/app/pull/12',
  })

  answer = { found: true, code: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }
  const signedOut = await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.equal(signedOut.ok, false)
  assert.match(!signedOut.ok ? signedOut.message : '', /gh auth login/)

  answer = { found: false, code: -1, stdout: '', stderr: '' }
  const missing = await creator.create(clone, { title: 'feat: marks', body: '' })
  assert.match(!missing.ok ? missing.message : '', /not installed/)
})

test('another forge opens its own prefilled page instead', async () => {
  const { clone } = await checkout()
  await git(clone, 'remote', 'set-url', 'origin', 'git@gitlab.com:acme/app.git')
  const creator = createPullRequestCreator({
    gh: { available: async () => true, run: async () => assert.fail('gh is GitHub only') },
    listBranch: async () => assert.fail('the lookup is GitHub only'),
  })
  assert.deepEqual((await creator.state(clone)).readiness, { ready: true })
  assert.deepEqual(await creator.create(clone, { title: 'feat: marks', body: '' }), {
    ok: true,
    kind: 'page',
    url: 'https://gitlab.com/acme/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fmarks&merge_request%5Btarget_branch%5D=main',
  })
})

test('a draft is written from the branch’s own commits and diff, its template and its convention', async () => {
  const { clone } = await checkout()
  await exec('mkdir', ['-p', path.join(clone, '.github')])
  await writeFile(
    path.join(clone, '.github', 'pull_request_template.md'),
    '<!-- say why -->\n### What changed and why\n',
  )
  await git(clone, 'add', '.github')
  await git(clone, 'commit', '-q', '-m', 'chore: template')
  const creator = createPullRequestCreator({ listBranch: lookupOf(NONE).listBranch })
  const draft = await creator.draftInput(clone)
  assert.ok(draft.ok)
  assert.equal(draft.input.base, 'main')
  assert.equal(draft.input.head, 'feature/marks')
  assert.match(draft.input.commits, /feat: marks/)
  assert.doesNotMatch(draft.input.commits, /chore: start/, 'only the branch’s own commits')
  assert.match(draft.input.patch, /export const marks = 1/)
  assert.equal(draft.input.template, '### What changed and why', 'comments are left out')
  assert.equal(draft.input.conventionalCommits, false, 'one commit on main says nothing about a convention')
})
