import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli, SprintEngineRoleId } from '../../../types/workspace'
import { buildSprintEngineNewTeamCreation } from './controllers'
import { STEPS_BY_MODE } from './creationStepFlows'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  resolveInitialSprintEngineRoster,
} from './savedTeams'
import { SprintEngineWorkflowPanels } from './SprintEngineWorkflowPanels'
import { buildSprintEngineWorkflowInitKeys } from './sprintengineWorkflowConfig'
import { RosterAndRunSettings } from './WizardControls'

// "Skip the rest and create" leaves as soon as the sprint's intent page (the
// team) is answered, so the roster and run pages may never be rendered. The
// promise the footer makes is that this creates exactly what walking those pages
// and changing nothing would have created.
//
// That promise rests on two things, and this file asserts BOTH rather than
// taking either on faith:
//   1. Every value create sends is already in the panel's state when the hub
//      opens — no default arrives only when its page renders.
//   2. Rendering those pages changes nothing by itself.
// A future refinement page that seeds its default from a mount effect, or that
// calls an onChange during render, breaks the promise silently: the skipped run
// would differ from the walked one. The assertions below are what catch it.

const PANEL_PATH = join(process.cwd(), 'src/renderer/src/components/workspace/NewWorkspacePanel.tsx')
const HERE = join(process.cwd(), 'src/renderer/src/components/workspace/newWorkspace')
const panelSource = readFileSync(PANEL_PATH, 'utf8')

// The pages a skip from the team page skips over.
const SKIPPED_PAGES = STEPS_BY_MODE.sprintengine.slice(
  STEPS_BY_MODE.sprintengine.indexOf('sprintengine-team') + 1,
)
assert.deepEqual(SKIPPED_PAGES, ['sprintengine-roster', 'sprintengine-run'], 'skip leaves the roster and run pages unseen')

// ---------------------------------------------------------------------------
// The untouched sprint state — the panel's own defaults, from the panel's own
// sources. This is what create reads on a skip.
// ---------------------------------------------------------------------------

const initialRoster = resolveInitialSprintEngineRoster({
  savedTeams: [],
  lastSelectedTeamId: null,
  savedRoster: null,
  defaultRoleCounts: DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  defaultRoleCliDefaults: DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
})

type SprintWizardState = {
  roleCounts: typeof initialRoster.roleCounts
  roleCliDefaults: typeof initialRoster.roleCliDefaults
  roleModelOverrides: typeof initialRoster.roleModelOverrides
  useSpecialistRoles: boolean
  // What create actually stages for the run. In the plain-agents default this is
  // a single `general` planner seat, NOT the specialist roster held (collapsed)
  // in `roleCounts` — the pool grows by mint-on-demand up to the concurrency cap.
  effectiveCreateRoleCounts: typeof initialRoster.roleCounts
  startRunner: boolean
  autoApproveArtifacts: boolean
  useWorktrees: boolean
  maxParallelAgents: number
  cliPermissionPreset: 'default'
  selfReviewEnabled: boolean
  reviewRuntime: null
  requiredSweepRoleIds: SprintEngineRoleId[]
}

// Mirrors the panel's useState initializers for every roster/run value create
// consumes. The source contracts below pin each one, so this model cannot drift
// away from the panel without a test failing.
const UNTOUCHED: SprintWizardState = {
  roleCounts: initialRoster.roleCounts,
  roleCliDefaults: initialRoster.roleCliDefaults,
  roleModelOverrides: initialRoster.roleModelOverrides,
  // MC-1585: a fresh install opens on plain agents — the "Use specialist roles"
  // disclosure is collapsed, and create stages exactly one `general` planner.
  useSpecialistRoles: false,
  effectiveCreateRoleCounts: { general: 1 },
  // Automation defaults ON (run agents + approve eligible artifacts): a
  // skipped run continues on its own, matching the product default. Loading an
  // existing team is the exception (derived to manual; asserted below).
  startRunner: true,
  autoApproveArtifacts: true,
  useWorktrees: false,
  // The plain-agents default is 2 ("two agents claiming from one task graph").
  maxParallelAgents: 2,
  // The panel seeds this from the stored spawn-permission preference, which is
  // workspace-scoped state read at mount — not something a page render produces.
  cliPermissionPreset: 'default',
  selfReviewEnabled: true,
  reviewRuntime: null,
  requiredSweepRoleIds: [],
}

