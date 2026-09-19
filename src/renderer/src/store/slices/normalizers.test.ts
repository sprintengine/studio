import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import {
  dedupeAutomationsHostWorkspaces,
  dropRetiredModeWorkspaces,
  mapMigrationWorkspaces,
  normalizeWorkspaceForPartialize,
} from './normalizers'

const baseWorkspace = (overrides: Partial<Workspace> = {}): Workspace =>
  ({
    id: 'ws-1',
    name: 'Test',
    folderPath: '/Users/example/project',
    folderMissing: false,
    mode: 'standard',
    layoutModel: undefined as unknown as Workspace['layoutModel'],
    agents: {},
    memory: undefined,
    worktreeState: undefined,
    editorState: { openFiles: [], activeFilePath: null },
    highlight: undefined,
    lastTerminalOutputAt: undefined,
    ...overrides,
  }) as unknown as Workspace

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

// normalizeWorkspaceForPartialize zeros the in-memory stream buffer + status on agents
// that survive a save so they cold-load idle instead of streaming.
const withAgent = baseWorkspace({
  agents: {
    'agent-1': {
      id: 'agent-1',
      name: 'Ada',
      status: 'streaming',
      streamBuffer: 'partial chunk',
      cliOnboardingPromptSent: false,
      cliStartupPrompt: 'launch intent',
    },
  } as unknown as Workspace['agents'],
})
const withAgentCleaned = normalizeWorkspaceForPartialize(withAgent)
const persistedAgent = (
  withAgentCleaned.agents as Record<string, { status: string; streamBuffer: string; cliStartupPrompt?: string }>
)['agent-1']
assert.equal(persistedAgent.status, 'idle')
assert.equal(persistedAgent.streamBuffer, '')
// A prompt that has not reached the CLI yet is launch intent, not durable
// state: a restart starts the agent at its own prompt rather than replaying it.
assert.equal(persistedAgent.cliStartupPrompt, undefined)

