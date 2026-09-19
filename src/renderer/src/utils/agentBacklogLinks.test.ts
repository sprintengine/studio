import assert from 'node:assert/strict'

import type { BacklogItem } from './backlog'
import {
  AGENT_TERMINAL_TARGET_KIND,
  agentLinkForItem,
  agentNameFromLink,
  buildAgentBacklogLink,
  encodeAgentLinkTargetId,
  hasAgentLink,
  openAgentBacklogLink,
  parseAgentLinkTargetId,
  resolveAgentBacklogLink,
  WORKING_AGENT_LINK_ID,
  type AgentBacklogLinkOpenPorts,
} from './agentBacklogLinks'
import { nextBacklogItemStatusFromLinks } from './backlogLinks'
import { findWorkspaceForAgentPreferring, findWorkspaceIdForAgent } from './agentLocation'
import type { Workspace } from '../types/workspace'
import { test } from 'vitest'

test('agentBacklogLinks', async () => {
  const workspaceRoot = '/repo'

  const baseItem: BacklogItem = {
    id: 'backlog/item.md',
    objectId: 'backlog_item',
    path: '/repo/backlog/item.md',
    relativePath: 'backlog/item.md',
    title: 'Item',
    status: 'in_progress',
    isEpic: false,
    metadata: {},
    links: [],
    excerpt: '',
    modifiedAt: 1,
    createdAtMs: 1,
    size: 1,
    sourceContent: '# Item',
  }

  const agentLink = buildAgentBacklogLink({
    workspaceId: 'ws-1',
    agentId: 'agent-7',
    agentName: 'Fred Walsh',
  })

  function workspaceWithAgent(workspaceId: string, agentId: string): Pick<Workspace, 'id' | 'agents'> {
    return {
      id: workspaceId,
      // Only `agents` membership is read by resolve; a partial stub is enough.
      agents: { [agentId]: {} as Workspace['agents'][string] },
    }
  }

  function recordingPorts(overrides: Partial<AgentBacklogLinkOpenPorts> = {}): {
    ports: AgentBacklogLinkOpenPorts
    calls: { focused: string[]; preferred: Array<string | undefined>; diagnostics: string[] }
  } {
    const calls = {
      focused: [] as string[],
      preferred: [] as Array<string | undefined>,
      diagnostics: [] as string[],
    }
    const ports: AgentBacklogLinkOpenPorts = {
      focusAgent: ({ agentId, preferredWorkspaceId }) => {
        calls.focused.push(agentId)
        calls.preferred.push(preferredWorkspaceId)
        return true
      },
      publishDiagnostic: (input) => {
        calls.diagnostics.push(input.message)
      },
      ...overrides,
    }
    return { ports, calls }
  }

  async function main(): Promise<void> {
    // --- composite id encode/parse ---
    assert.equal(encodeAgentLinkTargetId('ws-1', 'agent-7'), 'ws-1/agent-7')
    assert.deepEqual(parseAgentLinkTargetId('ws-1/agent-7'), { workspaceId: 'ws-1', agentId: 'agent-7' })
    assert.equal(parseAgentLinkTargetId('no-separator'), null)
    assert.equal(parseAgentLinkTargetId('/leading'), null)
    assert.equal(parseAgentLinkTargetId('trailing/'), null)
    assert.equal(parseAgentLinkTargetId('a/b/c'), null, 'extra separators are rejected, not silently truncated')

    // --- link shape + lookups ---
    assert.equal(agentLink.id, WORKING_AGENT_LINK_ID)
    assert.equal(agentLink.type, 'agent')
    assert.equal(agentLink.target.kind, AGENT_TERMINAL_TARGET_KIND)
    assert.equal(agentLink.label, 'Agent: Fred Walsh')
    assert.equal(agentNameFromLink(agentLink), 'Fred Walsh')
    assert.equal(hasAgentLink({ links: [agentLink] }), true)
    assert.equal(hasAgentLink({ links: [] }), false)
    assert.equal(agentLinkForItem({ links: [agentLink] })?.target.id, 'ws-1/agent-7')

    // --- the safety property: an agent link NEVER moves item status ---
    const activeAgentLink = { ...agentLink, status: 'active' as const, canOpen: true }
    assert.equal(
      nextBacklogItemStatusFromLinks('completed', [activeAgentLink]),
      'completed',
      'a live agent link must not flip a completed item back to in_progress',
    )
    assert.equal(
      nextBacklogItemStatusFromLinks('idea', [activeAgentLink]),
      'idea',
      'an agent link is lifecycle-neutral; only execution links drive status',
    )

    // --- findWorkspaceIdForAgent: the live lookup ---
    assert.equal(findWorkspaceIdForAgent([workspaceWithAgent('ws-1', 'agent-7')], 'agent-7'), 'ws-1')
    assert.equal(findWorkspaceIdForAgent([], 'agent-7'), null)

    // --- findWorkspaceForAgentPreferring: shared-id disambiguation (the agent-1 bug) ---
    // Two workspaces both host `agent-1`; the recorded workspace must win over the
    // first-match scan so a Backlog link never lands on an unrelated workspace's
    // `agent-1`.
    const sharedIdWorkspaces = [workspaceWithAgent('ws-other', 'agent-1'), workspaceWithAgent('ws-recorded', 'agent-1')]
    assert.equal(
      findWorkspaceForAgentPreferring(sharedIdWorkspaces, 'agent-1', 'ws-recorded')?.id,
      'ws-recorded',
      'the recorded workspace disambiguates a shared agent id',
    )
    // Moved agent: recorded workspace no longer hosts the id, so the scan follows it.
    assert.equal(
      findWorkspaceForAgentPreferring([workspaceWithAgent('ws-2', 'agent-7')], 'agent-7', 'ws-1')?.id,
      'ws-2',
      'a moved agent still self-heals via the scan fallback',
    )
    // No preference given: falls back to the plain first-match scan.
    assert.equal(findWorkspaceForAgentPreferring(sharedIdWorkspaces, 'agent-1', undefined)?.id, 'ws-other')
    // Recorded workspace is open but no longer hosts the id, and the agent is gone:
    // returns null rather than forcing the wrong workspace.
    assert.equal(findWorkspaceForAgentPreferring([workspaceWithAgent('ws-1', 'someone-else')], 'agent-7', 'ws-1'), null)

    // --- resolve: resolvable ---
    const resolvable = resolveAgentBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: { ...baseItem, links: [agentLink] },
      link: agentLink,
      workspaces: [workspaceWithAgent('ws-1', 'agent-7')],
    })
    assert.equal(resolvable.status, 'active')
    assert.equal(resolvable.canOpen, true)

    // --- resolve: agent moved to a DIFFERENT workspace than the link encodes ---
    // The link target is 'ws-1/agent-7' but the agent now lives in 'ws-2'; it must
    // still resolve active (the move-robustness fix).
    const moved = resolveAgentBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: agentLink,
      workspaces: [workspaceWithAgent('ws-2', 'agent-7')],
    })
    assert.equal(moved.status, 'active', 'a moved agent self-heals via the live lookup')
    assert.equal(moved.canOpen, true)

    // --- resolve: agent not open anywhere ---
    const noAgent = resolveAgentBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: agentLink,
      workspaces: [workspaceWithAgent('ws-1', 'someone-else')],
    })
    assert.equal(noAgent.status, 'unknown')
    assert.equal(noAgent.canOpen, false)
    assert.match(noAgent.unavailableReason ?? '', /no longer open/)

    // --- resolve: malformed target ---
    const malformed = resolveAgentBacklogLink({
      workspaceId: 'ws-backlog',
      workspaceRoot,
      item: baseItem,
      link: { ...agentLink, target: { ...agentLink.target, id: 'broken' } },
      workspaces: [workspaceWithAgent('ws-1', 'agent-7')],
    })
    assert.equal(malformed.status, 'unknown')
    assert.match(malformed.unavailableReason ?? '', /malformed/)

    // --- open: success focuses the agent by id (workspace resolved by the port) ---
    const ok = recordingPorts()
    assert.equal(
      await openAgentBacklogLink({
        workspaceId: 'ws-backlog',
        workspaceRoot,
        item: baseItem,
        link: agentLink,
        ports: ok.ports,
      }),
      true,
    )
    assert.deepEqual(ok.calls.focused, ['agent-7'])
    assert.deepEqual(
      ok.calls.preferred,
      ['ws-1'],
      'open threads the link-recorded workspace so the port can disambiguate a shared id',
    )
    assert.deepEqual(ok.calls.diagnostics, [])

    // --- open: malformed target never focuses, surfaces a diagnostic ---
    const bad = recordingPorts()
    assert.equal(
      await openAgentBacklogLink({
        workspaceId: 'ws-backlog',
        workspaceRoot,
        item: baseItem,
        link: { ...agentLink, target: { ...agentLink.target, id: 'broken' } },
        ports: bad.ports,
      }),
      false,
    )
    assert.deepEqual(bad.calls.focused, [], 'no focus attempt on a malformed link')
    assert.equal(bad.calls.diagnostics.length, 1)

    // --- open: unreachable agent (not open anywhere) surfaces a diagnostic ---
    const unreachable = recordingPorts({ focusAgent: () => false })
    assert.equal(
      await openAgentBacklogLink({
        workspaceId: 'ws-backlog',
        workspaceRoot,
        item: baseItem,
        link: agentLink,
        ports: unreachable.ports,
      }),
      false,
    )
    assert.equal(unreachable.calls.diagnostics.length, 1)
    assert.match(unreachable.calls.diagnostics[0], /Could not open the agent terminal/)

    console.log('agentBacklogLinks.test.ts passed')
  }

  const suiteRun = main().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})
