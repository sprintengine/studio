import assert from 'node:assert/strict'
import type {
  GuidedBriefRuntimeState,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../../../types/workspace'
import {
  GuidedBriefScaffoldError,
  GuidedBriefStartBuildError,
  SprintEnginePlanSourcedError,
  SwitchboardControllerError,
  buildSprintEngineExistingTeamCreation,
  buildSprintEngineNewTeamCreation,
  buildStandardCreation,
  buildSwitchboardCreation,
  runGuidedBriefScaffold,
  runGuidedBriefStartBuild,
  runSprintEnginePlanSourcedCreation,
} from './index'
import type { GuidedBriefScaffoldPorts, GuidedBriefStartBuildPorts } from './types'

function createMemoryFilesystem(): GuidedBriefScaffoldPorts['filesystem'] & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    async ensureDir(parent, name) {
      const path = `${parent.replace(/\/+$/, '')}/${name}`
      dirs.add(path)
      return path
    },
    async readFile(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Missing file: ${path}`)
      return content
    },
    async writeFile(path, content) {
      files.set(path, content)
    },
  }
}

function fakeExistingTeam(): {
  slug: string
  displayName: string
  context: SprintEngineWorkspaceContext
  state: SprintEngineState
} {
  return {
    slug: 'interface-team',
    displayName: 'Interface Team',
    context: {
      teamName: 'Interface Team',
      teamSlug: 'interface-team',
      teamDirectoryPath: '/project/.multi-code/sprintengine/interface-team',
      statePath: '/project/.multi-code/sprintengine/interface-team/run.yaml',
    },
    state: {
      name: 'Interface Team',
      goal: 'Ship the interface',
      roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      sprintEngineAgents: {},
    } as unknown as SprintEngineState,
  }
}

function testBuildStandardCreation(): void {
  const args = buildStandardCreation({
    layoutId: 'unknown-layout-id',
    name: '  Project  ',
    folderPath: '/path',
  })
  assert.equal(args.name, 'Project', 'trims workspace name')
  assert.equal(args.folderPath, '/path')
  assert.ok(args.template, 'falls back to first layout template')
}

function testBuildSwitchboardCreation(): void {
  const args = buildSwitchboardCreation({ name: 'My SB', folderPath: '/p' })
  assert.equal(args.mode, 'switchboard')
  assert.equal(args.name, 'My SB')
  assert.equal(args.folderPath, '/p')

  const fallback = buildSwitchboardCreation({ name: '   ', folderPath: '/p' })
  assert.equal(fallback.name, 'Switchboard', 'falls back to Switchboard label when name is blank')

  assert.throws(
    () => buildSwitchboardCreation({ name: 'x', folderPath: null }),
    (error) => error instanceof SwitchboardControllerError && error.code === 'missing-folder',
    'throws when folder is missing',
  )
}

function testBuildSprintEngineExistingTeamCreation(): void {
  const team = fakeExistingTeam()
  const args = buildSprintEngineExistingTeamCreation({
    folderPath: '/project',
    existingTeam: team,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    agentCliOverrides: {},
    startRunner: true,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(args.name, team.displayName)
  assert.equal(args.sprintEngineContext, team.context)
  assert.ok(args.sprintEngineState, 'preserves the loaded state')
  assert.equal(args.sprintEngineAutoState?.desiredMode, 'run_agents')
  assert.equal(args.sprintEngineAutoState?.runtimeState, 'running')
  assert.equal(args.sprintEngineAutoState?.cliPermissionPreset, 'default')
  assert.equal(args.sprintEngineAutoState?.maxConcurrentAgents, 2, 'two agents in roleCounts')
}

function testBuildSprintEngineNewTeamCreation(): void {
  const args = buildSprintEngineNewTeamCreation({
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(args.name, 'Ship Squad')
  assert.equal(args.folderPath, '/p')
  assert.ok(args.sprintEngineContext, 'builds a sprintengine context when folder is present')
  assert.equal(args.sprintEngineAutoState?.desiredMode, 'manual')
  assert.equal(args.sprintEngineAutoState?.runtimeState, 'idle')
  assert.equal(args.sprintEngineAutoState?.maxConcurrentAgents, 2)
  assert.equal(args.sprintEngineRoleModelOverrides, null, 'no roster model overrides unless the wizard picked them')
  assert.equal(args.sprintEngineInitialSpawnRoles, null, 'no initial spawn roles unless the wizard marked them')

  const withLaunchIntent = buildSprintEngineNewTeamCreation({
    folderPath: '/p',
    teamName: 'Launch Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, product: 1, frontend: 1, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    totalAgents: 3,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'codex', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    roleModelOverrides: { frontend: 'model-a', product: null },
    initialSpawnRoles: ['frontend'],
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.deepEqual(withLaunchIntent.sprintEngineRoleModelOverrides, { frontend: 'model-a', product: null })
  assert.deepEqual(withLaunchIntent.sprintEngineInitialSpawnRoles, ['frontend'])

  const noFolder = buildSprintEngineNewTeamCreation({
    folderPath: null,
    teamName: 'Drift',
    goal: 'Ship',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(noFolder.sprintEngineContext, null, 'leaves context null when folder is absent')
}

async function testSprintEnginePlanSourcedValidation(): Promise<void> {
  const baseInput = {
    folderPath: null as string | null,
    teamName: 'Team',
    goal: 'goal',
    sourcePlanPath: 'plan.md',
    sourcePlanRelativePath: 'plan.md',
    sourcePlanContent: 'content',
    sourcePlanKind: 'unknown' as const,
    sourceBundle: null,
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' } as const,
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default' as const,
  }

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(baseInput, { pathExists: async () => false }),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'missing-folder',
    'missing folder',
  )

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p', sourcePlanPath: '', sourcePlanRelativePath: undefined },
      { pathExists: async () => true },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'missing-plan-option',
    'missing plan option',
  )

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p', sourcePlanContent: null },
      { pathExists: async () => true },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'missing-plan-content',
    'missing plan content',
  )

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p', teamName: '   ' },
      { pathExists: async () => true },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'missing-team-name',
    'missing team name',
  )

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p', goal: '   ' },
      { pathExists: async () => false },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'plan-not-on-disk',
    'empty goal is allowed and validation continues to the real source-file check',
  )

  // team-exists: the team statePath exists. pathExists(option.path) → true (source file)
  // AND pathExists(statePath) → true (team already exists).
  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p' },
      { pathExists: async () => true },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'team-exists',
    'team exists is mapped from underlying error',
  )
}

async function testSprintEnginePlanSourcedInitializesAndLinksBacklog(): Promise<void> {
  const events: string[] = []
  const links: Array<{ workspaceRoot: string; sourceRelativePath: string; teamSlug: string; statePath: string }> = []
  await runSprintEnginePlanSourcedCreation(
    {
      folderPath: '/p',
      teamName: 'Backlog Run',
      goal: 'Ship the backlog work',
      sourcePlanPath: '/p/backlog/plan.md',
      sourcePlanRelativePath: 'backlog/plan.md',
      sourcePlanContent: '# Plan',
      sourcePlanKind: 'architect_plan',
      sourceBundle: null,
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      totalAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      startRunner: false,
      autoApproveArtifacts: false,
      cliPermissionPreset: 'default',
    },
    {
      pathExists: async (path) => path === '/p/backlog/plan.md',
      initializeSprintEngineState: async (input) => {
        events.push(`init:${input.statePath}`)
        assert.equal(input.name, 'Backlog Run')
        assert.equal(input.goal, 'Ship the backlog work')
        assert.ok(input.agents.architect, 'initialization receives the roster agents')
        return { ok: true, data: {} }
      },
      recordBacklogExecutionLink: async (input) => {
        events.push(`link:${input.statePath}`)
        links.push(input)
      },
    },
  )

  assert.deepEqual(
    events,
    [
      'init:/p/.multi-code/sprintengine/backlog-run/run.yaml',
      'link:/p/.multi-code/sprintengine/backlog-run/run.yaml',
    ],
    'Backlog link is recorded after real Sprint Engine state initialization',
  )
  assert.deepEqual(links, [
    {
      workspaceRoot: '/p',
      sourceRelativePath: 'backlog/plan.md',
      teamSlug: 'backlog-run',
      statePath: '/p/.multi-code/sprintengine/backlog-run/run.yaml',
    },
  ])
}

async function testSprintEnginePlanSourcedWorktreeModeFlowsThroughStateAndPrompt(): Promise<void> {
  const initInputs: Array<{ useWorktrees?: boolean }> = []
  await runSprintEnginePlanSourcedCreation(
    {
      folderPath: '/p',
      teamName: 'Worktree Run',
      goal: 'Ship the worktree work',
      sourcePlanPath: '/p/backlog/worktree-plan.md',
      sourcePlanRelativePath: 'backlog/worktree-plan.md',
      sourcePlanContent: '# Plan',
      sourcePlanKind: 'architect_plan',
      sourceBundle: null,
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      totalAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      startRunner: false,
      autoApproveArtifacts: false,
      useWorktrees: true,
      cliPermissionPreset: 'default',
    },
    {
      pathExists: async (path) => path === '/p/backlog/worktree-plan.md',
      initializeSprintEngineState: async (input) => {
        initInputs.push({ useWorktrees: input.useWorktrees })
        return { ok: true, data: {} }
      },
    },
  )

  assert.deepEqual(initInputs, [{ useWorktrees: true }], 'creation-time init requests worktree mode')

  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
  const workspace = useWorkspaceStore.getState().workspaces.find((entry) => entry.sprintEngineContext?.teamSlug === 'worktree-run')
  assert.ok(workspace, 'plan-sourced creation stores the workspace')
  assert.equal(
    workspace.sprintEngineState?.useWorktrees,
    true,
    'worktree mode persists on workspace Sprint Engine state so the auto-run supervisor routes agents into the run worktree',
  )
  const architectPrompt = Object.values(workspace.agents).find((agent) => agent.cliStartupPrompt)?.cliStartupPrompt ?? ''
  assert.ok(
    architectPrompt.includes('"useWorktrees": true'),
    'architect handoff prompt carries worktree mode into the MCP init payload',
  )
}

async function testSprintEnginePlanSourcedSkipsNonBacklogLink(): Promise<void> {
  const events: string[] = []
  await runSprintEnginePlanSourcedCreation(
    {
      folderPath: '/p',
      teamName: 'Docs Run',
      goal: 'Ship the docs work',
      sourcePlanPath: '/p/docs/plan.md',
      sourcePlanRelativePath: 'docs/plan.md',
      sourcePlanContent: '# Plan',
      sourcePlanKind: 'architect_plan',
      sourceBundle: null,
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      totalAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      startRunner: false,
      autoApproveArtifacts: false,
      cliPermissionPreset: 'default',
    },
    {
      pathExists: async (path) => path === '/p/docs/plan.md',
      initializeSprintEngineState: async (input) => {
        events.push(`init:${input.statePath}`)
        return { ok: true, data: {} }
      },
      recordBacklogExecutionLink: async () => {
        events.push('link:unexpected')
      },
    },
  )

  assert.deepEqual(
    events,
    ['init:/p/.multi-code/sprintengine/docs-run/run.yaml'],
    'non-backlog plan sources initialize the run without recording a Backlog execution link',
  )
}

async function testGuidedBriefScaffoldValidation(): Promise<void> {
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: createMemoryFilesystem(),
  }

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: null, workspaceName: '', idea: 'idea', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-folder',
    'missing-folder',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: '', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-idea',
    'missing-idea',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: 'idea', hasUi: null, wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-has-ui',
    'missing-has-ui',
  )
}

async function testGuidedBriefScaffoldHappyPath(): Promise<void> {
  const fs = createMemoryFilesystem()
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: fs,
  }

  // Skip all discussions → initial stage is 'handoff', which causes
  // writeGuidedBriefBuildHandoff to fire via the fake filesystem.
  const { runtimeState } = await runGuidedBriefScaffold(
    {
      folderPath: '/workspace',
      workspaceName: 'My Brief',
      idea: 'A simple cli that summarizes invoices.',
      hasUi: 'no',
      wantsProduct: false,
      wantsArchitecture: false,
      wantsFrontend: false,
      guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
      buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      buildCliPermissionPreset: 'default',
      buildStartRunner: false,
      buildAutoApproveArtifacts: false,
    },
    ports,
  )

  assert.equal(runtimeState.stage, 'handoff', 'no-discussion path lands directly on handoff stage')
  assert.equal(runtimeState.workspaceRoot, '/workspace')
  assert.equal(runtimeState.hasUi, 'no')
  assert.equal(runtimeState.preset, 'full-brief', 'omitted preset defaults to full-brief')
  assert.equal(runtimeState.activeDesignArtifactPath, null)
  assert.ok(fs.files.has('/workspace/product/idea-seed.md'), 'idea seed is written by scaffold')
  assert.ok(fs.files.has('/workspace/product/build-handoff.md'), 'build handoff is written for the skipped path')
}

async function testGuidedBriefDesignPresetScaffold(): Promise<void> {
  const fs = createMemoryFilesystem()
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: fs,
  }

  // The frontend-design preset forces the design-only path: UI is implied even
  // when hasUi is null, the product/architecture discussion flags are ignored,
  // the frontend discussion is on, and the scaffold starts on designer-working
  // without writing a premature build handoff.
  const { runtimeState } = await runGuidedBriefScaffold(
    {
      folderPath: '/design',
      workspaceName: 'Studio',
      idea: 'A focused onboarding screen.',
      hasUi: null,
      preset: 'frontend-design',
      wantsProduct: true,
      wantsArchitecture: true,
      wantsFrontend: false,
      guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
      buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      buildCliPermissionPreset: 'default',
      buildStartRunner: false,
      buildAutoApproveArtifacts: false,
    },
    ports,
  )

  assert.equal(runtimeState.preset, 'frontend-design')
  assert.equal(runtimeState.hasUi, 'yes', 'design preset forces hasUi to yes')
  assert.equal(runtimeState.stage, 'designer-working', 'design preset starts on the designer stage')
  assert.equal(runtimeState.wantsProductDiscussion, false, 'design preset disables the product discussion')
  assert.equal(runtimeState.wantsArchitectureDiscussion, false, 'design preset disables the architecture discussion')
  assert.equal(runtimeState.wantsFrontendDiscussion, true, 'design preset enables the frontend discussion')
  assert.equal(runtimeState.activeDesignArtifactPath, null)
  assert.ok(fs.files.has('/design/product/idea-seed.md'), 'idea seed is written by scaffold')
  assert.ok(!fs.files.has('/design/product/build-handoff.md'), 'design preset does not write a premature handoff')
}

async function testGuidedBriefStartBuildValidation(): Promise<void> {
  const baseRuntime: GuidedBriefRuntimeState = {
    workspaceRoot: '/workspace',
    workspaceName: 'Brief',
    idea: 'Trade shifts',
    hasUi: 'yes',
    wantsProductDiscussion: true,
    wantsArchitectureDiscussion: true,
    wantsFrontendDiscussion: true,
    guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    buildCliPermissionPreset: 'default',
    buildStartRunner: false,
    buildAutoApproveArtifacts: false,
    stage: 'handoff',
    acceptedProductBrief: null,
    acceptedArchitecturePlan: null,
    acceptedUiDirection: null,
    acceptedMockups: [],
    activeMockupPath: null,
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }

  const ports: GuidedBriefStartBuildPorts = {
    filesystem: createMemoryFilesystem(),
    pathExists: async () => false,
    readArchitecturePlan: async () => '',
    readBuildHandoff: async () => '',
  }

  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState: baseRuntime,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: baseRuntime.buildRoleCounts, roleCliDefaults: baseRuntime.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: baseRuntime.buildRoleCounts,
        rosterSummary: [],
        planningDecisions: [],
        planningValidationNotes: [],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) => error instanceof GuidedBriefStartBuildError && error.code === 'missing-product-brief',
    'missing-product-brief',
  )

  const withBrief: GuidedBriefRuntimeState = {
    ...baseRuntime,
    acceptedProductBrief: { kind: 'product', title: 'Brief', hash: 'h', path: 'product/.versions/h.md' },
  }
  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState: withBrief,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: withBrief.buildRoleCounts, roleCliDefaults: withBrief.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: withBrief.buildRoleCounts,
        rosterSummary: [],
        planningDecisions: [],
        planningValidationNotes: [],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) => error instanceof GuidedBriefStartBuildError && error.code === 'missing-architecture-plan',
    'missing-architecture-plan',
  )

  const withBriefAndPlan: GuidedBriefRuntimeState = {
    ...withBrief,
    acceptedArchitecturePlan: { kind: 'product', title: 'Arch', hash: 'a', path: 'product/.versions/a.md' },
  }
  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState: withBriefAndPlan,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: withBriefAndPlan.buildRoleCounts, roleCliDefaults: withBriefAndPlan.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: withBriefAndPlan.buildRoleCounts,
        rosterSummary: [],
        planningDecisions: [],
        planningValidationNotes: [],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) => error instanceof GuidedBriefStartBuildError && error.code === 'missing-ui-direction-or-mockups',
    'missing-ui-direction-or-mockups (UI required but no direction/mockups)',
  )
}

async function testGuidedBriefStartBuildHandoffPath(): Promise<void> {
  // Configure the runtime so validation passes and the controller proceeds to
  // write the handoff. Force createPlanSourcedSprintEngineWorkspace to bail at
  // its pathExists check by reporting that the team's state file already exists
  // — the team-exists mapping is the assertion target. The handoff still gets
  // written through the fake filesystem before we abort, which lets us
  // verify the bundle assembly and goal selection.
  const fs = createMemoryFilesystem()
  fs.files.set(
    '/workspace/product/build-handoff.md',
    '## Suggested Sprint Engine Goal\n\nDeliver the accepted brief.\n',
  )
  const artifactReads: string[] = []
  let buildHandoffRead = false
  const ports: GuidedBriefStartBuildPorts = {
    filesystem: fs,
    pathExists: async () => true, // makes createPlanSourcedSprintEngineWorkspace throw team-exists
    readArchitecturePlan: async (_workspaceRoot, path) => {
      artifactReads.push(path)
      return `# Artifact\n\n${path}\n`
    },
    readBuildHandoff: async (workspaceRoot, path) => {
      buildHandoffRead = true
      return fs.files.get(`${workspaceRoot}/${path}`) ?? ''
    },
  }

  const runtimeState: GuidedBriefRuntimeState = {
    workspaceRoot: '/workspace',
    workspaceName: 'Brief',
    idea: 'Trade shifts',
    hasUi: 'yes',
    wantsProductDiscussion: true,
    wantsArchitectureDiscussion: true,
    wantsFrontendDiscussion: true,
    guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    buildCliPermissionPreset: 'default',
    buildStartRunner: false,
    buildAutoApproveArtifacts: false,
    stage: 'handoff',
    acceptedProductBrief: { kind: 'product', title: 'Brief', hash: 'h', path: 'product/.versions/h.md' },
    acceptedArchitecturePlan: { kind: 'product', title: 'Arch', hash: 'a', path: 'product/.versions/a.md' },
    acceptedUiDirection: { kind: 'product', title: 'UI', hash: 'u', path: 'product/.versions/u.md' },
    acceptedMockups: [{ kind: 'mockup', title: 'Mock', hash: 'm', path: 'mockups/.versions/m.html' }],
    activeMockupPath: null,
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }

  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: runtimeState.buildRoleCounts, roleCliDefaults: runtimeState.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: runtimeState.buildRoleCounts,
        rosterSummary: ['product: 1', 'architect: 1'],
        planningDecisions: ['Application includes a visual UI.'],
        planningValidationNotes: ['Validate against accepted artifacts.'],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) => error instanceof GuidedBriefStartBuildError && error.code === 'team-exists',
    'team-exists is mapped from createPlanSourcedSprintEngineWorkspace error',
  )

  // The controller writes the handoff before reaching the team-exists guard,
  // and reads the architecture plan + handoff content while assembling the
  // source bundle.
  assert.ok(buildHandoffRead, 'handoff content was read via the injected port')
  assert.deepEqual(
    artifactReads,
    ['product/.versions/h.md', 'product/.versions/a.md', 'product/.versions/u.md', 'mockups/.versions/m.html'],
    'all accepted artifacts were read for the source bundle',
  )
  // The handoff file gets rewritten through the filesystem port. Confirm a
  // build-handoff body was emitted under the workspace root.
  const writtenHandoff = fs.files.get('/workspace/product/build-handoff.md')
  assert.ok(writtenHandoff, 'handoff file is present')
  assert.match(writtenHandoff ?? '', /## Suggested Sprint Engine Goal/, 'handoff body contains the goal section')
}

