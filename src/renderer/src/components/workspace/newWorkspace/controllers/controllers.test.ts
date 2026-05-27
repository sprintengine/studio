import assert from 'node:assert/strict'
import type {
  GuidedBriefRuntimeState,
  LayoutTemplate,
  SprintEngineState,
  SprintEngineWorkspaceContext,
  WorkspaceId,
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

function fakeTemplate(id = 'guided-template'): LayoutTemplate {
  return { id, name: 'Fake', description: 'fake', layout: { global: {}, layout: { type: 'row', weight: 100, children: [] } } } as unknown as LayoutTemplate
}

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
      roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
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
    roleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
    agentCliOverrides: {},
    startRunner: true,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(args.name, team.displayName)
  assert.equal(args.sprintEngineContext, team.context)
  assert.ok(args.sprintEngineState, 'preserves the loaded state')
  assert.equal(args.sprintEngineAutoState?.enabled, true)
  assert.equal(args.sprintEngineAutoState?.autoApproveArtifacts, false)
  assert.equal(args.sprintEngineAutoState?.cliPermissionPreset, 'default')
  assert.equal(args.sprintEngineAutoState?.maxConcurrentAgents, 2, 'two agents in roleCounts')
}

function testBuildSprintEngineNewTeamCreation(): void {
  const args = buildSprintEngineNewTeamCreation({
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(args.name, 'Ship Squad')
  assert.equal(args.folderPath, '/p')
  assert.ok(args.sprintEngineContext, 'builds a sprintengine context when folder is present')
  assert.equal(args.sprintEngineAutoState?.maxConcurrentAgents, 2)

  const noFolder = buildSprintEngineNewTeamCreation({
    folderPath: null,
    teamName: 'Drift',
    goal: 'Ship',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
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
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
    totalAgents: 2,
    roleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' } as const,
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
      { pathExists: async () => true },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'missing-goal',
    'missing goal',
  )

  await assert.rejects(
    () => runSprintEnginePlanSourcedCreation(
      { ...baseInput, folderPath: '/p' },
      { pathExists: async () => false },
    ),
    (error) => error instanceof SprintEnginePlanSourcedError && error.code === 'plan-not-on-disk',
    'plan not on disk',
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

async function testGuidedBriefScaffoldValidation(): Promise<void> {
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: createMemoryFilesystem(),
    addWorkspace: () => 'ws-1' as WorkspaceId,
    createGuidedBriefTemplate: () => fakeTemplate(),
  }

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: null, workspaceName: '', idea: 'idea', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-folder',
    'missing-folder',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: '', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-idea',
    'missing-idea',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: 'idea', hasUi: null, wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-has-ui',
    'missing-has-ui',
  )
}

async function testGuidedBriefScaffoldHappyPath(): Promise<void> {
  const fs = createMemoryFilesystem()
  let addedWorkspaceArgs: { template?: LayoutTemplate; options?: unknown } | null = null
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: fs,
    addWorkspace: (template, options) => {
      addedWorkspaceArgs = { template, options }
      return 'ws-1' as WorkspaceId
    },
    createGuidedBriefTemplate: () => fakeTemplate('guided-template'),
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
      guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' },
      buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, code_reviewer: 0, spec_reviewer: 0, performance: 0, tester: 0, security: 0 },
      buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
      buildCliPermissionPreset: 'default',
      buildStartRunner: false,
      buildAutoApproveArtifacts: false,
    },
    ports,
  )

  assert.equal(runtimeState.stage, 'handoff', 'no-discussion path lands directly on handoff stage')
  assert.equal(runtimeState.workspaceRoot, '/workspace')
  assert.equal(runtimeState.hasUi, 'no')
  assert.ok(fs.files.has('/workspace/product/idea-seed.md'), 'idea seed is written by scaffold')
  assert.ok(fs.files.has('/workspace/product/build-handoff.md'), 'build handoff is written for the skipped path')
  assert.ok(addedWorkspaceArgs, 'addWorkspace port was invoked')
  // @ts-expect-error narrowing the captured args for assertions
  assert.equal(addedWorkspaceArgs?.options?.mode, 'guided-brief')
  // @ts-expect-error narrowing the captured args for assertions
  assert.equal(addedWorkspaceArgs?.options?.folderPath, '/workspace')
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
    guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
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
    acceptedProductBrief: { title: 'Brief', hash: 'h', path: 'product/.versions/h.md' },
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
    acceptedArchitecturePlan: { title: 'Arch', hash: 'a', path: 'product/.versions/a.md' },
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
  let architectureRead = false
  let buildHandoffRead = false
  const ports: GuidedBriefStartBuildPorts = {
    filesystem: fs,
    pathExists: async () => true, // makes createPlanSourcedSprintEngineWorkspace throw team-exists
    readArchitecturePlan: async () => {
      architectureRead = true
      return '# Architecture\n\nDetails.\n'
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
    guidedRoleCliDefaults: { product: 'claude', architect: 'claude', frontend: 'claude' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, code_reviewer: 1, spec_reviewer: 1, performance: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude', product: 'claude', frontend: 'claude', developer: 'claude', code_reviewer: 'claude', spec_reviewer: 'claude', performance: 'claude', tester: 'claude', security: 'claude' },
    buildCliPermissionPreset: 'default',
    buildStartRunner: false,
    buildAutoApproveArtifacts: false,
    stage: 'handoff',
    acceptedProductBrief: { title: 'Brief', hash: 'h', path: 'product/.versions/h.md' },
    acceptedArchitecturePlan: { title: 'Arch', hash: 'a', path: 'product/.versions/a.md' },
    acceptedUiDirection: { title: 'UI', hash: 'u', path: 'product/.versions/u.md' },
    acceptedMockups: [{ title: 'Mock', hash: 'm', path: 'mockups/.versions/m.html' }],
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
  assert.ok(architectureRead, 'architecture plan was read for the source bundle')
  // The handoff file gets rewritten through the filesystem port. Confirm a
  // build-handoff body was emitted under the workspace root.
  const writtenHandoff = fs.files.get('/workspace/product/build-handoff.md')
  assert.ok(writtenHandoff, 'handoff file is present')
  assert.match(writtenHandoff ?? '', /## Suggested Sprint Engine Goal/, 'handoff body contains the goal section')
}

async function main(): Promise<void> {
  testBuildStandardCreation()
  testBuildSwitchboardCreation()
  testBuildSprintEngineExistingTeamCreation()
  testBuildSprintEngineNewTeamCreation()
  await testSprintEnginePlanSourcedValidation()
  await testGuidedBriefScaffoldValidation()
  await testGuidedBriefScaffoldHappyPath()
  await testGuidedBriefStartBuildValidation()
  await testGuidedBriefStartBuildHandoffPath()
  console.log('newWorkspace controllers.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
