import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import {
  dedupeAutomationsHostWorkspaces,
  dropRetiredRoadmapWorkspaces,
  mapMigrationWorkspaces,
  normalizeWorkspaceForPartialize,
  preserveNewerSprintEngineAutomationState,
} from './normalizers'

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-1',
  name: 'Test',
  folderPath: '/Users/example/project',
  folderMissing: false,
  mode: 'standard',
  layoutModel: undefined as unknown as Workspace['layoutModel'],
  agents: {},
  sprintEngineState: null,
  sprintEngineContext: null,
  sprintEngineAutoState: undefined,
  guidedBriefState: null,
  sprintEngineRoleCliDefaults: undefined,
  memory: undefined,
  worktreeState: undefined,
  editorState: { openFiles: [], activeFilePath: null },
  highlight: undefined,
  lastTerminalOutputAt: undefined,
  ...overrides,
} as unknown as Workspace)

// mapMigrationWorkspaces mutates the carrier in place, mapping each workspace.
const carrier = { workspaces: [baseWorkspace({ id: 'a' }), baseWorkspace({ id: 'b' })] }
mapMigrationWorkspaces(carrier, (ws) => ({ ...ws, name: `${ws.id}-renamed` }))
assert.deepEqual(
  carrier.workspaces.map((w) => w.name),
  ['a-renamed', 'b-renamed'],
)
assert.equal(carrier.workspaces.length, 2)

// normalizeWorkspaceForPartialize strips file content while keeping the file list.
const dirty = baseWorkspace({
  editorState: {
    openFiles: [
      { path: '/a.ts', name: 'a.ts', content: 'should be stripped', isDirty: true },
      { path: '/b.ts', name: 'b.ts', content: 'also stripped', isDirty: true },
    ],
    activeFilePath: '/a.ts',
  } as unknown as Workspace['editorState'],
})
const cleaned = normalizeWorkspaceForPartialize(dirty)
const cleanedFiles = cleaned.editorState?.openFiles ?? []
assert.equal(cleanedFiles.length, 2)
for (const file of cleanedFiles) {
  assert.equal(file.isDirty, false)
  assert.equal((file as unknown as { content?: string }).content, undefined)
}
assert.equal(cleaned.editorState?.activeFilePath, '/a.ts')

const autoRunCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  sprintEngineAutoState: {
    desiredMode: 'run_agents_and_approve_artifacts',
    runtimeState: 'running',
    cliPermissionPreset: 'bypass_all',
    maxConcurrentAgents: 4,
    // Legacy pending-spawn residue from an older build: dropped on partialize.
    pendingSpawns: [{ taskId: 'T1', agentId: 'developer-1', startedAt: 1 }],
    deliveredAgentNotificationEventKeys: ['EVT-1'],
  } as never,
}))
assert.equal(autoRunCleaned.sprintEngineAutoState.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(autoRunCleaned.sprintEngineAutoState.runtimeState, 'running')
assert.equal(
  'pendingSpawns' in autoRunCleaned.sprintEngineAutoState,
  false,
  'legacy pending-spawn residue never survives partialize (MC-1592: no persisted spawn ledger)',
)
assert.equal(autoRunCleaned.sprintEngineAutoState.maxConcurrentAgents, 4)

// Creation "start now" launch intent is session-only: persisting it would
// replay the initial spawns on the next app start.
const initialSpawnCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  sprintEngineInitialSpawnAgentIds: ['frontend'],
}))
assert.equal(initialSpawnCleaned.sprintEngineInitialSpawnAgentIds, undefined)

// The Sprint Engine projection is a disk-backed cache (projection.json), so it
// is dropped from the persisted registry to avoid the 4s projection-poll write
// storm. Durable identity (mode) is still derived from the live state before it
// is stripped, so a Sprint Engine workspace stays classified as 'sprintengine'.
const projectionCleaned = normalizeWorkspaceForPartialize(baseWorkspace({
  mode: 'sprintengine',
  sprintEngineContext: { statePath: '/p/.sprintengine/state', teamSlug: 'core' } as unknown as Workspace['sprintEngineContext'],
  sprintEngineState: {
    goal: 'Ship it',
    tasks: [{ id: 'T1', status: 'done' }],
    artifacts: [{ id: 'A1' }],
  } as unknown as Workspace['sprintEngineState'],
}))
assert.equal(projectionCleaned.sprintEngineState, null)
assert.equal(projectionCleaned.mode, 'sprintengine')
assert.notEqual(projectionCleaned.sprintEngineContext, null)