async function testGuidedBriefStartBuildDesignPresetHandoff(): Promise<void> {
  const fs = createMemoryFilesystem()
  const artifactReads: string[] = []
  let sourceBundleKinds: string[] = []
  let sourceBundlePaths: string[] = []
  let handoffContent = ''

  const runtimeState: GuidedBriefRuntimeState = {
    workspaceRoot: '/design',
    workspaceName: 'Studio',
    idea: 'A focused onboarding screen.',
    hasUi: 'yes',
    preset: 'frontend-design',
    wantsProductDiscussion: false,
    wantsArchitectureDiscussion: false,
    wantsFrontendDiscussion: true,
    guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', code_reviewer: 'claude-code', spec_reviewer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    buildCliPermissionPreset: 'default',
    buildStartRunner: false,
    buildAutoApproveArtifacts: false,
    stage: 'handoff',
    acceptedProductBrief: null,
    acceptedArchitecturePlan: null,
    acceptedUiDirection: { kind: 'product', title: 'UI direction', hash: 'u', path: 'product/.versions/u.md' },
    acceptedMockups: [{ kind: 'mockup', title: 'Onboarding mockup', hash: 'm', path: 'mockups/.versions/m.html' }],
    activeMockupPath: 'mockups/.versions/m.html',
    activeDesignArtifactPath: 'mockups/.versions/m.html',
    strategistSessionId: null,
    architectSessionId: null,
    designerSessionId: null,
  }

  const ports: GuidedBriefStartBuildPorts = {
    filesystem: fs,
    pathExists: async () => false,
    readArchitecturePlan: async (_workspaceRoot, path) => {
      artifactReads.push(path)
      return `# Artifact\n\n${path}\n`
    },
    readBuildHandoff: async (workspaceRoot, path) => fs.files.get(`${workspaceRoot}/${path}`) ?? '',
    createPlanSourcedSprintEngineWorkspace: async (args) => {
      sourceBundleKinds = args.sourceBundle?.map((item) => item.kind) ?? []
      sourceBundlePaths = args.sourceBundle?.map((item) => item.sourceRelativePath) ?? []
      handoffContent = args.sourceContent
      return {
        workspaceId: 'workspace-id',
        sprintEngineContext: {
          teamName: 'Studio Build',
          teamSlug: 'studio-build',
          teamDirectoryPath: '/design/.multi-code/sprintengine/studio-build',
          statePath: '/design/.multi-code/sprintengine/studio-build/run.yaml',
        },
        architectAgentId: 'architect-1',
      }
    },
  }

  await runGuidedBriefStartBuild(
    {
      runtimeState,
      runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: runtimeState.buildRoleCounts, roleCliDefaults: runtimeState.buildRoleCliDefaults, cliPermissionPreset: 'default' },
      finalRoleCounts: runtimeState.buildRoleCounts,
      rosterSummary: ['frontend: 1', 'developer: 1'],
      planningDecisions: ['Application includes a visual UI.'],
      planningValidationNotes: ['Validate against accepted design artifacts.'],
      buildHandoffRelativePath: 'product/build-handoff.md',
    },
    ports,
  )

  assert.ok(fs.files.has('/design/product/build-handoff.md'), 'design preset start-build writes the real handoff file')
  assert.match(handoffContent, /Product brief: not requested/, 'design preset handoff records skipped product discussion')
  assert.match(handoffContent, /UI direction: `product\/\.versions\/u\.md` \(u\)/, 'design preset handoff records accepted UI direction')
  assert.match(handoffContent, /Onboarding mockup: `mockups\/\.versions\/m\.html` \(m\)/, 'design preset handoff records accepted mockup')
  assert.deepEqual(
    sourceBundleKinds,
    ['product_plan', 'design_notes', 'html_mockup'],
    'design preset source bundle contains handoff, design notes, and html mockup only',
  )
  assert.deepEqual(
    sourceBundlePaths,
    ['product/build-handoff.md', 'product/.versions/u.md', 'mockups/.versions/m.html'],
    'design preset source bundle keeps workspace-relative paths',
  )
  assert.deepEqual(
    artifactReads,
    ['product/.versions/u.md', 'mockups/.versions/m.html'],
    'design preset start-build does not require product or architecture snapshots',
  )
}

async function main(): Promise<void> {
  testBuildStandardCreation()
  testBuildSwitchboardCreation()
  testBuildSprintEngineExistingTeamCreation()
  testBuildSprintEngineNewTeamCreation()
  await testSprintEnginePlanSourcedValidation()
  await testSprintEnginePlanSourcedInitializesAndLinksBacklog()
  await testSprintEnginePlanSourcedWorktreeModeFlowsThroughStateAndPrompt()
  await testSprintEnginePlanSourcedSkipsNonBacklogLink()
  await testGuidedBriefScaffoldValidation()
  await testGuidedBriefScaffoldHappyPath()
  await testGuidedBriefDesignPresetScaffold()
  await testGuidedBriefStartBuildValidation()
  await testGuidedBriefStartBuildHandoffPath()
  await testGuidedBriefStartBuildDesignPresetHandoff()
  console.log('newWorkspace controllers.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
