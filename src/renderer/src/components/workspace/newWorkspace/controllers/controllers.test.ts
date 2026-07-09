import assert from 'node:assert/strict'
import type {
  GuidedBriefRuntimeState,
  SprintEngineState,
  SprintEngineWorkspaceContext,
} from '../../../../types/workspace'
import {
  DesignSystemScaffoldError,
  GuidedBriefScaffoldError,
  GuidedBriefStartBuildError,
  ModuleTypeControllerError,
  SprintEngineNewTeamCreationError,
  SprintEnginePlanSourcedError,
  SwitchboardControllerError,
  buildModuleTypeCreation,
  buildSprintEngineEffectiveSpawnAtStartRoles,
  buildSprintEngineExistingTeamCreation,
  buildSprintEngineNewTeamCreation,
  buildStandardCreation,
  buildSwitchboardCreation,
  runDesignSystemScaffold,
  runGuidedBriefScaffold,
  runGuidedBriefStartBuild,
  runSprintEngineNewTeamCreation,
  runSprintEnginePlanSourcedCreation,
} from './index'
import { getRendererHost } from '../../../../modules'
import { buildSprintEngineWorkflowInitKeys } from '../sprintengineWorkflowConfig'
import type { GuidedBriefScaffoldPorts, GuidedBriefStartBuildPorts } from './types'
import type { SprintEngineStateInitializeInput } from '../../../../../../shared/electron-api'

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

// Scaffold-baseline discovery fake (MC-1502): `entries` maps a directory path
// to its listing; `stats` maps a file path to its mtime/size. An empty
// discovery models a fresh empty folder.
function createDiscovery(
  entries: Record<string, { name: string; isDir: boolean }[]> = {},
  stats: Record<string, { modifiedAtMs: number; sizeBytes: number }> = {},
): GuidedBriefScaffoldPorts['discovery'] {
  return {
    readdir: async (path) => entries[path] ?? [],
    pathExists: async (path) => path in stats,
    statPath: async (path) => {
      const stat = stats[path]
      if (!stat) throw new Error(`Missing stat: ${path}`)
      return { modifiedAt: new Date(stat.modifiedAtMs).toISOString(), ...stat }
    },
  }
}