// normalizeWorkspaceForPartialize zeros the in-memory stream buffer + status on agents
// that survive a save so they cold-load idle instead of streaming.
const withAgent = baseWorkspace({
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'streaming',
      streamBuffer: 'partial chunk',
      cliOnboardingPromptSent: false,
      cliStartupPrompt: 'kept',
    },
  } as unknown as Workspace['agents'],
})
const withAgentCleaned = normalizeWorkspaceForPartialize(withAgent)
const persistedAgent = (withAgentCleaned.agents as Record<string, { status: string; streamBuffer: string; cliStartupPrompt?: string }>)['agent-1']
assert.equal(persistedAgent.status, 'idle')
assert.equal(persistedAgent.streamBuffer, '')
// Specialist agents that have not yet sent their onboarding prompt keep cliStartupPrompt.
assert.equal(persistedAgent.cliStartupPrompt, 'kept')

// Durable resume identity survives the persist normalize so a cold restart can
// resume without waiting on the async plugin catalog (MC-1465): the stamped
// cliResumeAvailable AND cliUsesStableSessionId must both round-trip.
const withResumableAgent = baseWorkspace({
  agents: {
    'claude-1': {
      id: 'claude-1',
      name: 'Claude',
      kind: 'general',
      cli: 'claude-code',
      status: 'idle',
      streamBuffer: '',
      cliHasLaunched: true,
      cliSessionId: 'sess-claude',
      cliResumeAvailable: true,
      cliUsesStableSessionId: true,
    },
  } as unknown as Workspace['agents'],
})
const resumableCleaned = normalizeWorkspaceForPartialize(withResumableAgent)
const persistedResumable = (resumableCleaned.agents as Record<string, { cliResumeAvailable?: boolean; cliUsesStableSessionId?: boolean; cliHasLaunched?: boolean }>)['claude-1']
assert.equal(persistedResumable.cliHasLaunched, true, 'cliHasLaunched survives persist')
assert.equal(persistedResumable.cliResumeAvailable, true, 'cliResumeAvailable survives persist')
assert.equal(persistedResumable.cliUsesStableSessionId, true, 'cliUsesStableSessionId survives persist (cold-restart resume gate)')

const withAgentAlreadyOnboarded = baseWorkspace({
  agents: {
    'agent-2': {
      id: 'agent-2',
      name: 'Specialist',
      kind: 'specialist',
      specialistId: 'architect',
      status: 'idle',
      streamBuffer: '',
      cliOnboardingPromptSent: true,
      cliStartupPrompt: 'should be dropped',
    },
  } as unknown as Workspace['agents'],
})
const onboardedCleaned = normalizeWorkspaceForPartialize(withAgentAlreadyOnboarded)
const onboardedAgent = (onboardedCleaned.agents as Record<string, { cliStartupPrompt?: string }>)['agent-2']
assert.equal(onboardedAgent.cliStartupPrompt, undefined)

const newerLocalAutomation = preserveNewerSprintEngineAutomationState(
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'manual',
      runtimeState: 'idle',
      changedAt: 100,
    } as Workspace['sprintEngineAutoState'],
  }),
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'blocked',
      reason: 'blocked_on_input',
      reasonTaskId: 'T3',
      reasonMessage: 'Task T3 is waiting on input.',
      changedAt: 200,
    } as Workspace['sprintEngineAutoState'],
  }),
)
assert.equal(newerLocalAutomation.sprintEngineAutoState?.desiredMode, 'run_agents')
assert.equal(newerLocalAutomation.sprintEngineAutoState?.runtimeState, 'blocked')
assert.equal(newerLocalAutomation.sprintEngineAutoState?.reasonTaskId, 'T3')

const newerIncomingAutomation = preserveNewerSprintEngineAutomationState(
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents_and_approve_artifacts',
      runtimeState: 'running',
      changedAt: 300,
    } as Workspace['sprintEngineAutoState'],
  }),
  baseWorkspace({
    id: 'ws-sync',
    sprintEngineAutoState: {
      desiredMode: 'run_agents',
      runtimeState: 'blocked',
      changedAt: 200,
    } as Workspace['sprintEngineAutoState'],
  }),
)
assert.equal(newerIncomingAutomation.sprintEngineAutoState?.desiredMode, 'run_agents_and_approve_artifacts')
assert.equal(newerIncomingAutomation.sprintEngineAutoState?.runtimeState, 'running')

