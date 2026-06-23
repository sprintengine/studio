import assert from 'node:assert/strict'

import { openAutomationRunPullRequest, type CommandResult, type PullRequestDeps } from './pull-request'

function okResult(stdout = ''): CommandResult {
  return { ok: true, stdout, stderr: '' }
}

function failResult(stderr: string): CommandResult {
  return { ok: false, stdout: '', stderr }
}

type RecordedCall = { tool: 'git' | 'gh'; args: string[] }

function recordingDeps(
  responder: (call: RecordedCall) => CommandResult,
): { deps: PullRequestDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const deps: PullRequestDeps = {
    runGit: async (_cwd, args) => {
      const call = { tool: 'git' as const, args }
      calls.push(call)
      return responder(call)
    },
    runGh: async (_cwd, args) => {
      const call = { tool: 'gh' as const, args }
      calls.push(call)
      return responder(call)
    },
  }
  return { deps, calls }
}

async function assertCommitsPushesAndCreatesPr(): Promise<void> {
  const { deps, calls } = recordingDeps((call) => {
    if (call.tool === 'git' && call.args[0] === 'status') return okResult(' M file.ts\n')
    if (call.tool === 'gh' && call.args[1] === 'view') return failResult('no pull requests found')
    if (call.tool === 'gh' && call.args[1] === 'create') return okResult('https://github.com/acme/repo/pull/7\n')
    return okResult()
  })

  const result = await openAutomationRunPullRequest(
    { worktreePath: '/wt', branch: 'automations/run-1', title: 'Automation: Nightly', body: 'body', autonomy: 'allow_changes' },
    deps,
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.url, 'https://github.com/acme/repo/pull/7')
  assert.equal(result.created, true)
  // Dirty worktree is backstop-committed before push.
  assert.ok(calls.some((c) => c.tool === 'git' && c.args[0] === 'add'))
  assert.ok(calls.some((c) => c.tool === 'git' && c.args[0] === 'commit'))
  assert.ok(calls.some((c) => c.tool === 'git' && c.args[0] === 'push'))
}

async function assertReusesExistingPr(): Promise<void> {
  const { deps, calls } = recordingDeps((call) => {
    if (call.tool === 'git' && call.args[0] === 'status') return okResult('') // clean
    if (call.tool === 'gh' && call.args[1] === 'view') return okResult('https://github.com/acme/repo/pull/3\n')
    return okResult()
  })

  const result = await openAutomationRunPullRequest(
    { worktreePath: '/wt', branch: 'automations/run-1', title: 't', body: 'b', autonomy: 'allow_changes' },
    deps,
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.url, 'https://github.com/acme/repo/pull/3')
  assert.equal(result.created, false)
  // Clean worktree: no commit; existing PR: no create.
  assert.ok(!calls.some((c) => c.tool === 'git' && c.args[0] === 'commit'))
  assert.ok(!calls.some((c) => c.tool === 'gh' && c.args[1] === 'create'))
}

async function assertPushFailureReturnsReasonNotFakeSuccess(): Promise<void> {
  const { deps } = recordingDeps((call) => {
    if (call.tool === 'git' && call.args[0] === 'status') return okResult('')
    if (call.tool === 'git' && call.args[0] === 'push') return failResult('fatal: No configured push destination.')
    return okResult()
  })

  const result = await openAutomationRunPullRequest(
    { worktreePath: '/wt', branch: 'automations/run-1', title: 't', body: 'b', autonomy: 'allow_changes' },
    deps,
  )

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /push the run branch/)
  assert.match(result.reason, /No configured push destination/)
}

async function assertGhCreateFailureReturnsReason(): Promise<void> {
  const { deps } = recordingDeps((call) => {
    if (call.tool === 'git' && call.args[0] === 'status') return okResult('')
    if (call.tool === 'gh' && call.args[1] === 'view') return failResult('no pull requests found')
    if (call.tool === 'gh' && call.args[1] === 'create') return failResult('GraphQL: No commits between main and automations/run-1')
    return okResult()
  })

  const result = await openAutomationRunPullRequest(
    { worktreePath: '/wt', branch: 'automations/run-1', title: 't', body: 'b', autonomy: 'allow_changes' },
    deps,
  )

  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.reason, /open a pull request/)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

async function main(): Promise<void> {
  await assertCommitsPushesAndCreatesPr()
  await assertReusesExistingPr()
  await assertPushFailureReturnsReasonNotFakeSuccess()
  await assertGhCreateFailureReturnsReason()
  console.log('automations pull-request tests passed')
}