function sprintEngineProjectionFixture(input: {
  name: string
  goal: string
  roster?: Record<string, { role: string; status?: string; currentTaskId?: string | null }>
  tasks?: Array<Record<string, unknown>>
}): Record<string, unknown> {
  return {
    ok: true,
    projectionVersion: 1,
    source: 'folder_store',
    generatedAt: '2026-06-16T11:00:00Z',
    updatedAt: '2026-06-16T11:00:00Z',
    run: {
      id: 'run-id',
      name: input.name,
      goal: input.goal,
      status: 'planning',
      rosterConfigured: true,
      updatedAt: '2026-06-16T11:00:00Z',
    },
    roster: input.roster ?? {
      architect: { role: 'architect', status: 'idle', currentTaskId: null },
      product: { role: 'product', status: 'idle', currentTaskId: null },
    },
    tasks: input.tasks ?? [
      {
        id: 'T1',
        title: 'Review product intake',
        description: '',
        role: 'product',
        status: 'ready',
        boardColumn: 'ready',
        ownedPaths: [],
        dependsOn: [],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        activity: [],
        startedAt: null,
        completedAt: null,
        ownerAgentId: null,
      },
      {
        id: 'T2',
        title: 'Write implementation plan',
        description: '',
        role: 'architect',
        status: 'todo',
        boardColumn: 'todo',
        ownedPaths: [],
        dependsOn: ['T1'],
        acceptanceCriteria: [],
        implementationNotes: [],
        notes: [],
        comments: [],
        evidence: { summary: '', touchedFiles: [], commandsRan: [], results: [] },
        activity: [],
        startedAt: null,
        completedAt: null,
        ownerAgentId: null,
      },
    ],
    artifacts: [],
    activity: [],
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
      roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
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

function testBuildModuleTypeCreation(): void {
  // Module-contributed types (no shell controller) create from the registered
  // definition's createTemplate(). Register a fake third-party type the way
  // the third-party loader does — through the kernel's hostFor scope.
  getRendererHost()
    .hostFor('controller-test-module')
    .registerWorkspaceType({
      id: 'controller-test-module',
      label: 'Controller Test',
      description: 'Module type used by controller tests.',
      icon: () => null,
      createTemplate: () => ({
        id: 'controller-test-template',
        name: 'Controller Test',
        description: 'test',
        previewSlots: [],
        layout: { layout: { type: 'row', children: [] } },
      }),
    })

  const args = buildModuleTypeCreation({ mode: 'controller-test-module', name: '  Cal  ', folderPath: '/p' })
  assert.equal(args.mode, 'controller-test-module')
  assert.equal(args.name, 'Cal', 'trims workspace name')
  assert.equal(args.template.id, 'controller-test-template', 'uses the registered createTemplate()')

  const fallback = buildModuleTypeCreation({ mode: 'controller-test-module', name: '   ', folderPath: '/p' })
  assert.equal(fallback.name, 'Controller Test', 'falls back to the type label when name is blank')

  assert.throws(
    () => buildModuleTypeCreation({ mode: 'controller-test-module', name: 'x', folderPath: null }),
    (error) => error instanceof ModuleTypeControllerError && error.code === 'missing-folder',
    'throws when folder is missing'
  )
  assert.throws(
    () => buildModuleTypeCreation({ mode: 'never-registered-mode', name: 'x', folderPath: '/p' }),
    (error) => error instanceof ModuleTypeControllerError && error.code === 'unknown-type',
    'throws for an unregistered mode'
  )
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
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
  assert.equal(
    args.sprintEngineAutoState?.maxConcurrentAgents,
    3,
    'ceiling is the default knob value, never derived from roster size (MC-1450)',
  )
}

function testBuildSprintEngineNewTeamCreation(): void {
  const args = buildSprintEngineNewTeamCreation({
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
    roleCounts: { architect: 1, product: 1, frontend: 1, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    maxParallelAgents: 3,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'codex', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default',
  })
  assert.equal(noFolder.sprintEngineContext, null, 'leaves context null when folder is absent')
}

async function testSprintEngineNewTeamInitializesRunState(): Promise<void> {
  const initInputs: Array<{ statePath: string; name: string; goal: string; agentIds: string[]; useWorktrees?: boolean }> = []
  const args = await runSprintEngineNewTeamCreation(
    {
      folderPath: '/p',
      teamName: 'Ship Squad',
      goal: 'Ship the things',
      roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      initialSpawnRoles: ['architect'],
      startRunner: true,
      autoApproveArtifacts: false,
      useWorktrees: true,
      cliPermissionPreset: 'default',
    },
    {
      pathExists: async () => false,
      initializeSprintEngineState: async (input) => {
        initInputs.push({
          statePath: input.statePath,
          name: input.name,
          goal: input.goal,
          agentIds: Object.keys(input.agents),
          useWorktrees: input.useWorktrees,
        })
        return {
          ok: true,
          data: {
            projectionContent: JSON.stringify(sprintEngineProjectionFixture({
              name: 'Ship Squad',
              goal: 'Ship the things',
            })),
          },
        }
      },
    },
  )

  assert.deepEqual(initInputs, [
    {
      statePath: '/p/.multi-code/sprintengine/ship-squad/run.yaml',
      name: 'Ship Squad',
      goal: 'Ship the things',
      // Lazy roster: init receives only the architect seat; enabled worker roles
      // ride enabledRoles -> configuredRoles, and worker ids mint on demand.
      agentIds: ['architect'],
      useWorktrees: true,
    },
  ])
  assert.equal(args.sprintEngineContext?.statePath, '/p/.multi-code/sprintengine/ship-squad/run.yaml')
  assert.equal(args.sprintEngineState?.projection?.source, 'folder_store')
  assert.equal(args.sprintEngineState?.tasks.length, 2, 'workspace opens with the initialized task graph')
  assert.deepEqual(args.sprintEngineInitialSpawnRoles, ['architect'])
  assert.equal(args.sprintEngineAutoState?.desiredMode, 'run_agents')
}

// The full-roster (user-mode) init must be untouched by the new fields: no
// rosterSource/allowedRuntimes flags, and roleRuntimes still built from every
// role's cli/model. Regression guard for "rosterSource: 'user' is byte-identical".
async function testSprintEngineNewTeamUserModeInitArgsUnchanged(): Promise<void> {
  const captured: Array<Record<string, unknown>> = []
  await runSprintEngineNewTeamCreation(
    {
      folderPath: '/p',
      teamName: 'Ship Squad',
      goal: 'Ship the things',
      roleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      visibleRoleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', developer: 'codex', frontend: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code', product: 'claude-code' },
      roleModelOverrides: { developer: 'gpt-5.5-codex' },
      startRunner: false,
      autoApproveArtifacts: false,
      cliPermissionPreset: 'default',
    },
    {
      pathExists: async () => false,
      initializeSprintEngineState: async (input) => {
        captured.push({
          roleRuntimes: input.roleRuntimes,
          enabledRoles: input.enabledRoles,
          rosterSource: input.rosterSource,
          allowedRuntimes: input.allowedRuntimes,
          defaultPhases: input.defaultPhases,
          requiredSweeps: input.requiredSweeps,
          phaseRuntimes: input.phaseRuntimes,
        })
        return { ok: true, data: { projectionContent: JSON.stringify(sprintEngineProjectionFixture({ name: 'Ship Squad', goal: 'Ship the things' })) } }
      },
    },
  )
  assert.equal(captured.length, 1)
  const init = captured[0]
  assert.equal(init.rosterSource, undefined, 'user mode sends no roster-source flag')
  assert.equal(init.allowedRuntimes, undefined, 'user mode sends no allowed-runtimes flag')
  // Workflow-panel keys are absent when the wizard passes no workflow input, so a
  // plain run stays byte-identical to a pre-panel run (MC-1542 / MC-1543).
  assert.equal(init.defaultPhases, undefined, 'no defaultPhases when self-review stays on')
  assert.equal(init.requiredSweeps, undefined, 'no requiredSweeps when none are mandated')
  assert.equal(init.phaseRuntimes, undefined, 'no phaseRuntimes when the same agent reviews')
  assert.deepEqual(init.enabledRoles, ['architect', 'developer'], 'enabled roles derive from the roster')
  // roleRuntimes is built from the full role-cli-defaults map (unchanged
  // behavior): every role's cli/model, not just the enabled ones.
  const roleRuntimes = init.roleRuntimes as Record<string, { model?: string | null; cli?: string | null }>
  assert.deepEqual(roleRuntimes.architect, { model: null, cli: 'claude-code' })
  assert.deepEqual(roleRuntimes.developer, { model: 'gpt-5.5-codex', cli: 'codex' })
}

// AC1: an architect-roster run inits with configuredRoles=['architect'],
// rosterSource: 'architect', roleRuntimes pinning only the architect seat, and
// allowedRuntimes = exactly the ticked palette. Asserted at the init-args layer.
async function testSprintEngineArchitectRosterInitArgs(): Promise<void> {
  const captured: Array<Record<string, unknown>> = []
  const args = await runSprintEngineNewTeamCreation(
    {
      folderPath: '/p',
      teamName: 'Ship Squad',
      goal: 'Ship the things',
      // Architect mode: the wizard collapses the roster to the architect seat.
      roleCounts: { architect: 1, developer: 0, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      visibleRoleCounts: { architect: 1, developer: 0, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      maxParallelAgents: 2,
      // Full defaults are still passed but must be ignored in architect mode.
      roleCliDefaults: { architect: 'claude-code', developer: 'codex', frontend: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code', product: 'claude-code' },
      roleModelOverrides: { developer: 'gpt-5.5-codex' },
      initialSpawnRoles: ['architect'],
      startRunner: true,
      autoApproveArtifacts: false,
      cliPermissionPreset: 'default',
      rosterSource: 'architect',
      architectSeat: { cli: 'claude-code', model: 'claude-fable-5' },
      allowedRuntimes: [
        { cli: 'claude-code', model: 'claude-opus-4-8' },
        { cli: 'zai', model: null },
      ],
      architectGuidance: '  Quality matters  ',
    },
    {
      pathExists: async () => false,
      initializeSprintEngineState: async (input) => {
        captured.push({
          roleRuntimes: input.roleRuntimes,
          enabledRoles: input.enabledRoles,
          rosterSource: input.rosterSource,
          allowedRuntimes: input.allowedRuntimes,
          agentIds: Object.keys(input.agents),
        })
        return { ok: true, data: { projectionContent: JSON.stringify(sprintEngineProjectionFixture({ name: 'Ship Squad', goal: 'Ship the things' })) } }
      },
    },
  )
  assert.equal(captured.length, 1)
  const init = captured[0]
  assert.deepEqual(init.agentIds, ['architect'], 'only the architect is seated at init')
  assert.deepEqual(init.enabledRoles, ['architect'], 'configuredRoles collapse to the architect')
  assert.equal(init.rosterSource, 'architect')
  assert.deepEqual(
    init.roleRuntimes,
    { architect: { cli: 'claude-code', model: 'claude-fable-5' } },
    'only the architect seat is pinned — the full role defaults are ignored',
  )
  assert.deepEqual(
    init.allowedRuntimes,
    [{ cli: 'claude-code', model: 'claude-opus-4-8' }, { cli: 'zai', model: null }],
    'allowedRuntimes is exactly the ticked palette',
  )
  // Guidance rides prompt-only auto state (trimmed), never the engine init.
  assert.equal(args.sprintEngineAutoState?.architectGuidance, 'Quality matters')
}

// The "Workflow steps" + "Final sweeps" panels map to the three run-level init
// keys. Default state (self-review on, same-agent reviewer, no mandated sweeps)
// omits all three; each divergence populates exactly its key.
function testSprintEngineWorkflowInitKeys(): void {
  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: true,
      reviewRuntime: null,
      requiredSweepRoleIds: [],
    }),
    {},
    'defaults omit all three keys (byte-identical plain run)',
  )

  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: false,
      reviewRuntime: null,
      requiredSweepRoleIds: [],
    }),
    { defaultPhases: [] },
    'self-review off records the empty phase set',
  )

  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: true,
      reviewRuntime: { cli: 'claude-code', model: 'claude-fable-5' },
      requiredSweepRoleIds: [],
    }),
    { phaseRuntimes: { review: { cli: 'claude-code', model: 'claude-fable-5' } } },
    'a stronger reviewer binds phaseRuntimes.review',
  )

  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: false,
      reviewRuntime: { cli: 'claude-code', model: 'claude-fable-5' },
      requiredSweepRoleIds: [],
    }),
    { defaultPhases: [] },
    'a reviewer binding is ignored when self-review is off (no review phase runs)',
  )

  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: true,
      reviewRuntime: null,
      requiredSweepRoleIds: ['tester', 'security', 'tester', '  '],
    }),
    { requiredSweeps: ['tester', 'security'] },
    'mandated sweeps de-duplicate and drop blanks, display order preserved',
  )

  assert.deepEqual(
    buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: false,
      reviewRuntime: { cli: 'zai', model: null },
      requiredSweepRoleIds: ['ui_ux_reviewer'],
    }),
    { defaultPhases: [], requiredSweeps: ['ui_ux_reviewer'] },
    'divergent keys compose; reviewer binding still gated by self-review',
  )
}

