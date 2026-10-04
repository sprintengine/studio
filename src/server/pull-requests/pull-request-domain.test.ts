import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'vitest'

import type { PullRequestStateRead } from '../../main/github/branch-pull-request'
import type { ConversationEvent, ConversationToolDetailResult } from '../../shared/conversation-runtime'
import { createPullRequestDomain, type PullRequestsChanged } from './pull-request-domain'
import { createPullRequestRecord, type PullRequestCheckout } from './pull-request-record'

// The domain hears that a conversation opened a pull request: from a chat's
// stream, from a terminal agent's forwarded call, and from the gateway's link
// tool. `gh` and git are injected.

const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const CHAT = { workspaceId: 'ws-1', agentId: 'agent-1' }
const PR_12 = 'https://github.com/acme/app/pull/12'

const GH_PR_CREATE_OUTPUT =
  '\nCreating pull request for feature/marks into main in acme/app\n\nhttps://github.com/acme/app/pull/12\n'

function read(headRefName = 'feature/marks'): PullRequestStateRead {
  return { settled: true, state: 'open', isDraft: false, stateAt: NOW, headRefName, title: 'Marks', number: 12 }
}

async function domainOver(options: { checkouts?: Record<string, PullRequestCheckout>; detail?: string } = {}) {
  const listeners: Array<(event: ConversationEvent) => void> = []
  const changes: PullRequestsChanged[] = []
  const detailReads: string[] = []
  const userDataDir = await mkdtemp(join(tmpdir(), 'sprintengine-pr-domain-'))
  const record = createPullRequestRecord({
    userDataDir,
    reads: { readPullRequestState: async () => read() },
    now: () => NOW,
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
    onRecordChanged: (change) => changes.push(change),
    logWarning: () => undefined,
  })
  const domain = createPullRequestDomain({
    dataDir: userDataDir,
    record,
    conversations: {
      onEvent: (listener) => {
        listeners.push(listener)
        return () => undefined
      },
      sessionWorkspaceRoot: () => '/repo',
      getToolDetail: async (input): Promise<ConversationToolDetailResult> => {
        detailReads.push(input.toolUseId)
        return options.detail === undefined
          ? { ok: false, code: 'not_found', message: 'gone' }
          : { ok: true, detail: { input: {}, output: options.detail, status: 'ok', clipped: false } }
      },
    },
    workspaceFolder: () => '/repo',
    resolveCheckout: async (path) => options.checkouts?.[path] ?? null,
    log: () => undefined,
  })
  domain.onChanged((change) => changes.push(change))
  let seq = 0
  const emit = (event: Partial<ConversationEvent> & Pick<ConversationEvent, 'type'>) => {
    for (const listener of listeners)
      listener({
        id: `e${(seq += 1)}`,
        sessionId: 'chat-session',
        workspaceId: CHAT.workspaceId,
        agentId: CHAT.agentId,
        providerId: 'p',
        modelId: 'm',
        createdAt: NOW,
        ...event,
      })
  }
  /** One tool call: its start, then its final output. */
  const call = (toolUseId: string, name: string, input: unknown, output: Record<string, unknown>) => {
    emit({ type: 'tool_started', payload: { toolUseId, name, input } })
    emit({ type: 'tool_output', payload: { toolUseId, status: 'ok', ...output } })
  }
  const settled = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    await record.flush()
  }
  return { domain, record, emit, call, settled, changes, detailReads }
}

test('a chat that runs `gh pr create` owns the pull request it printed', async () => {
  const { domain, record, call, settled } = await domainOver()
  call('t1', 'Bash', { command: 'git push -u origin HEAD && gh pr create --fill' }, { output: GH_PR_CREATE_OUTPUT })
  await settled()
  assert.deepEqual(
    record.forConversation(CHAT).map((entry) => entry.url),
    [PR_12],
  )
  const listed = await domain.list({ conversations: [CHAT], workspaceIds: ['ws-1'] })
  assert.equal(listed.conversations[0].pullRequests[0].url, PR_12)
  assert.equal('openedByWorkspaceId' in listed.conversations[0].pullRequests[0], false, 'the wire names no owner')
  assert.equal(listed.workspaces['ws-1'].length, 1)
  domain.dispose()
})

