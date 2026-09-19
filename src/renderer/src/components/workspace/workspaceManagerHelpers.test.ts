import assert from 'node:assert/strict'
import type {
  AgentState,
  MulticodeAuthState,
  SessionActivity,
  TerminalSessionSnapshot,
} from '../../../../shared/electron-api'
import type { ConversationSessionSummary } from '../../../../shared/conversation-runtime'
import type { Workspace } from '../../types/workspace'
import {
  buildSidebarWorkspaceOrder,
  compareSessionItemsByAttention,
  deriveSessionStatus,
  getSessionItems,
  groupSessionItems,
  sessionsAttentionTone,
} from './workspaceManagerHelpers'
import type { SessionItem } from './WorkspaceActions'
import { hasPaidEntitlement, planDisplayTier } from './accountEntitlements'
import { test } from 'vitest'

test('workspaceManagerHelpers', async () => {
  void main()

  function main(): void {
    assertHookPhaseDrivesStatus()
    assertOutputRecencyFallback()
    assertFailedRetentionAndPrecedence()

    assertLastActivityIsMaxOfOutputAndInput()
    assertAttentionFirstOrdering()
    assertAttentionToneNeverLies()
    assertConversationSessionsSurfaceInSessionItems()
    assertAgentlessPtySessionsSurfaceWithHumanLabel()
    assertWorkspacelessSessionsStillSurface()
    assertDetachedBucketsTrailRealWorkspaces()
    assertSidebarOrderGroupsWorktreesUnderTheirProject()
    assertPaidAccessIsDecidedByFeatureKeys()
    assertPlanDisplayTierIsPresentationOnly()
    console.log('workspaceManagerHelpers.test.ts: all assertions passed')
  }

  // This dropdown claims to mirror the sidebar, so it groups by the project a
  // workspace files under. A worktree chat belongs inside its parent's group,
  // whether the parent is recorded on the marker or only derivable from the
  // container path — its own folder would open a group named after the slug.
  function assertSidebarOrderGroupsWorktreesUnderTheirProject(): void {
    const ws = (id: string, folderPath: string, repoRoot?: string): Workspace =>
      ({
        id,
        name: id,
        folderPath,
        worktree: folderPath.includes('.multicode-worktrees') ? { branch: `agent/${id}`, repoRoot } : null,
        agents: {},
      }) as unknown as Workspace
    const order = buildSidebarWorkspaceOrder([
      ws('parent', '/repo/a'),
      ws('other-project', '/repo/b'),
      ws('worktree', '/repo/.multicode-worktrees/a/chat-a1b2', '/repo/a'),
      ws('legacy-worktree', '/repo/.multicode-worktrees/a/chat-c3d4'),
    ])
    const at = (id: string): number => order.get(id) ?? -1
    assert.deepEqual(
      [at('parent'), at('worktree'), at('legacy-worktree')].map((index) => index >= 0 && index < 3),
      [true, true, true],
      'both worktree chats sit inside their parent project group, not in groups of their own',
    )
    assert.equal(at('other-project'), 3, 'the next project still trails that whole group')
  }

  // The sessions popover groups by bucket: workspaces in sidebar order, detached
  // buckets after all of them, rows attention-first inside each.
  function assertDetachedBucketsTrailRealWorkspaces(): void {
    const workspaceGroup = (id: string, name: string): SessionItem['group'] => ({
      kind: 'workspace',
      id,
      label: name,
      workspace: { id, name } as unknown as Workspace,
    })
    const notebooks: SessionItem['group'] = { kind: 'detached', id: 'detached:Notebooks', label: 'Notebooks' }
    const other: SessionItem['group'] = { kind: 'detached', id: 'detached:Other sessions', label: 'Other sessions' }
    const rows = [
      { ...item({ status: 'idle', lastActivityAt: 1 }), group: other },
      { ...item({ status: 'working' }), group: workspaceGroup('ws-b', 'Bravo') },
      { ...item({ status: 'needs-input' }), group: notebooks },
      { ...item({ status: 'idle', lastActivityAt: 2 }), group: workspaceGroup('ws-a', 'Alpha') },
      { ...item({ status: 'needs-input' }), group: workspaceGroup('ws-a', 'Alpha') },
    ]
    const grouped = groupSessionItems(
      rows,
      new Map([
        ['ws-a', 0],
        ['ws-b', 1],
      ]),
    )
    assert.deepEqual(
      grouped.map((entry) => entry.group.label),
      ['Alpha', 'Bravo', 'Notebooks', 'Other sessions'],
      'sidebar order for workspaces, detached buckets last and alphabetical',
    )
    assert.deepEqual(
      grouped[0]?.items.map((row) => row.status),
      ['needs-input', 'idle'],
      'rows inside a bucket stay attention-first',
    )
  }

  // The regression this file was missing (MC-1786): a session keyed to an id no
  // workspace row claims — a module's own agent runs under an id of its own —
  // used to be dropped on BOTH branches, so a live agent was invisible in the one
  // surface users audit. Both branches must now yield a row in a labeled detached bucket,
  // with truthful status and its sessionId intact so stop still works.
  function assertWorkspacelessSessionsStillSurface(): void {
    const guideSummary: ConversationSessionSummary = {
      sessionId: 'conv-guide',
      workspaceId: 'notebook-2026-07-22',
      agentId: 'notebook-runner',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'active',
      createdAt: 10,
      updatedAt: 20,
    }
    const orphanPty = {
      sessionId: 'pty-orphan',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-closed',
      agentId: 'agent-1',
      agentName: 'Implementer',
      cli: 'claude-code',
      activity: { kind: 'idle', since: 10 },
      lastOutputAt: 20,
      lastInputAt: null,
      agentState: { phase: 'awaiting_input', since: 30, source: 'hook' },
    } as unknown as TerminalSessionSnapshot

    const items = getSessionItems([], [orphanPty], [guideSummary])
    assert.equal(items.length, 2, 'conversation AND terminal orphans both yield items')

    const conversationItem = items.find((item) => item.sessionId === 'conv-guide')
    assert.ok(conversationItem, 'the workspace-less conversation session surfaces')
    assert.equal(conversationItem?.status, 'working', 'its status is the truthful mapped one')
    assert.equal(conversationItem?.group.kind, 'detached')
    assert.equal(conversationItem?.group.label, 'Other sessions', 'default bucket label')
    // Stop routes by transport: a conversation agent has no PTY, so the row must
    // say so or the session manager kills the wrong runtime and reports success.
    assert.equal(conversationItem?.transport, 'conversation')
    assert.equal(conversationItem?.sessionId, 'conv-guide', 'the runtime session id survives for stop')

    const terminalItem = items.find((item) => item.sessionId === 'pty-orphan')
    assert.ok(terminalItem, 'the workspace-less terminal session surfaces')
    assert.equal(terminalItem?.status, 'needs-input', 'hook phase still drives status without a workspace')
    assert.equal(terminalItem?.label, 'Implementer', 'labels from the snapshot, not the raw id')
    assert.equal(terminalItem?.group.kind, 'detached')
    assert.equal(terminalItem?.transport, 'terminal')

    // Callers name the bucket; unrecognised ids keep the default. Sessions sharing
    // a label share ONE bucket, so N orphans of one namespace are not N groups.
    const labeled = getSessionItems([], [orphanPty], [guideSummary], {
      resolveDetachedLabel: (workspaceId) => (workspaceId.startsWith('notebook-') ? 'Notebooks' : null),
    })
    const labeledGroups = new Map(labeled.map((item) => [item.group.id, item.group.label]))
    assert.deepEqual(
      [...labeledGroups.values()].sort(),
      ['Notebooks', 'Other sessions'],
      'the resolver names the module bucket and leaves the rest generic',
    )

    const twoNotebooks = getSessionItems(
      [],
      [],
      [guideSummary, { ...guideSummary, sessionId: 'conv-guide-2', workspaceId: 'notebook-other' }],
      { resolveDetachedLabel: () => 'Notebooks' },
    )
    assert.equal(new Set(twoNotebooks.map((item) => item.group.id)).size, 1, 'one bucket per label')

    // A live session with no workspaceId at all is still a live session.
    const idlessPty = {
      sessionId: 'pty-idless',
      processAlive: true,
      kind: 'terminal',
      activity: { kind: 'working', since: 5 },
      lastOutputAt: 10,
      lastInputAt: null,
    } as unknown as TerminalSessionSnapshot
    const idless = getSessionItems([], [idlessPty], [])
    assert.equal(idless.length, 1, 'a session with no workspaceId is not filtered out')
    assert.equal(idless[0]?.group.label, 'Other sessions')
  }

  // An agent spawned outside this window carries workspaceId and agentName in the
  // snapshot but has no workspace.agents record. It must surface as a labeled row,
  // and a conversation session for the same agent id must win over a stale PTY
  // twin instead of duplicating the row.
  function assertAgentlessPtySessionsSurfaceWithHumanLabel(): void {
    const workspace = {
      id: 'ws-detached',
      name: 'Detached Agent Host',
      agents: {},
    } as unknown as Workspace
    const agentlessPtySnap = {
      sessionId: 'pty-detached-1',
      processAlive: true,
      kind: 'agent',
      workspaceId: 'ws-detached',
      agentId: 'agent-no-record',
      agentName: 'Design System Designer',
      cli: 'claude-code',
      activity: { kind: 'working', since: 10 },
      lastOutputAt: 20,
      lastInputAt: null,
    } as unknown as TerminalSessionSnapshot

    const items = getSessionItems([workspace], [agentlessPtySnap], [])
    assert.equal(items.length, 1, 'a PTY session with a workspaceId but no AgentState surfaces')
    assert.equal(items[0]?.label, 'Design System Designer', 'labels from snapshot agentName, not the raw agent id')
    assert.equal(items[0]?.status, 'working')
    assert.equal(items[0]?.agentId, 'agent-no-record')

    // Retained crash: the failed row keeps its human label too.
    const failedSnap = {
      ...(agentlessPtySnap as unknown as Record<string, unknown>),
      processAlive: false,
      activity: { kind: 'failed', at: 30, exitCode: 1 },
    } as unknown as TerminalSessionSnapshot
    const failedItems = getSessionItems([workspace], [failedSnap], [])
    assert.equal(failedItems.length, 1, 'the crashed session is retained')
    assert.equal(failedItems[0]?.status, 'failed')
    assert.equal(failedItems[0]?.label, 'Design System Designer')

    // Same agent id on both transports: the conversation row wins, no duplicate.
    const conversationTwin: ConversationSessionSummary = {
      sessionId: 'conv-detached-1',
      workspaceId: 'ws-detached',
      agentId: 'agent-no-record',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'active',
      createdAt: 40,
      updatedAt: 50,
    }
    const merged = getSessionItems([workspace], [agentlessPtySnap], [conversationTwin])
    assert.equal(merged.length, 1, 'stale PTY twin is deduplicated against the conversation session')
    assert.equal(merged[0]?.sessionId, 'conv-detached-1', 'the conversation row is the one kept')
    // A conversation summary carries no agentName, and this agent has no
    // workspace.agents record, so its own id is the honest label.
    assert.equal(merged[0]?.label, 'agent-no-record')
  }

  // Conversation (chat) agents have no PTY snapshot; their runtime summaries
  // must still produce session rows with truthful status mapping.
  function assertConversationSessionsSurfaceInSessionItems(): void {
    const workspace = {
      id: 'ws-1',
      name: 'Workspace One',
      agents: {
        'chat-1': { id: 'chat-1', name: 'Sonnet chat', runtimeKind: 'conversation' },
      },
    } as unknown as Workspace
    const summary = (status: ConversationSessionSummary['status']): ConversationSessionSummary => ({
      sessionId: `conv-${status}`,
      workspaceId: 'ws-1',
      agentId: 'chat-1',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status,
      createdAt: 10,
      updatedAt: 20,
    })

    const awaiting = getSessionItems([workspace], [], [summary('awaiting_approval')])
    assert.equal(awaiting.length, 1)
    assert.equal(awaiting[0]?.status, 'needs-input', 'pending approval/question reads as needs-input')
    assert.equal(awaiting[0]?.agentId, 'chat-1')
    assert.equal(awaiting[0]?.label, 'Sonnet chat')
    assert.equal(awaiting[0]?.cli, 'claude-code', 'claude-agent provider surfaces the Claude icon')

    assert.equal(getSessionItems([workspace], [], [summary('active')])[0]?.status, 'working')
    assert.equal(getSessionItems([workspace], [], [summary('ready')])[0]?.status, 'idle')
    assert.equal(getSessionItems([workspace], [], [summary('failed')])[0]?.status, 'failed')
    assert.equal(getSessionItems([workspace], [], [summary('stopped')]).length, 0, 'stopped sessions drop out')

    // A conversation session with no AgentState entry must stay visible in the
    // session manager; with no name to read, its own agent id is the label.
    const agentlessSummary: ConversationSessionSummary = {
      sessionId: 'conv-agentless',
      workspaceId: 'ws-1',
      agentId: 'conversation-only-agent',
      providerId: 'claude-agent',
      modelId: 'sonnet',
      status: 'awaiting_approval',
      createdAt: 10,
      updatedAt: 20,
    }
    const agentlessItems = getSessionItems([workspace], [], [agentlessSummary])
    assert.equal(agentlessItems.length, 1, 'agent-less conversation session still surfaces')
    assert.equal(agentlessItems[0]?.label, 'conversation-only-agent')
    assert.equal(agentlessItems[0]?.status, 'needs-input')
  }

  function snap(partial: {
    kind?: TerminalSessionSnapshot['kind']
    activity: SessionActivity
    agentState?: AgentState
    lastOutputAt?: number | null
    lastInputAt?: number | null
    processAlive?: boolean
  }): TerminalSessionSnapshot {
    return {
      kind: partial.kind ?? 'agent',
      processAlive: partial.processAlive ?? true,
      activity: partial.activity,
      agentState: partial.agentState,
      lastOutputAt: partial.lastOutputAt ?? null,
      lastInputAt: partial.lastInputAt ?? null,
    } as unknown as TerminalSessionSnapshot
  }

  // The authoritative hook phase wins over output timing, and carries its own
  // `since` and provenance through.
  function assertHookPhaseDrivesStatus(): void {
    const awaiting = deriveSessionStatus(
      snap({
        activity: { kind: 'working', since: 10 },
        agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
      }),
    )
    assert.equal(awaiting.status, 'needs-input')
    assert.equal(awaiting.source, 'hook')
    assert.equal(awaiting.activitySince, 500, 'needs-input since comes from the hook frame')

    // A dead agent's stale awaiting_input is not a live attention request: the hook
    // disjunct is gated on processAlive, so it falls through to idle.
    const deadAwaiting = deriveSessionStatus(
      snap({
        processAlive: false,
        activity: { kind: 'exited', at: 700, exitCode: 0 },
        agentState: { phase: 'awaiting_input', since: 500, source: 'hook' },
      }),
    )
    assert.notEqual(deadAwaiting.status, 'needs-input', 'dead awaiting_input does not surface as needs-input')

    for (const phase of ['starting', 'thinking', 'tool_use'] as const) {
      const working = deriveSessionStatus(
        snap({ activity: { kind: 'idle', since: 1 }, agentState: { phase, since: 42, source: 'hook' } }),
      )
      assert.equal(working.status, 'working', `${phase} -> working`)
      assert.equal(working.activitySince, 42)
    }

    // `idle` and `stalled` hook phases read as idle, not working.
    for (const phase of ['idle', 'stalled'] as const) {
      const idle = deriveSessionStatus(
        snap({ activity: { kind: 'working', since: 1 }, agentState: { phase, since: 99, source: 'hook' } }),
      )
      assert.equal(idle.status, 'idle', `${phase} -> idle even while bytes are flowing`)
      assert.equal(idle.source, 'hook')
    }
  }

  // Without a hook frame, fall back to the output-timing heuristic, marked inferred.
  function assertOutputRecencyFallback(): void {
    const working = deriveSessionStatus(snap({ activity: { kind: 'working', since: 7 } }))
    assert.equal(working.status, 'working')
    assert.equal(working.source, 'lifecycle')
    assert.equal(working.activitySince, 7)

    const idle = deriveSessionStatus(snap({ activity: { kind: 'idle', since: 8 } }))
    assert.equal(idle.status, 'idle')
    assert.equal(idle.source, 'lifecycle')
  }

  // A retained crash surfaces as failed (with its exit code) and outranks any
  // stale working signal.
  function assertFailedRetentionAndPrecedence(): void {
    const failed = deriveSessionStatus(
      snap({
        activity: { kind: 'failed', at: 1234, exitCode: 137 },
        agentState: { phase: 'thinking', since: 1, source: 'hook' },
      }),
    )
    assert.equal(failed.status, 'failed')
    assert.equal(failed.exitCode, 137)
    assert.equal(failed.activitySince, 1234, 'failed since comes from the exit timestamp')
  }

  function assertLastActivityIsMaxOfOutputAndInput(): void {
    assert.equal(
      deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: 100, lastInputAt: 250 }))
        .lastActivityAt,
      250,
    )
    assert.equal(
      deriveSessionStatus(snap({ activity: { kind: 'idle', since: 1 }, lastOutputAt: null, lastInputAt: null }))
        .lastActivityAt,
      null,
    )
  }

  function item(partial: {
    status: SessionItem['status']
    activitySince?: number
    lastActivityAt?: number | null
  }): SessionItem {
    return {
      status: partial.status,
      activitySince: partial.activitySince ?? 0,
      lastActivityAt: partial.lastActivityAt ?? null,
    } as unknown as SessionItem
  }

  // Rows sort attention-first: needs-input -> failed -> working -> idle, then most
  // recently active first within a tier.
  function assertAttentionFirstOrdering(): void {
    const rows = [
      item({ status: 'idle', lastActivityAt: 100 }),
      item({ status: 'working' }),
      item({ status: 'failed' }),
      item({ status: 'needs-input' }),
      item({ status: 'idle', lastActivityAt: 900 }),
    ]
    const sorted = rows
      .slice()
      .sort(compareSessionItemsByAttention)
      .map((row) => row.status)
    assert.deepEqual(sorted, ['needs-input', 'failed', 'working', 'idle', 'idle'])

    const idleByRecency = [item({ status: 'idle', lastActivityAt: 100 }), item({ status: 'idle', lastActivityAt: 900 })]
      .sort(compareSessionItemsByAttention)
      .map((row) => row.lastActivityAt)
    assert.deepEqual(idleByRecency, [900, 100], 'more recent idle first')
  }

  // The trigger badge tone must escalate, never repeat a flat "all good".
  function assertAttentionToneNeverLies(): void {
    assert.equal(sessionsAttentionTone([]), 'good')
    assert.equal(sessionsAttentionTone([item({ status: 'working' }), item({ status: 'idle' })]), 'good')
    assert.equal(sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'working' })]), 'error')
    assert.equal(
      sessionsAttentionTone([item({ status: 'failed' }), item({ status: 'needs-input' })]),
      'warn',
      'needs-input outranks failed for tone',
    )
  }

  // MC-2188. The account surfaces used to ask `plan.code === 'pro'`, which names
  // the auth provider's data model rather than the product's own vocabulary. The
  // two assertions below pin the split that replaced it: access reads feature
  // keys, display reads the plan's name and decides nothing.
  function authState(
    overrides: {
      authenticated?: boolean
      planCode?: string
      planStatus?: string
      features?: Record<string, boolean>
      entitlementStatus?: MulticodeAuthState['entitlementStatus']
    } = {},
  ): MulticodeAuthState {
    const {
      authenticated = true,
      planCode = 'free',
      planStatus = 'active',
      features = {},
      entitlementStatus = 'fresh',
    } = overrides
    return {
      authenticated,
      user: null,
      selectedOrganization: null,
      entitlements: authenticated
        ? {
            userId: 'u1',
            organizationId: 'o1',
            product: 'multicode',
            roles: [],
            features,
            limits: {},
            sources: {},
            plan: { code: planCode, status: planStatus },
            issuedAt: '2026-08-01T00:00:00.000Z',
            expiresAt: '2026-08-04T00:00:00.000Z',
            schemaVersion: 1,
          }
        : null,
      status: authenticated ? 'signed_in' : 'signed_out',
      entitlementStatus,
      message: null,
      lastRefreshAt: null,
      graceExpiresAt: null,
    }
  }

  // Multiauth's catalog: Free grants only `multicode.sprintengine`; Pro adds
  // the mobile companion, and nothing else (MC-1579). Functions rather than
  // consts because this file calls `main()` before its own top-level bindings run.
  function freeFeatures(): Record<string, boolean> {
    return {
      'multicode.sprintengine': true,
      'multicode.mobile_companion': false,
    }
  }
  function proFeatures(): Record<string, boolean> {
    return { ...freeFeatures(), 'multicode.mobile_companion': true }
  }

  function assertPaidAccessIsDecidedByFeatureKeys(): void {
    assert.equal(hasPaidEntitlement(authState({ authenticated: false })), false, 'signed out is never paid')
    assert.equal(
      hasPaidEntitlement(authState({ planCode: 'free', features: freeFeatures() })),
      false,
      'free plan holds no paid feature',
    )
    assert.equal(
      hasPaidEntitlement(authState({ planCode: 'pro', features: proFeatures() })),
      true,
      'pro plan holds the paid features',
    )

    // The point of the item: the plan's NAME decides nothing in either direction.
    assert.equal(
      hasPaidEntitlement(authState({ planCode: 'pro', features: freeFeatures() })),
      false,
      'a plan called pro that grants nothing paid is not paid access',
    )
    assert.equal(
      hasPaidEntitlement(authState({ planCode: 'multicode_pro_monthly', features: proFeatures() })),
      true,
      'a provider-renamed plan still resolves through its feature keys',
    )

    // An operator grant for the key on a free plan is real paid access.
    assert.equal(
      hasPaidEntitlement(
        authState({ planCode: 'free', features: { ...freeFeatures(), 'multicode.mobile_companion': true } }),
      ),
      true,
      'an admin override counts as paid access',
    )

    // Retired keys decide nothing: a snapshot from an older server that still
    // carries `multicode.frontier_models` is not paid access on its own.
    assert.equal(
      hasPaidEntitlement(
        authState({ planCode: 'free', features: { ...freeFeatures(), 'multicode.frontier_models': true } }),
      ),
      false,
      'a retired key does not count as paid access',
    )

    // Behaviour parity with the gate this replaced: the cached snapshot still
    // carries the paid keys while access is stale, so a paid account is not
    // suddenly told to upgrade the moment its snapshot goes off-fresh.
    assert.equal(
      hasPaidEntitlement(authState({ planCode: 'pro', features: proFeatures(), entitlementStatus: 'offline_grace' })),
      true,
      'stale access does not revoke paid capability in the UI',
    )
  }

  function assertPlanDisplayTierIsPresentationOnly(): void {
    assert.equal(planDisplayTier(authState({ authenticated: false })), 'free')
    assert.equal(planDisplayTier(authState({ planCode: 'free', features: freeFeatures() })), 'free')
    assert.equal(planDisplayTier(authState({ planCode: 'Pro', features: proFeatures() })), 'pro', 'case-insensitive')
    assert.equal(
      planDisplayTier(authState({ planCode: 'pro', planStatus: 'past_due', features: proFeatures() })),
      'free',
      'a non-active plan does not get the Pro badge',
    )
  }
})
