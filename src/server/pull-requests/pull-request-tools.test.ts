import assert from 'node:assert/strict'

import { test } from 'vitest'

import type { McpConnectionContext } from '../../shared/modules/mcp-tools'
import { localOnlyGatewayToolReason } from '../../main/automation/tailnet/tailnet-scopes'
import type { NoteOpenedOutcome, PullRequestConversationKey } from './pull-request-record'
import { createPullRequestTools, PULL_REQUEST_LINK_TOOL } from './pull-request-tools'

const AGENT: McpConnectionContext = {
  metadata: { kind: 'studio-agent', workspaceId: 'ws-1', agentId: 'agent-1', cliId: 'claude-code' },
}

function toolOver(answer: (key: PullRequestConversationKey, url: string) => NoteOpenedOutcome) {
  const calls: Array<{ key: PullRequestConversationKey; input: { url: string; title?: string } }> = []
  const [tool] = createPullRequestTools({
    link: async (key, input) => {
      calls.push({ key, input })
      return answer(key, input.url)
    },
  })
  return { tool, calls }
}

const linked = (url: string, recorded = true): NoteOpenedOutcome => ({
  ok: true,
  recorded,
  pullRequest: {
    url,
    repoKey: 'gitlab.com/acme/app',
    repoName: 'app',
    number: 4,
    title: '',
    state: 'open',
    isDraft: false,
    openedAt: 1,
    stateAt: 0,
    forge: 'gitlab',
  },
})

test('pull_request.link records under the calling agent, never under what it was told', async () => {
  const { tool, calls } = toolOver((_key, url) => linked(url))
  assert.equal(tool.name, PULL_REQUEST_LINK_TOOL)
  assert.equal(tool.mutates, true, 'it writes the record, so it is audited')
  const result = await tool.handler(
    {
      url: ' https://gitlab.com/acme/app/-/merge_requests/4 ',
      title: 'Marks',
    },
    AGENT,
  )
  assert.equal(result.isError, undefined)
  assert.deepEqual(calls, [
    {
      key: { workspaceId: 'ws-1', agentId: 'agent-1' },
      input: { url: 'https://gitlab.com/acme/app/-/merge_requests/4', title: 'Marks' },
    },
  ])
  assert.deepEqual(result.structuredContent, {
    linked: true,
    alreadyLinked: false,
    pullRequest: {
      url: 'https://gitlab.com/acme/app/-/merge_requests/4',
      number: 4,
      repository: 'gitlab.com/acme/app',
      forge: 'gitlab',
    },
  })
  // The schema takes no conversation: there is nothing to claim another's with.
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ['title', 'url'])
})

test('pull_request.link refuses whatever is not an agent, and passes the record’s refusals on', async () => {
  const { tool, calls } = toolOver(() => ({
    ok: false,
    code: 'opened_by_another_conversation',
    message: 'Another conversation opened that pull request.',
  }))
  for (const context of [
    undefined,
    { metadata: { kind: 'external-local' as const } },
    { metadata: { kind: 'remote-tailnet' as const, deviceId: 'dev-1', deviceName: 'android-phone' } },
    { metadata: { kind: 'studio-agent' as const, workspaceId: 'ws-1' } },
  ]) {
    const refused = await tool.handler({ url: 'https://github.com/acme/app/pull/1' }, context)
    assert.equal(refused.isError, true)
    assert.equal((refused.structuredContent?.error as { code: string }).code, 'not_a_conversation')
  }
  assert.equal(calls.length, 0)
  const missing = await tool.handler({}, AGENT)
  assert.equal((missing.structuredContent?.error as { code: string }).code, 'invalid_arguments')
  const taken = await tool.handler({ url: 'https://github.com/acme/app/pull/1' }, AGENT)
  assert.equal((taken.structuredContent?.error as { code: string }).code, 'opened_by_another_conversation')
  // A paired device is not an agent: the tool is never served over the tailnet.
  assert.notEqual(localOnlyGatewayToolReason(PULL_REQUEST_LINK_TOOL), null)
})