test('a URL a chat merely saw is not a pull request it opened', async () => {
  const { record, call, emit, settled } = await domainOver()
  // Listing and viewing print the URLs of pull requests somebody else opened.
  call('t1', 'Bash', { command: 'gh pr list --state all' }, { output: `12  Marks  ${PR_12}` })
  call('t2', 'Bash', { command: 'gh pr view 12' }, { output: PR_12 })
  // A push names the "create one" page, and on GitLab an existing merge request.
  call(
    't3',
    'Bash',
    { command: 'git push origin feature/marks' },
    {
      output: 'remote: View merge request for feature/marks:\nremote:   https://gitlab.com/acme/app/-/merge_requests/4',
    },
  )
  // The URL is in the input, not the output.
  call('t4', 'Bash', { command: `gh pr create --body "follows ${PR_12}"` }, { output: 'aborted' })
  // A second agent on the branch: it exists, and this one did not open it.
  call(
    't5',
    'Bash',
    { command: 'gh pr create --fill' },
    { output: `a pull request for branch "feature/marks" into branch "main" already exists:\n${PR_12}` },
  )
  // A failed call opened nothing.
  emit({ type: 'tool_started', payload: { toolUseId: 't6', name: 'Bash', input: { command: 'gh pr create' } } })
  emit({ type: 'tool_output', payload: { toolUseId: 't6', status: 'error', output: PR_12 } })
  // A partial output is not the call's result.
  emit({ type: 'tool_started', payload: { toolUseId: 't7', name: 'Bash', input: { command: 'gh pr create' } } })
  emit({ type: 'tool_output', payload: { toolUseId: 't7', partial: true, output: PR_12 } })
  await settled()
  assert.deepEqual(record.forConversation(CHAT), [])
})

test('an MCP server’s create tool counts, on any forge', async () => {
  const { record, call, settled } = await domainOver()
  call(
    'm1',
    'mcp__github__create_pull_request',
    { owner: 'acme', repo: 'app', title: 'Marks', head: 'feature/marks', base: 'main' },
    {
      output: JSON.stringify({
        url: 'https://api.github.com/repos/acme/app/pulls/12',
        html_url: PR_12,
        number: 12,
      }),
    },
  )
  call(
    'm2',
    'mcp__gitlab__create_merge_request',
    {},
    { output: '{"iid":5,"web_url":"https://gitlab.com/acme/app/-/merge_requests/5"}' },
  )
  await settled()
  const urls = record
    .forConversation(CHAT)
    .map((entry) => entry.url)
    .sort()
  assert.deepEqual(urls, ['https://github.com/acme/app/pull/12', 'https://gitlab.com/acme/app/-/merge_requests/5'])
})

test('a long output is read whole from the tool’s detail', async () => {
  const noise = 'remote: Counting objects\n'.repeat(400)
  const { record, call, settled, detailReads } = await domainOver({ detail: `${noise}${GH_PR_CREATE_OUTPUT}` })
  call('t1', 'Bash', { command: 'gh pr create --fill' }, { output: noise.slice(0, 4000), truncated: true })
  await settled()
  assert.deepEqual(detailReads, ['t1'])
  assert.equal(record.forConversation(CHAT)[0]?.url, PR_12)
})

test('a chat’s turn end notes the checkout it is in, and adds no pull request', async () => {
  const { record, emit, settled } = await domainOver({
    checkouts: { '/repo': { gitRoot: '/repo', branch: 'feature/marks' } },
  })
  emit({ type: 'turn_completed' })
  await settled()
  assert.deepEqual(record.homeOf(CHAT), { gitRoot: '/repo', branch: 'feature/marks' })
  assert.deepEqual(record.forConversation(CHAT), [])
})

test('a terminal agent’s forwarded call is read like a chat’s', async () => {
  const { domain, record, settled } = await domainOver()
  await domain.noteToolCall({
    conversation: CHAT,
    toolCall: { name: 'Bash', command: 'gh pr list', output: PR_12 },
  })
  assert.deepEqual(record.forConversation(CHAT), [])
  await domain.noteToolCall({
    conversation: CHAT,
    toolCall: { name: 'Bash', command: 'gh pr create --fill', output: GH_PR_CREATE_OUTPUT },
  })
  await domain.noteWork({
    conversation: CHAT,
    checkout: { gitRoot: '/repo', branch: 'feature/marks' },
    // From an older client: no longer read.
    changedPaths: ['/elsewhere/file.ts'],
    turnEnded: true,
  })
  await settled()
  const [entry] = record.forConversation(CHAT)
  assert.equal(entry.url, PR_12)
  assert.equal(entry.onSessionBranch, true)
  const listed = await domain.list({ conversations: [CHAT] })
  assert.equal(listed.conversations[0].pullRequests[0].onConversationBranch, true)
})

test('the link tool records under the calling conversation, first come first kept', async () => {
  const { domain, record, settled } = await domainOver()
  const linked = await domain.link(CHAT, { url: 'https://codeberg.org/acme/app/pulls/3', title: 'Port it' })
  assert.equal(linked.ok, true)
  const taken = await domain.link(
    { workspaceId: 'ws-2', agentId: 'agent-2' },
    { url: 'https://codeberg.org/acme/app/pulls/3' },
  )
  assert.equal(!taken.ok && taken.code, 'opened_by_another_conversation')
  await settled()
  const listed = await domain.list({ conversations: [CHAT] })
  assert.equal(listed.conversations[0].pullRequests[0].forge, 'gitea')
  assert.equal(record.forConversation({ workspaceId: 'ws-2', agentId: 'agent-2' }).length, 0)
})