// The controller forwards the pre-computed workflow keys verbatim into the run
// init, and forwards nothing when the wizard sets none.
async function testSprintEngineWorkflowKeysFlowToInit(): Promise<void> {
  const baseInput = {
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
    visibleRoleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code' as const, developer: 'claude-code' as const, frontend: 'claude-code' as const, performance: 'claude-code' as const, cross_platform: 'claude-code' as const, tester: 'claude-code' as const, security: 'claude-code' as const, product: 'claude-code' as const },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default' as const,
  }
  const captureInit = (bucket: Array<Record<string, unknown>>) => async (input: SprintEngineStateInitializeInput) => {
    bucket.push({
      defaultPhases: input.defaultPhases,
      requiredSweeps: input.requiredSweeps,
      phaseRuntimes: input.phaseRuntimes,
    })
    return { ok: true as const, data: { projectionContent: JSON.stringify(sprintEngineProjectionFixture({ name: 'Ship Squad', goal: 'Ship the things' })) } }
  }

  const populated: Array<Record<string, unknown>> = []
  await runSprintEngineNewTeamCreation(
    {
      ...baseInput,
      defaultPhases: [],
      requiredSweeps: ['tester'],
      phaseRuntimes: { review: { cli: 'claude-code', model: 'claude-fable-5' } },
    },
    { pathExists: async () => false, initializeSprintEngineState: captureInit(populated) },
  )
  assert.equal(populated.length, 1)
  assert.deepEqual(populated[0].defaultPhases, [], 'defaultPhases forwarded')
  assert.deepEqual(populated[0].requiredSweeps, ['tester'], 'requiredSweeps forwarded')
  assert.deepEqual(populated[0].phaseRuntimes, { review: { cli: 'claude-code', model: 'claude-fable-5' } }, 'phaseRuntimes forwarded')

  const omitted: Array<Record<string, unknown>> = []
  await runSprintEngineNewTeamCreation(
    baseInput,
    { pathExists: async () => false, initializeSprintEngineState: captureInit(omitted) },
  )
  assert.equal(omitted.length, 1)
  assert.equal(omitted[0].defaultPhases, undefined, 'no defaultPhases key when the wizard sets none')
  assert.equal(omitted[0].requiredSweeps, undefined, 'no requiredSweeps key when the wizard sets none')
  assert.equal(omitted[0].phaseRuntimes, undefined, 'no phaseRuntimes key when the wizard sets none')
}