// Backlog + Git panel view state survives partialize, with malformed fields
// coerced rather than dropped, and absent state stays undefined (no per-workspace
// bloat).
const viewStateClean = normalizeWorkspaceForPartialize(baseWorkspace({
  backlogState: {
    selectedRelativePath: 'backlog/a.md',
    view: 'quick_wins',
    sort: 'priority',
    search: 'auth',
  },
  gitPanelState: {
    activeView: 'log',
    activeScopeId: 'worktree-x',
    commitDraftsByScopeId: { 'worktree-x': 'WIP', main: '   ' },
  },
} as unknown as Partial<Workspace>) as unknown as Workspace)
assert.deepEqual(viewStateClean.backlogState, {
  selectedRelativePath: 'backlog/a.md',
  view: 'quick_wins',
  sort: 'priority',
  group: 'none',
  search: 'auth',
})
// The blank `main` draft is dropped; the real one is kept.
assert.deepEqual(viewStateClean.gitPanelState, {
  activeView: 'log',
  activeScopeId: 'worktree-x',
  commitDraftsByScopeId: { 'worktree-x': 'WIP' },
})

const malformedViewState = normalizeWorkspaceForPartialize(baseWorkspace({
  backlogState: { view: 'nope', sort: 'nope', search: 5, selectedRelativePath: '  ' },
  gitPanelState: { activeView: 'nope', activeScopeId: '', commitDraftsByScopeId: 'oops' },
} as unknown as Partial<Workspace>) as unknown as Workspace)
assert.deepEqual(malformedViewState.backlogState, {
  selectedRelativePath: null,
  view: 'active',
  sort: 'recent',
  group: 'none',
  search: '',
})
assert.deepEqual(malformedViewState.gitPanelState, {
  activeView: 'changes',
  activeScopeId: 'main',
  commitDraftsByScopeId: {},
})

const noViewState = normalizeWorkspaceForPartialize(baseWorkspace())
assert.equal(noViewState.backlogState, undefined, 'absent backlog state stays undefined')
assert.equal(noViewState.gitPanelState, undefined, 'absent git panel state stays undefined')

// An automations-host workspace persists and is reused, and its finalized
// automation agents must not auto-resume after a full restart. Partialize clears
// the launch/resume GATE — which is what `shouldResume` reads at mount — and
// deliberately KEEPS the session identity: `cliSessionId` is the key to the
// painted screen on disk (terminal-snapshots/<cliSessionId>.json). Clearing it
// orphaned that snapshot, so the tab minted a fresh uuid, matched no sidecar,
// could not reach the paused branch, and spawned a fresh CLI on every cold load.
const persistedHostAgentFields = {
  id: 'agent-1',
  name: 'Automation',
  kind: 'general',
  status: 'streaming',
  streamBuffer: 'partial chunk',
  cliSessionId: 'sess-123',
  harnessSessionId: 'harness-123',
  cliStartRequested: true,
  cliRestartNonce: 3,
  cliHasLaunched: true,
  cliResumeAvailable: true,
  cliResumeRequested: true,
  cliOnboardingPromptSent: true,
  cliStartupPrompt: 'Run automation MM-37',
}
const automationsHostPersisted = normalizeWorkspaceForPartialize(baseWorkspace({
  mode: 'automations-host',
  agents: { 'agent-1': persistedHostAgentFields } as unknown as Workspace['agents'],
}))
type PersistedLaunchAgent = {
  status: string
  streamBuffer: string
  cliSessionId?: string
  harnessSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliResumeAvailable?: boolean
  cliResumeRequested?: boolean
  cliOnboardingPromptSent?: boolean
  cliStartupPrompt?: string
}
const automationsHostAgent = (automationsHostPersisted.agents as Record<string, PersistedLaunchAgent>)['agent-1']
assert.equal(automationsHostPersisted.mode, 'automations-host', 'mode is preserved')
assert.equal(automationsHostAgent.status, 'idle')
assert.equal(automationsHostAgent.streamBuffer, '')
assert.equal(automationsHostAgent.cliSessionId, 'sess-123', 'session identity survives cold load (resolves the painted snapshot)')
assert.equal(automationsHostAgent.harnessSessionId, 'harness-123', 'harness resume token survives too — the two normalizers stay in step')
// The auto-resume regression guard. These flags ARE the mount-time resume gate
// (shouldResume, TerminalView): if any of them survived, a cold-loaded agent
// would launch an unattended `--resume` — worse than the fresh spawn this fixes.
assert.equal(automationsHostAgent.cliStartRequested, false)
assert.equal(automationsHostAgent.cliHasLaunched, false)
assert.equal(automationsHostAgent.cliResumeAvailable, false)
assert.equal(automationsHostAgent.cliResumeRequested, false)
assert.equal(automationsHostAgent.cliOnboardingPromptSent, false)
assert.equal(automationsHostAgent.cliRestartNonce, 0)
// Clearing the startup prompt is what keeps a start from re-running the
// automation directive. Keep it cleared.
assert.equal(automationsHostAgent.cliStartupPrompt, undefined, 'the automation directive is never re-sent')

