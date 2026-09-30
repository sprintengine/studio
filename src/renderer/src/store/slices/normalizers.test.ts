import assert from 'node:assert/strict'

import type { Workspace } from '../../types/workspace'
import { dropRetiredModeWorkspaces, mapMigrationWorkspaces, normalizeWorkspaceForPartialize } from './normalizers'
import { test } from 'vitest'

test('normalizers', async () => {
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
  // resume without waiting on the async plugin catalog: the stamped
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

  // A standard workspace's agent keeps its durable resume identity across
  // partialize: the painted screen on disk is keyed by it.
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
  // survive partialize so the Git view + tab glyph still resolve after a restart.
  assert.deepEqual(
    normalizeWorkspaceForPartialize(baseWorkspace({ worktree: { branch: 'spike/parser', baseRef: 'main' } })).worktree,
    { branch: 'spike/parser', baseRef: 'main' },
    'worktree marker survives partialize',
  )
  assert.equal(
    normalizeWorkspaceForPartialize(baseWorkspace()).worktree,
    undefined,
    'absent worktree marker stays absent (no-op for existing workspaces)',
  )

  // dropRetiredModeWorkspaces — the `roadmap` (v65), `multiloop` (v66),
  // `guided-brief` (2026-09-08, the deleted Design Wizard), `reviews-host`
  // (v75, Reviews extracted to an installable module), `sprintengine` (the
  // in-tree engine's deletion) and `automations-host` (Automations replaced by
  // scheduled agents) workspace modes retired. Every list-entry path
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
    const moduleType = baseWorkspace({ id: 'ws-module', mode: 'weather-deck' })
    assert.deepEqual(
      dropRetiredModeWorkspaces([
        standard,
        roadmap,
        multiloop,
        guidedBrief,
        reviewsHost,
        retiredEngine,
        automationsHost,
        moduleType,
      ]).map((w) => w.id),
      ['ws-standard', 'ws-module'],
      'every retired-mode row is dropped, others kept in order',
    )
    const noRetired = [standard, moduleType]
    assert.equal(
      dropRetiredModeWorkspaces(noRetired),
      noRetired,
      'no retired-mode row → the exact input array is returned by reference (cheap no-op)',
    )
  }

  console.log('normalizers.test.ts: ok')
})