// MC-1542 "Work types & models" panel: sweep roles are no longer offered as
// seats, so the wizard forwards them via additionalEnabledRoles and they merge
// (de-duplicated) into enabledRoles -> configuredRoles. Architect mode still
// collapses to ['architect'] — the architect grows roles via roster.configure.
async function testSprintEngineAdditionalEnabledRolesMergeIntoInit(): Promise<void> {
  const baseInput = {
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
    visibleRoleCounts: { architect: 1, developer: 1, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code' as const, developer: 'claude-code' as const, frontend: 'claude-code' as const, performance: 'claude-code' as const, cross_platform: 'claude-code' as const, tester: 'claude-code' as const, security: 'claude-code' as const, product: 'claude-code' as const },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default' as const,
  }
  const captureInit = (bucket: Array<Record<string, unknown>>) => async (input: SprintEngineStateInitializeInput) => {
    bucket.push({ enabledRoles: input.enabledRoles })
    return { ok: true as const, data: { projectionContent: JSON.stringify(sprintEngineProjectionFixture({ name: 'Ship Squad', goal: 'Ship the things' })) } }
  }

  const userMode: Array<Record<string, unknown>> = []
  await runSprintEngineNewTeamCreation(
    { ...baseInput, additionalEnabledRoles: ['tester', 'security', 'developer'] },
    { pathExists: async () => false, initializeSprintEngineState: captureInit(userMode) },
  )
  assert.equal(userMode.length, 1)
  assert.deepEqual(
    userMode[0].enabledRoles,
    ['architect', 'developer', 'tester', 'security'],
    'sweep roles merge into enabledRoles without duplicating staffed roles',
  )

  const architectMode: Array<Record<string, unknown>> = []
  await runSprintEngineNewTeamCreation(
    {
      ...baseInput,
      roleCounts: { architect: 1, developer: 0, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      visibleRoleCounts: { architect: 1, developer: 0, frontend: 0, performance: 0, cross_platform: 0, tester: 0, security: 0, product: 0 },
      additionalEnabledRoles: ['tester', 'security'],
      rosterSource: 'architect' as const,
      architectSeat: { cli: 'claude-code', model: 'claude-fable-5' },
      allowedRuntimes: [{ cli: 'claude-code', model: 'claude-fable-5' }],
    },
    { pathExists: async () => false, initializeSprintEngineState: captureInit(architectMode) },
  )
  assert.equal(architectMode.length, 1)
  assert.deepEqual(
    architectMode[0].enabledRoles,
    ['architect'],
    'architect mode ignores additionalEnabledRoles — roles grow via roster.configure',
  )
}

async function testSprintEngineNewTeamInitFailuresBlockWorkspaceArgs(): Promise<void> {
  const input = {
    folderPath: '/p',
    teamName: 'Ship Squad',
    goal: 'Ship the things',
    roleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    startRunner: false,
    autoApproveArtifacts: false,
    cliPermissionPreset: 'default' as const,
  }
  let initCalls = 0
  await assert.rejects(
    () => runSprintEngineNewTeamCreation(input, {
      pathExists: async (path) => path.endsWith('/run.yaml'),
      initializeSprintEngineState: async () => {
        initCalls += 1
        return { ok: true, data: {} }
      },
    }),
    (error) => error instanceof SprintEngineNewTeamCreationError && error.code === 'team-exists',
    'existing run state blocks duplicate new-team creation',
  )
  assert.equal(initCalls, 0, 'does not init when the team state path already exists')

  await assert.rejects(
    () => runSprintEngineNewTeamCreation(input, {
      initializeSprintEngineState: async () => ({ ok: false, message: 'init failed', data: {} }),
    }),
    (error) => error instanceof SprintEngineNewTeamCreationError
      && error.code === 'init-failed'
      && error.message === 'init failed',
    'init failure is surfaced',
  )

  await assert.rejects(
    () => runSprintEngineNewTeamCreation(input, {
      initializeSprintEngineState: async () => ({ ok: true, data: { projectionContent: 'not json' } }),
    }),
    (error) => error instanceof SprintEngineNewTeamCreationError && error.code === 'invalid-projection',
    'missing or malformed projection blocks disconnected workspace state',
  )
}

function testSprintEngineEffectiveSpawnAtStartRoles(): void {
  const visibleRoleCounts = { architect: 1, product: 1, frontend: 1, developer: 0, performance: 0, cross_platform: 0, tester: 1, security: 0 }
  // Lazy roster: only the architect ever carries a start-at-launch intent — the
  // per-role "Start now" toggle is retired, so no other role is materialized.
  assert.deepEqual(
    buildSprintEngineEffectiveSpawnAtStartRoles({
      automationMode: 'run_agents_and_approve_artifacts',
      existingTeam: false,
      visibleRoleCounts,
    }),
    { architect: true },
    'a non-manual new-team run bootstraps the architect only',
  )
  assert.deepEqual(
    buildSprintEngineEffectiveSpawnAtStartRoles({
      automationMode: 'run_agents',
      existingTeam: false,
      visibleRoleCounts,
    }),
    { architect: true },
    'no per-role start intent survives — worker/reviewer ids mint on demand',
  )
  assert.deepEqual(
    buildSprintEngineEffectiveSpawnAtStartRoles({
      automationMode: 'manual',
      existingTeam: false,
      visibleRoleCounts,
    }),
    {},
    'manual mode starts nothing at launch',
  )
  assert.deepEqual(
    buildSprintEngineEffectiveSpawnAtStartRoles({
      automationMode: 'run_agents_and_approve_artifacts',
      existingTeam: true,
      visibleRoleCounts,
    }),
    {},
    'opening an existing team does not invent bootstrap launch intent',
  )
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
    visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
    maxParallelAgents: 2,
    roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' } as const,
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
  const { useWorkspaceStore } = await import('../../../../store/workspaceStore')
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
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      roleModelOverrides: { architect: 'claude-opus-4-8', product: null },
      initialSpawnRoles: ['architect'],
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
  const workspace = useWorkspaceStore
    .getState()
    .workspaces.find((candidate) => candidate.sprintEngineContext?.teamSlug === 'backlog-run')
  assert.equal(
    workspace?.agents.architect?.cliModel,
    'claude-opus-4-8',
    'backlog/plan-sourced creation preserves the explicit model selected in the roster',
  )
  assert.equal(
    workspace?.agents.product?.cliModel,
    undefined,
    'explicit CLI-default model selections pass no model flag',
  )
  assert.deepEqual(workspace?.sprintEngineInitialSpawnAgentIds, ['architect'])
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
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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

async function testSprintEngineEpicSourcedLinksEpicAndFlagsChildren(): Promise<void> {
  const links: Array<{ sourceRelativePath: string; childRelativePaths?: string[] }> = []
  await runSprintEnginePlanSourcedCreation(
    {
      folderPath: '/p',
      teamName: 'Auth Revamp',
      goal: 'Revamp authentication',
      // For an epic, the epic file is the primary source (sourcePlanPath); the
      // bundle holds its children. The controller must not treat bundle[0] as the
      // handover primary.
      sourcePlanPath: '/p/backlog/epics/auth-revamp.md',
      sourcePlanRelativePath: 'backlog/epics/auth-revamp.md',
      sourcePlanContent: '# Auth revamp',
      sourcePlanKind: 'epic',
      sourceBundle: [
        { kind: 'generic_context', sourcePath: '/p/backlog/login-form.md', sourceRelativePath: 'backlog/login-form.md', sourceContent: '# Login' },
        { kind: 'generic_context', sourcePath: '/p/backlog/session-store.md', sourceRelativePath: 'backlog/session-store.md', sourceContent: '# Session' },
      ],
      epicChildRelativePaths: ['backlog/login-form.md', 'backlog/session-store.md'],
      sourceReference: true,
      visibleRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      maxParallelAgents: 2,
      roleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      startRunner: false,
      autoApproveArtifacts: false,
      cliPermissionPreset: 'default',
    },
    {
      // Only the epic file is probed for existence (it is the handover primary).
      pathExists: async (path) => path === '/p/backlog/epics/auth-revamp.md',
      initializeSprintEngineState: async () => ({ ok: true, data: {} }),
      recordBacklogExecutionLink: async (input) => {
        links.push({ sourceRelativePath: input.sourceRelativePath, childRelativePaths: input.childRelativePaths })
      },
    },
  )

  assert.deepEqual(
    links,
    [{ sourceRelativePath: 'backlog/epics/auth-revamp.md', childRelativePaths: ['backlog/login-form.md', 'backlog/session-store.md'] }],
    'epic launch links the epic file and forwards its child paths for in_progress flips',
  )
}

async function testGuidedBriefScaffoldValidation(): Promise<void> {
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: createMemoryFilesystem(),
    discovery: createDiscovery(),
  }

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: null, workspaceName: '', idea: 'idea', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-folder',
    'missing-folder',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: '', hasUi: 'no', wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
      ports,
    ),
    (error) => error instanceof GuidedBriefScaffoldError && error.code === 'missing-idea',
    'missing-idea',
  )

  await assert.rejects(
    () => runGuidedBriefScaffold(
      { folderPath: '/p', workspaceName: '', idea: 'idea', hasUi: null, wantsProduct: true, wantsArchitecture: false, wantsFrontend: false, guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' }, buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 }, buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' }, buildCliPermissionPreset: 'default', buildStartRunner: false, buildAutoApproveArtifacts: false },
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
    discovery: createDiscovery(),
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
      buildRoleCounts: { architect: 1, product: 1, frontend: 0, developer: 0, performance: 0, cross_platform: 0, tester: 0, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
  assert.deepEqual(
    JSON.parse(fs.files.get('/workspace/.guided-brief/scaffold-baseline.json') ?? 'null'),
    { version: 1, files: {} },
    'a fresh empty folder scaffolds an empty baseline manifest',
  )
}

async function testGuidedBriefDesignPresetScaffold(): Promise<void> {
  const fs = createMemoryFilesystem()
  // Seeded repo: a pre-existing mockup and ui-direction.md must land in the
  // baseline manifest so run-scoped discovery hides them from the studio.
  const ports: GuidedBriefScaffoldPorts = {
    filesystem: fs,
    discovery: createDiscovery(
      { '/design/mockups': [{ name: 'legacy.html', isDir: false }] },
      {
        '/design/mockups/legacy.html': { modifiedAtMs: 1000, sizeBytes: 42 },
        '/design/product/ui-direction.md': { modifiedAtMs: 2000, sizeBytes: 7 },
      },
    ),
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
      buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
  assert.deepEqual(
    JSON.parse(fs.files.get('/design/.guided-brief/scaffold-baseline.json') ?? 'null'),
    {
      version: 1,
      files: {
        'mockups/legacy.html': { mtimeMs: 1000, size: 42 },
        'product/ui-direction.md': { mtimeMs: 2000, size: 7 },
      },
    },
    'pre-existing files under the shared roots are recorded in the scaffold baseline',
  )
}

async function testDesignSystemScaffoldValidationAndFailure(): Promise<void> {
  const baseInput = {
    workspaceName: 'Brand System',
    idea: 'A warm editorial design system.',
    guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
    buildCliPermissionPreset: 'default' as const,
    buildStartRunner: false,
    buildAutoApproveArtifacts: false,
  }
  const okPorts = {
    filesystem: createMemoryFilesystem(),
    scaffoldBundle: async (workspaceRoot: string) => ({ ok: true as const, bundleDir: `${workspaceRoot}/design-system` }),
  }

  await assert.rejects(
    () => runDesignSystemScaffold({ ...baseInput, folderPath: null }, okPorts),
    (error) => error instanceof DesignSystemScaffoldError && error.code === 'missing-folder',
    'missing-folder',
  )
  await assert.rejects(
    () => runDesignSystemScaffold({ ...baseInput, folderPath: '/ds', idea: '   ' }, okPorts),
    (error) => error instanceof DesignSystemScaffoldError && error.code === 'missing-idea',
    'missing-idea',
  )
  // A seed entry whose source path never resolved fails loudly instead of
  // silently degrading to a blank start.
  await assert.rejects(
    () => runDesignSystemScaffold(
      { ...baseInput, folderPath: '/ds', seedSource: { kind: 'source-folder', path: '  ' } },
      okPorts,
    ),
    (error) => error instanceof DesignSystemScaffoldError && error.code === 'missing-seed-source',
    'missing-seed-source',
  )

  // A failed bundle scaffold surfaces its real cause — no runtime state is
  // produced on top of a missing bundle.
  await assert.rejects(
    () => runDesignSystemScaffold(
      { ...baseInput, folderPath: '/ds' },
      {
        filesystem: createMemoryFilesystem(),
        scaffoldBundle: async () => ({ ok: false, message: 'templates missing' }),
      },
    ),
    (error) =>
      error instanceof DesignSystemScaffoldError
      && error.code === 'scaffold-failed'
      && error.message === 'templates missing',
    'scaffold-failed carries the port message',
  )
}

async function testDesignSystemScaffoldHappyPath(): Promise<void> {
  const fs = createMemoryFilesystem()
  const scaffoldCalls: Array<{ workspaceRoot: string; name: string; summary: string }> = []
  const { runtimeState } = await runDesignSystemScaffold(
    {
      folderPath: '/brand',
      workspaceName: 'Fallback Name',
      idea: 'A warm editorial design system.',
      guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'codex' },
      buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      buildCliPermissionPreset: 'default',
      buildStartRunner: false,
      buildAutoApproveArtifacts: false,
    },
    {
      filesystem: fs,
      scaffoldBundle: async (workspaceRoot, name, summary) => {
        scaffoldCalls.push({ workspaceRoot, name, summary })
        return { ok: true, bundleDir: `${workspaceRoot}/design-system` }
      },
    },
  )

  assert.equal(scaffoldCalls.length, 1, 'bundle scaffold port is called once')
  assert.equal(scaffoldCalls[0].workspaceRoot, '/brand')
  assert.equal(scaffoldCalls[0].name, 'Brand', 'bundle name derives from the folder basename')
  assert.equal(scaffoldCalls[0].summary, 'A warm editorial design system.')
  assert.equal(runtimeState.preset, 'design-system')
  assert.equal(runtimeState.hasUi, 'yes', 'design-system preset forces hasUi to yes')
  assert.equal(runtimeState.stage, 'designer-working', 'design-system preset starts on the designer stage')
  assert.equal(runtimeState.wantsProductDiscussion, false)
  assert.equal(runtimeState.wantsArchitectureDiscussion, false)
  assert.equal(runtimeState.wantsFrontendDiscussion, true)
  assert.equal(runtimeState.guidedRoleCliDefaults.frontend, 'codex')
  assert.ok(
    fs.files.has('/brand/.guided-brief/idea-seed.md'),
    'design goal seed is written under .guided-brief, not into the bundle',
  )
  assert.match(
    fs.files.get('/brand/.guided-brief/idea-seed.md') ?? '',
    /# Design System Goal/,
  )
  assert.ok(
    !fs.files.has('/brand/product/idea-seed.md'),
    'design-system preset does not scaffold the product/ layout',
  )
  assert.ok(
    !fs.files.has('/brand/product/build-handoff.md'),
    'design-system preset never writes a build handoff',
  )
  assert.equal(
    runtimeState.designSystemSeedSource,
    null,
    'blank start records no seed source',
  )
  assert.doesNotMatch(
    fs.files.get('/brand/.guided-brief/idea-seed.md') ?? '',
    /## Seed Source/,
    'blank start writes no seed-source section',
  )
}

async function testDesignSystemScaffoldSeeded(): Promise<void> {
  const fs = createMemoryFilesystem()
  const seedSource = { kind: 'brand-demo' as const, path: '/app/knowledge/brand' }
  const { runtimeState } = await runDesignSystemScaffold(
    {
      folderPath: '/brand',
      workspaceName: 'Brand System',
      idea: 'Distill the Multicode brand into a portable system.',
      seedSource,
      guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
      buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
      buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
      buildCliPermissionPreset: 'default',
      buildStartRunner: false,
      buildAutoApproveArtifacts: false,
    },
    {
      filesystem: fs,
      scaffoldBundle: async (workspaceRoot) => ({ ok: true, bundleDir: `${workspaceRoot}/design-system` }),
    },
  )

  // Seeding only adds the seed source on top of the blank-start scaffold: the
  // same bundle scaffold ran, the runtime state carries the source for the
  // designer prompt, and the idea seed records the choice on disk.
  assert.deepEqual(runtimeState.designSystemSeedSource, seedSource)
  assert.equal(runtimeState.stage, 'designer-working')
  const ideaSeed = fs.files.get('/brand/.guided-brief/idea-seed.md') ?? ''
  assert.match(ideaSeed, /## Seed Source/)
  assert.match(ideaSeed, /built-in Multicode brand reference/)
  assert.match(ideaSeed, /\/app\/knowledge\/brand/)
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
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
    persistAdvancedSetup: async () => null,
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

  // A design-system studio completes with "Save as design system" (T6 release
  // pipeline), never a Sprint Engine build — reaching start-build is a caller
  // bug and must refuse loudly rather than write a handoff.
  const designSystemRuntime: GuidedBriefRuntimeState = {
    ...baseRuntime,
    preset: 'design-system',
    wantsProductDiscussion: false,
    wantsArchitectureDiscussion: false,
  }
  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState: designSystemRuntime,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: designSystemRuntime.buildRoleCounts, roleCliDefaults: designSystemRuntime.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: designSystemRuntime.buildRoleCounts,
        rosterSummary: [],
        planningDecisions: [],
        planningValidationNotes: [],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) =>
      error instanceof GuidedBriefStartBuildError && error.code === 'design-system-preset',
    'design-system preset never starts a build',
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
    persistAdvancedSetup: async () => null,
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
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
  assert.match(writtenHandoff ?? '', /## Suggested Sprint Goal/, 'handoff body contains the goal section')
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
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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
    persistAdvancedSetup: async () => null,
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

async function testGuidedBriefStartBuildAdvancedSetupFailsClosed(): Promise<void> {
  // T17 fail-closed: when the Advanced-setup preflight (MCP sync / skill-pack
  // install) fails, the controller must abort before writing the handoff or
  // creating the run/workspace, so no partial Sprint Engine workspace remains.
  const fs = createMemoryFilesystem()
  let createCalled = false
  let buildHandoffRead = false

  const runtimeState: GuidedBriefRuntimeState = {
    workspaceRoot: '/workspace',
    workspaceName: 'Brief',
    idea: 'Trade shifts',
    hasUi: 'yes',
    wantsProductDiscussion: true,
    wantsArchitectureDiscussion: true,
    wantsFrontendDiscussion: true,
    guidedRoleCliDefaults: { product: 'claude-code', architect: 'claude-code', frontend: 'claude-code' },
    buildRoleCounts: { architect: 1, product: 1, frontend: 1, developer: 1, performance: 0, cross_platform: 0, tester: 1, security: 0 },
    buildRoleCliDefaults: { architect: 'claude-code', product: 'claude-code', frontend: 'claude-code', developer: 'claude-code', performance: 'claude-code', cross_platform: 'claude-code', tester: 'claude-code', security: 'claude-code' },
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

  const ports: GuidedBriefStartBuildPorts = {
    filesystem: fs,
    pathExists: async () => false,
    persistAdvancedSetup: async () => 'Tool integration setup failed: mcp sync error',
    readArchitecturePlan: async () => '# Artifact\n',
    readBuildHandoff: async (workspaceRoot, path) => {
      buildHandoffRead = true
      return fs.files.get(`${workspaceRoot}/${path}`) ?? ''
    },
    createPlanSourcedSprintEngineWorkspace: async () => {
      createCalled = true
      return {
        workspaceId: 'workspace-id',
        sprintEngineContext: {
          teamName: 'Brief Build',
          teamSlug: 'brief-build',
          teamDirectoryPath: '/workspace/.multi-code/sprintengine/brief-build',
          statePath: '/workspace/.multi-code/sprintengine/brief-build/run.yaml',
        },
        architectAgentId: 'architect-1',
      }
    },
  }

  await assert.rejects(
    () => runGuidedBriefStartBuild(
      {
        runtimeState,
        runOptions: { startRunner: false, autoApproveArtifacts: false, roleCounts: runtimeState.buildRoleCounts, roleCliDefaults: runtimeState.buildRoleCliDefaults, cliPermissionPreset: 'default' },
        finalRoleCounts: runtimeState.buildRoleCounts,
        rosterSummary: [],
        planningDecisions: [],
        planningValidationNotes: [],
        buildHandoffRelativePath: 'product/build-handoff.md',
      },
      ports,
    ),
    (error) =>
      error instanceof GuidedBriefStartBuildError
      && error.code === 'advanced-setup-failed'
      && error.message === 'Tool integration setup failed: mcp sync error',
    'advanced-setup preflight failure rejects with the actionable message',
  )

  assert.equal(createCalled, false, 'no Sprint Engine run/workspace is created when Advanced setup fails')
  assert.equal(buildHandoffRead, false, 'handoff assembly never runs when Advanced setup fails')
  assert.equal(fs.files.has('/workspace/product/build-handoff.md'), false, 'no handoff file is written when Advanced setup fails')
}

async function main(): Promise<void> {
  testBuildStandardCreation()
  testBuildModuleTypeCreation()
  testBuildSwitchboardCreation()
  testBuildSprintEngineExistingTeamCreation()
  testBuildSprintEngineNewTeamCreation()
  await testSprintEngineNewTeamInitializesRunState()
  await testSprintEngineNewTeamUserModeInitArgsUnchanged()
  await testSprintEngineArchitectRosterInitArgs()
  testSprintEngineWorkflowInitKeys()
  await testSprintEngineWorkflowKeysFlowToInit()
  await testSprintEngineAdditionalEnabledRolesMergeIntoInit()
  await testSprintEngineNewTeamInitFailuresBlockWorkspaceArgs()
  testSprintEngineEffectiveSpawnAtStartRoles()
  await testSprintEnginePlanSourcedValidation()
  await testSprintEnginePlanSourcedInitializesAndLinksBacklog()
  await testSprintEnginePlanSourcedWorktreeModeFlowsThroughStateAndPrompt()
  await testSprintEnginePlanSourcedSkipsNonBacklogLink()
  await testSprintEngineEpicSourcedLinksEpicAndFlagsChildren()
  await testGuidedBriefScaffoldValidation()
  await testGuidedBriefScaffoldHappyPath()
  await testGuidedBriefDesignPresetScaffold()
  await testDesignSystemScaffoldValidationAndFailure()
  await testDesignSystemScaffoldHappyPath()
  await testDesignSystemScaffoldSeeded()
  await testGuidedBriefStartBuildValidation()
  await testGuidedBriefStartBuildHandoffPath()
  await testGuidedBriefStartBuildDesignPresetHandoff()
  await testGuidedBriefStartBuildAdvancedSetupFailsClosed()
  console.log('newWorkspace controllers.test.ts: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