// The sprintengine normalizer must be identical in every respect — 374 sprint
// agents ride on the same defect, and the comment ties the two functions
// together. Same fixture, same assertions.
const sprintPersisted = normalizeWorkspaceForPartialize(baseWorkspace({
  mode: 'sprintengine',
  agents: {
    'agent-1': { ...persistedHostAgentFields, kind: 'sprintengine' },
  } as unknown as Workspace['agents'],
}))
const sprintAgent = (sprintPersisted.agents as Record<string, PersistedLaunchAgent>)['agent-1']
assert.equal(sprintAgent.cliSessionId, 'sess-123', 'sprint agents keep session identity too')
assert.equal(sprintAgent.harnessSessionId, 'harness-123', 'sprint agents keep the harness resume token')
assert.equal(sprintAgent.cliStartRequested, false)
assert.equal(sprintAgent.cliHasLaunched, false)
assert.equal(sprintAgent.cliResumeAvailable, false)
assert.equal(sprintAgent.cliResumeRequested, false)
assert.equal(sprintAgent.cliOnboardingPromptSent, false)
assert.equal(sprintAgent.cliRestartNonce, 0)
assert.equal(sprintAgent.cliStartupPrompt, undefined)
assert.equal(sprintAgent.status, 'idle')
assert.equal(sprintAgent.streamBuffer, '')

// A standard workspace's agent keeps its durable resume identity (regression
// guard that the automations-host clear does not leak into other modes).
const standardResumePersisted = normalizeWorkspaceForPartialize(baseWorkspace({
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Dev',
      kind: 'general',
      status: 'idle',
      streamBuffer: '',
      cliSessionId: 'sess-keep',
      cliHasLaunched: true,
      cliResumeAvailable: true,
    },
  } as unknown as Workspace['agents'],
}))
const standardResumeAgent = (standardResumePersisted.agents as Record<string, {
  cliSessionId?: string
  cliHasLaunched?: boolean
  cliResumeAvailable?: boolean
}>)['agent-1']
assert.equal(standardResumeAgent.cliSessionId, 'sess-keep', 'standard agents keep resume identity')
assert.equal(standardResumeAgent.cliHasLaunched, true)
assert.equal(standardResumeAgent.cliResumeAvailable, true)

// The worktree marker (set when a worktree is opened as a workspace) must
// survive partialize so the Git view + tab glyph still resolve after a restart,
// including through the sprint-engine and automations-host launch-state clears.
assert.deepEqual(
  normalizeWorkspaceForPartialize(baseWorkspace({ worktree: { branch: 'spike/parser', baseRef: 'main' } })).worktree,
  { branch: 'spike/parser', baseRef: 'main' },
  'worktree marker survives partialize',
)
assert.deepEqual(
  normalizeWorkspaceForPartialize(baseWorkspace({
    mode: 'sprintengine',
    worktree: { branch: 'sprintengine/x' },
    sprintEngineState: { goal: 'g', tasks: [], artifacts: [] } as unknown as Workspace['sprintEngineState'],
  })).worktree,
  { branch: 'sprintengine/x' },
  'sprint-engine launch-state clear preserves the worktree marker',
)
assert.deepEqual(
  normalizeWorkspaceForPartialize(baseWorkspace({ mode: 'automations-host', worktree: { branch: 'auto/y' } })).worktree,
  { branch: 'auto/y' },
  'automations-host launch-state clear preserves the worktree marker',
)
assert.equal(
  normalizeWorkspaceForPartialize(baseWorkspace()).worktree,
  undefined,
  'absent worktree marker stays absent (no-op for existing workspaces)',
)