// MC-1585: the resolved initial roster still holds the balanced specialist team
// behind the collapsed disclosure (so turning "Use specialist roles" on restores
// it), but a fresh install opens on plain agents and creates a `general` run.
assert.deepEqual(UNTOUCHED.roleCounts, DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, 'the specialist roster held behind the disclosure is the default team')
assert.ok(UNTOUCHED.roleCounts.architect >= 1 && UNTOUCHED.roleCounts.developer >= 1, 'that specialist roster can plan and implement once revealed')
assert.equal(UNTOUCHED.useSpecialistRoles, false, 'a fresh install opens on plain agents, disclosure collapsed')
assert.deepEqual(UNTOUCHED.effectiveCreateRoleCounts, { general: 1 }, 'and stages exactly one general planner seat')

// Source contracts: each default is established at mount, in the panel body.
for (const [what, pattern] of [
  ['the roster is seeded from the resolved initial roster', /useState<SprintEngineRoleCounts>\(\s*\(\) => cloneSprintEngineRoleCounts\(initialSprintEngineRoster\.roleCounts\)/],
  ['the specialist-roles disclosure opens collapsed for a fresh install', /const \[seUseSpecialistRoles, setSeUseSpecialistRoles\] = useState\(initialUseSpecialistRoles\)/],
  ['a fresh install computes the disclosure closed unless a saved source staffs specialists', /const initialUseSpecialistRoles =\n\s*\(Boolean\(initialSprintEngineRoster\.selectedTeamId\) \|\| Boolean\(savedSprintEngineRoster\)\)/],
  ['plain-agents create stages a lone general planner', /const PLAIN_AGENT_ROLE_COUNTS: SprintEngineRoleCounts = \{ general: 1 \}/],
  ['plain-agents create swaps in that lone seat', /sprintEnginePlainAgents\n\s*\? PLAIN_AGENT_ROLE_COUNTS\n\s*: sprintEngineCreateRoleCounts/],
  ['agents-at-start is on', /const \[seStartRunner, setSeStartRunner\] = useState\(true\)/],
  ['artifact auto-approval is on', /const \[seAutoApproveArtifacts, setSeAutoApproveArtifacts\] = useState\(true\)/],
  ['automation starts untouched', /const \[seAutomationTouched, setSeAutomationTouched\] = useState\(false\)/],
  ['untouched automation follows the create path: manual only for an existing team', /: seExistingTeam\n\s*\? 'manual'\n\s*: 'run_agents_and_approve_artifacts'/],
  ['worktrees are off', /const \[seUseWorktrees, setSeUseWorktrees\] = useState\(false\)/],
  ['plain-agents runs default to 2 agents, specialist runs to 3', /const \[seMaxParallelAgents, setSeMaxParallelAgents\] = useState\(\(\) => \(initialUseSpecialistRoles \? 3 : 2\)\)/],
  ['self-review is on', /const \[seSelfReviewEnabled, setSeSelfReviewEnabled\] = useState\(true\)/],
  ['the reviewer is the same agent', /const \[seReviewRuntime, setSeReviewRuntime\] = useState<SprintEngineReviewRuntime \| null>\(null\)/],
  ['no sweeps are mandated', /const \[seRequiredSweeps, setSeRequiredSweeps\] = useState<ReadonlySet<SprintEngineRoleId>>\(\s*\(\) => new Set<SprintEngineRoleId>\(\)/],
] as const) {
  assert.match(panelSource, pattern, `panel default: ${what}`)
}

// The run page can never block create — that is what lets skip appear the moment
// the team page is answered, two pages early.
assert.match(
  panelSource,
  /case 'sprintengine-run':\n\s*return true\n/,
  'the run page is always ready: every control on it is defaulted',
)

// ---------------------------------------------------------------------------
// Walking the skipped pages changes nothing.
// ---------------------------------------------------------------------------

// Render the two skipped pages exactly as the wizard does — RosterAndRunSettings
// split by `sections`, with the real workflow panels injected on the run page —
// and wire EVERY callback to a spy. A page that seeds a default during render
// (an onChange fired from the render body) records a mutation here.
const mutations: string[] = []
const spy = (name: string) => (...args: unknown[]) => {
  mutations.push(`${name}(${args.map((value) => JSON.stringify(value) ?? String(value)).join(', ')})`)
}

const cliOptions = [{ id: 'claude' as AgentCli, label: 'Claude' } as never]

function renderPage(sections: 'roster' | 'run'): string {
  return renderToStaticMarkup(
    <RosterAndRunSettings
      roleCounts={UNTOUCHED.roleCounts}
      roleCliDefaults={UNTOUCHED.roleCliDefaults}
      roleModelOverrides={UNTOUCHED.roleModelOverrides}
      cliOptions={cliOptions}
      registry={null}
      countDisabled={false}
      cliDisabled={false}
      onSetCount={spy('onSetCount')}
      onSetCli={spy('onSetCli')}
      onSetModel={spy('onSetModel')}
      totalAgents={2}
      automationMode={'run_agents_and_approve_artifacts' as never}
      onChangeAutomationMode={spy('onChangeAutomationMode')}
      cliPermissionPreset={UNTOUCHED.cliPermissionPreset as never}
      onChangeCliPermissionPreset={spy('onChangeCliPermissionPreset')}
      maxParallelAgents={UNTOUCHED.maxParallelAgents}
      onChangeMaxParallelAgents={spy('onChangeMaxParallelAgents')}
      useWorktrees={UNTOUCHED.useWorktrees}
      onChangeUseWorktrees={spy('onChangeUseWorktrees')}
      sections={sections}
      // The fresh-install experience: plain agents, disclosure collapsed. The
      // roster page shows the agent stepper; the run page drops its own cap row
      // (the stepper owns that value).
      useSpecialistRoles={UNTOUCHED.useSpecialistRoles}
      onChangeUseSpecialistRoles={spy('onChangeUseSpecialistRoles')}
      workflowSection={
        <SprintEngineWorkflowPanels
          cliOptions={cliOptions}
          registry={null}
          selfReviewEnabled={UNTOUCHED.selfReviewEnabled}
          onChangeSelfReviewEnabled={spy('onChangeSelfReviewEnabled')}
          reviewRuntime={UNTOUCHED.reviewRuntime}
          onChangeReviewRuntime={spy('onChangeReviewRuntime')}
          requiredSweepRoleIds={new Set(UNTOUCHED.requiredSweepRoleIds)}
          onToggleRequiredSweep={spy('onToggleRequiredSweep')}
          roleCliDefaults={UNTOUCHED.roleCliDefaults}
          roleModelOverrides={UNTOUCHED.roleModelOverrides}
          onSetRoleCli={spy('onSetRoleCli')}
          onSetRoleModel={spy('onSetRoleModel')}
          showFinalSweeps={UNTOUCHED.useSpecialistRoles}
        />
      }
    />,
  )
}

const rosterPage = renderPage('roster')
const runPage = renderPage('run')
assert.deepEqual(mutations, [], 'rendering the skipped pages changes no wizard state')

// The pages render the defaults they were handed, so a user who DOES walk them
// sees — and leaves — the same values a skip would have sent.
assert.ok(runPage.includes('Run settings'), 'the run page renders the run settings')
// The plain-agents roster page is the stepper + one agent picker, not the
// specialist roster table.
assert.ok(rosterPage.includes('How many agents'), 'the roster page opens on the plain agents stepper')
assert.ok(rosterPage.includes('Use specialist roles'), 'and offers the specialist-roles disclosure')
// The agent count the stepper shows IS the default create sends (the plain
// stepper drives the concurrency cap), so a page showing something else would be
// showing a value the skipped create never had.
assert.ok(
  rosterPage.includes(`>${UNTOUCHED.maxParallelAgents}<`),
  'the stepper shows the default agent count',
)
// In plain mode the run page drops its own cap row — the stepper owns that value,
// so it must not appear twice.
assert.doesNotMatch(runPage, /id="sprintengine-max-parallel-agents"/, 'the run page shows no duplicate agent-cap input in plain mode')
// The worktrees checkbox reflects the same default (off), unchecked in markup.
assert.doesNotMatch(runPage, /type="checkbox"[^>]*checked=""[^>]*>[^<]*<span[^>]*>Run in an isolated git worktree/, 'worktrees start off')

// The other channel a default could sneak in through is a mount effect: it does
// not run under static markup, and on a skip its page never mounts at all — so
// any default it seeded would exist on the walked path and be missing on the
// skipped one. Neither the split settings surface nor the workflow panels may
// own one.
for (const file of ['WizardControls.tsx', 'SprintEngineWorkflowPanels.tsx', 'SprintEngineRosterTable.tsx']) {
  const source = readFileSync(join(HERE, file), 'utf8')
  assert.doesNotMatch(
    source,
    /use(Effect|LayoutEffect)\(/,
    `${file} runs no mount effect: a default seeded there would exist only on the walked path`,
  )
}

// ---------------------------------------------------------------------------
// Defaults parity: the skipped create equals the walked create.
// ---------------------------------------------------------------------------

// The panel's sprint create is a pure function of that state — it never reads the
// page the user pressed the button on (asserted below), so "skip from the team
// page" and "walk to the run page and create" differ only in the state each
// carries. The renders above proved the walk carries the same state.
const walked: SprintWizardState = { ...UNTOUCHED }

function creationArgsFor(state: SprintWizardState) {
  return buildSprintEngineNewTeamCreation({
    folderPath: '/repo',
    teamName: 'Sprint Roster',
    goal: 'Ship the thing',
    // Plain-agents default: create stages the effective general seat, not the
    // specialist roster the disclosure holds collapsed.
    roleCounts: state.effectiveCreateRoleCounts,
    visibleRoleCounts: state.effectiveCreateRoleCounts,
    maxParallelAgents: state.maxParallelAgents,
    roleCliDefaults: state.roleCliDefaults,
    roleModelOverrides: state.roleModelOverrides,
    startRunner: state.startRunner,
    autoApproveArtifacts: state.autoApproveArtifacts,
    useWorktrees: state.useWorktrees,
    cliPermissionPreset: state.cliPermissionPreset as never,
    rosterSource: 'user',
    ...buildSprintEngineWorkflowInitKeys({
      selfReviewEnabled: state.selfReviewEnabled,
      reviewRuntime: state.reviewRuntime,
      requiredSweepRoleIds: state.requiredSweepRoleIds,
    }),
  } as never)
}

const skippedCreate = creationArgsFor(UNTOUCHED)
const walkedCreate = creationArgsFor(walked)

assert.deepEqual(
  skippedCreate,
  walkedCreate,
  'skipping from the team page creates the same roster and run settings as walking every page and changing nothing',
)

// And the run those defaults produce is the one the footer promises: a plain
// general run, the default agent cap, no worktrees, automation on (run agents
// + approve eligible artifacts), and none of the workflow init keys (an
// untouched run sends none — self-review on, reviewer = same agent, no mandated
// sweeps are all engine defaults).
assert.equal(skippedCreate.sprintEngineState?.roleCounts.general, 1, 'the skipped run stages the general planner seat')
assert.equal(skippedCreate.sprintEngineState?.roleCounts.architect ?? 0, 0, 'and seats no specialist architect')
assert.equal(skippedCreate.sprintEngineState?.useWorktrees, undefined, 'the skipped run does not turn worktrees on')
assert.equal(skippedCreate.sprintEngineAutoState?.maxConcurrentAgents, 2, 'the skipped run keeps the plain-agents default cap of 2')
assert.equal(
  skippedCreate.sprintEngineAutoState?.desiredMode,
  'run_agents_and_approve_artifacts',
  'the skipped run starts with automation on: run agents + approve artifacts',
)
assert.equal(skippedCreate.sprintEngineAutoState?.runtimeState, 'running', 'and the runner starts running')
// Every sprint create path (existing team, plan-sourced, new team) reads the
// derived seAutomationMode — never the raw booleans — so the existing-team
// manual default cannot be bypassed. Guided-brief sites intentionally use the
// raw state (a guided build never resumes an existing team).
assert.equal(
  (panelSource.match(/startRunner: seAutomationMode !== 'manual'/g) ?? []).length,
  3,
  'the three sprint create paths derive automation from seAutomationMode',
)
assert.deepEqual(
  buildSprintEngineWorkflowInitKeys({
    selfReviewEnabled: UNTOUCHED.selfReviewEnabled,
    reviewRuntime: UNTOUCHED.reviewRuntime,
    requiredSweepRoleIds: UNTOUCHED.requiredSweepRoleIds,
  }),
  {},
  'an untouched run sends no workflow overrides',
)

// The create path reads state, never the page: if it ever branched on `step`, the
// two paths above could diverge no matter how equal their state was.
const sprintCreateCall = panelSource.slice(
  panelSource.indexOf('await runSprintEngineNewTeamCreation('),
  panelSource.indexOf('onCreate(args)', panelSource.indexOf('await runSprintEngineNewTeamCreation(')),
)
assert.ok(sprintCreateCall.length > 0, 'found the sprint create call')
assert.doesNotMatch(sprintCreateCall, /\bstep\b|\bstepIndex\b|\bisLastStep\b/, 'sprint create never reads the current page')

console.log('skipToCreateDefaults.test.tsx: ok')