// Durable resume identity survives the persist normalize so a cold restart can
// resume without waiting on the async plugin catalog (MC-1465): the stamped
// cliResumeAvailable AND cliUsesStableSessionId must both round-trip.
const withResumableAgent = baseWorkspace({
  agents: {
    'claude-1': {
      id: 'claude-1',
      name: 'Claude',
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
const persistedResumable = (
  resumableCleaned.agents as Record<
    string,
    { cliResumeAvailable?: boolean; cliUsesStableSessionId?: boolean; cliHasLaunched?: boolean }
  >
)['claude-1']
assert.equal(persistedResumable.cliHasLaunched, true, 'cliHasLaunched survives persist')
assert.equal(persistedResumable.cliResumeAvailable, true, 'cliResumeAvailable survives persist')
assert.equal(
  persistedResumable.cliUsesStableSessionId,
  true,
  'cliUsesStableSessionId survives persist (cold-restart resume gate)',
)

// And an agent whose prompt HAS reached the CLI drops it for the same reason.
const withAgentAlreadyOnboarded = baseWorkspace({
  agents: {
    'agent-2': {
      id: 'agent-2',
      name: 'Grace',
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

// Backlog + Git panel view state survives partialize, with malformed fields
// coerced rather than dropped, and absent state stays undefined (no per-workspace
// bloat).
const viewStateClean = normalizeWorkspaceForPartialize(
  baseWorkspace({
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
  } as unknown as Partial<Workspace>) as unknown as Workspace,
)
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

const malformedViewState = normalizeWorkspaceForPartialize(
  baseWorkspace({
    backlogState: { view: 'nope', sort: 'nope', search: 5, selectedRelativePath: '  ' },
    gitPanelState: { activeView: 'nope', activeScopeId: '', commitDraftsByScopeId: 'oops' },
  } as unknown as Partial<Workspace>) as unknown as Workspace,
)
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
  status: 'streaming',
  streamBuffer: 'partial chunk',
  cliSessionId: 'sess-123',
  harnessSessionId: 'harness-123',
  cliStartRequested: true,
  cliRestartNonce: 3,
  cliHasLaunched: true,
  cliResumeAvailable: true,
  cliOnboardingPromptSent: true,
  cliStartupPrompt: 'Run automation MM-37',
}
const automationsHostPersisted = normalizeWorkspaceForPartialize(
  baseWorkspace({
    mode: 'automations-host',
    agents: { 'agent-1': persistedHostAgentFields } as unknown as Workspace['agents'],
  }),
)
type PersistedLaunchAgent = {
  status: string
  streamBuffer: string
  cliSessionId?: string
  harnessSessionId?: string
  cliStartRequested?: boolean
  cliRestartNonce?: number
  cliHasLaunched?: boolean
  cliResumeAvailable?: boolean
  cliOnboardingPromptSent?: boolean
  cliStartupPrompt?: string
}
const automationsHostAgent = (automationsHostPersisted.agents as Record<string, PersistedLaunchAgent>)['agent-1']
assert.equal(automationsHostPersisted.mode, 'automations-host', 'mode is preserved')
assert.equal(automationsHostAgent.status, 'idle')
assert.equal(automationsHostAgent.streamBuffer, '')
assert.equal(
  automationsHostAgent.cliSessionId,
  'sess-123',
  'session identity survives cold load (resolves the painted snapshot)',
)
assert.equal(
  automationsHostAgent.harnessSessionId,
  'harness-123',
  'harness resume token survives too — the two normalizers stay in step',
)
// The auto-resume regression guard. These flags ARE the mount-time resume gate
// (shouldResume, TerminalView): if any of them survived, a cold-loaded agent
// would launch an unattended `--resume` — worse than the fresh spawn this fixes.
assert.equal(automationsHostAgent.cliStartRequested, false)
assert.equal(automationsHostAgent.cliHasLaunched, false)
assert.equal(automationsHostAgent.cliResumeAvailable, false)
assert.equal(automationsHostAgent.cliOnboardingPromptSent, false)
assert.equal(automationsHostAgent.cliRestartNonce, 0)
// Clearing the startup prompt is what keeps a start from re-running the
// automation directive. Keep it cleared.
assert.equal(automationsHostAgent.cliStartupPrompt, undefined, 'the automation directive is never re-sent')

// A standard workspace's agent keeps its durable resume identity (regression
// guard that the automations-host clear does not leak into other modes).
const standardResumePersisted = normalizeWorkspaceForPartialize(
  baseWorkspace({
    agents: {
      'agent-1': {
        id: 'agent-1',
        name: 'Dev',
        status: 'idle',
        streamBuffer: '',
        cliSessionId: 'sess-keep',
        cliHasLaunched: true,
        cliResumeAvailable: true,
      },
    } as unknown as Workspace['agents'],
  }),
)
const standardResumeAgent = (
  standardResumePersisted.agents as Record<
    string,
    {
      cliSessionId?: string
      cliHasLaunched?: boolean
      cliResumeAvailable?: boolean
    }
  >
)['agent-1']
assert.equal(standardResumeAgent.cliSessionId, 'sess-keep', 'standard agents keep resume identity')
assert.equal(standardResumeAgent.cliHasLaunched, true)
assert.equal(standardResumeAgent.cliResumeAvailable, true)

// The worktree marker (set when a worktree is opened as a workspace) must
// survive partialize so the Git view + tab glyph still resolve after a restart,
// including through the automations-host launch-state clear.
assert.deepEqual(
  normalizeWorkspaceForPartialize(baseWorkspace({ worktree: { branch: 'spike/parser', baseRef: 'main' } })).worktree,
  { branch: 'spike/parser', baseRef: 'main' },
  'worktree marker survives partialize',
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
  const hostA = baseWorkspace({
    id: 'host-a',
    mode: 'automations-host',
    name: 'Pillars of code review',
    folderPath: '/Users/example/project',
    createdAt: 100,
  })
  const hostB = baseWorkspace({
    id: 'host-b',
    mode: 'automations-host',
    name: 'fable5 calendar',
    folderPath: '/Users/example/project/',
    createdAt: 300,
  })
  const hostC = baseWorkspace({
    id: 'host-c',
    mode: 'automations-host',
    name: 'Nightly reviewer',
    folderPath: '/USERS/EXAMPLE/PROJECT',
    createdAt: 200,
  })
  const otherFolderHost = baseWorkspace({
    id: 'host-other',
    mode: 'automations-host',
    name: 'Solo host',
    folderPath: '/Users/example/other',
    createdAt: 50,
  })
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
  const solo = baseWorkspace({
    id: 'solo',
    mode: 'automations-host',
    name: 'fable5 calendar',
    folderPath: '/p',
    createdAt: 1,
  })
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

// dropRetiredModeWorkspaces — the `roadmap` (v65, MC-1692), `multiloop` (v66),
// `guided-brief` (2026-09-08, the deleted Design Wizard), `reviews-host`
// (v75, Reviews extracted to an installable module) and `sprintengine` (the
// in-tree engine's deletion) workspace modes retired. Every list-entry path
// (migration, merge, recovery, cross-window sync) filters them so a dev-HMR
// version-stamp cannot resurrect a row in a mode nothing can render.
{
  const roadmap = baseWorkspace({ id: 'ws-roadmap', mode: 'roadmap', folderPath: '/Users/example/project' })
  const multiloop = baseWorkspace({ id: 'ws-multiloop', mode: 'multiloop', folderPath: '/Users/example/other' })
  const guidedBrief = baseWorkspace({ id: 'ws-guided', mode: 'guided-brief', folderPath: '/Users/example/design' })
  const reviewsHost = baseWorkspace({ id: 'ws-reviews', mode: 'reviews-host', folderPath: '/Users/example/repo' })
  const standard = baseWorkspace({ id: 'ws-standard', mode: 'standard' })
  const retiredEngine = baseWorkspace({ id: 'ws-engine', mode: 'sprintengine' })
  const automationsHost = baseWorkspace({ id: 'ws-auto', mode: 'automations-host' })
  assert.deepEqual(
    dropRetiredModeWorkspaces([
      standard,
      roadmap,
      multiloop,
      guidedBrief,
      reviewsHost,
      retiredEngine,
      automationsHost,
    ]).map((w) => w.id),
    ['ws-standard', 'ws-auto'],
    'every retired-mode row is dropped, others kept in order',
  )
  const noRetired = [standard, automationsHost]
  assert.equal(
    dropRetiredModeWorkspaces(noRetired),
    noRetired,
    'no retired-mode row → the exact input array is returned by reference (cheap no-op)',
  )
}

console.log('normalizers.test.ts: ok')