// dedupeAutomationsHostWorkspaces — one host per folder, earliest wins, kept
// host is re-branded 'Automations' (pre-v63 minting named hosts after runs).
{
  const hostA = baseWorkspace({ id: 'host-a', mode: 'automations-host', name: 'Pillars of code review', folderPath: '/Users/example/project', createdAt: 100 })
  const hostB = baseWorkspace({ id: 'host-b', mode: 'automations-host', name: 'fable5 calendar', folderPath: '/Users/example/project/', createdAt: 300 })
  const hostC = baseWorkspace({ id: 'host-c', mode: 'automations-host', name: 'Nightly reviewer', folderPath: '/USERS/EXAMPLE/PROJECT', createdAt: 200 })
  const otherFolderHost = baseWorkspace({ id: 'host-other', mode: 'automations-host', name: 'Solo host', folderPath: '/Users/example/other', createdAt: 50 })
  const standard = baseWorkspace({ id: 'std', mode: 'standard', folderPath: '/Users/example/project', createdAt: 10 })

  const deduped = dedupeAutomationsHostWorkspaces([hostB, standard, hostA, hostC, otherFolderHost])
  assert.deepEqual(
    deduped.map((w) => w.id),
    ['std', 'host-a', 'host-other'],
    'earliest host per folder key survives (trailing slash + case insensitive), order preserved',
  )
  const kept = deduped.find((w) => w.id === 'host-a')
  assert.equal(kept?.name, 'Automations', 'kept host is re-branded with the stable surface name')
  assert.equal(
    deduped.find((w) => w.id === 'host-other')?.name,
    'Solo host',
    'a folder with a single host is left untouched — no rename',
  )
}

// No duplicates → the exact input array is returned (cheap no-op on hot paths).
{
  const solo = baseWorkspace({ id: 'solo', mode: 'automations-host', name: 'fable5 calendar', folderPath: '/p', createdAt: 1 })
  const list = [solo, baseWorkspace({ id: 'std2', mode: 'standard' })]
  assert.equal(dedupeAutomationsHostWorkspaces(list), list, 'no-dupe input returned by reference')
}

// Hosts without a folder cannot collide and all pass through.
{
  const nullA = baseWorkspace({ id: 'n-a', mode: 'automations-host', folderPath: null, createdAt: 1 })
  const nullB = baseWorkspace({ id: 'n-b', mode: 'automations-host', folderPath: null, createdAt: 2 })
  assert.deepEqual(
    dedupeAutomationsHostWorkspaces([nullA, nullB]).map((w) => w.id),
    ['n-a', 'n-b'],
    'folderless hosts are never deduped',
  )
}

// dropRetiredRoadmapWorkspaces — the `roadmap` workspace mode retired (v65,
// MC-1692). Every list-entry path (migration, merge, recovery, cross-window sync)
// filters it so a dev-HMR version-stamp cannot resurrect a roadmap-mode row.
{
  const roadmap = baseWorkspace({ id: 'ws-roadmap', mode: 'roadmap', folderPath: '/Users/example/project' })
  const standard = baseWorkspace({ id: 'ws-standard', mode: 'standard' })
  const sprint = baseWorkspace({ id: 'ws-sprint', mode: 'sprintengine' })
  assert.deepEqual(
    dropRetiredRoadmapWorkspaces([standard, roadmap, sprint]).map((w) => w.id),
    ['ws-standard', 'ws-sprint'],
    'roadmap-mode rows are dropped, others kept in order',
  )
  const noRoadmap = [standard, sprint]
  assert.equal(
    dropRetiredRoadmapWorkspaces(noRoadmap),
    noRoadmap,
    'no roadmap-mode row → the exact input array is returned by reference (cheap no-op)',
  )
}

console.log('normalizers.test.ts: ok')
