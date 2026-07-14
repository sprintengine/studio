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
  startRunner: false,
  autoApproveArtifacts: false,
  useWorktrees: false,
  maxParallelAgents: 3,
  // The panel seeds this from the stored spawn-permission preference, which is
  // workspace-scoped state read at mount — not something a page render produces.
  cliPermissionPreset: 'default',
  selfReviewEnabled: true,
  reviewRuntime: null,
  requiredSweepRoleIds: [],
}

// The defaults are the balanced starting team the hub promises: a runnable
// implement-and-review roster, seeded before the user touches anything.
assert.deepEqual(UNTOUCHED.roleCounts, DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, 'a fresh install skips onto the default roster')
assert.ok(UNTOUCHED.roleCounts.architect >= 1 && UNTOUCHED.roleCounts.developer >= 1, 'the default roster can plan and implement')

// Source contracts: each default is established at mount, in the panel body.
for (const [what, pattern] of [
  ['the roster is seeded from the resolved initial roster', /useState<SprintEngineRoleCounts>\(\s*\(\) => cloneSprintEngineRoleCounts\(initialSprintEngineRoster\.roleCounts\)/],
  ['agents-at-start is off', /const \[seStartRunner, setSeStartRunner\] = useState\(false\)/],
  ['artifact auto-approval is off', /const \[seAutoApproveArtifacts, setSeAutoApproveArtifacts\] = useState\(false\)/],
  ['worktrees are off', /const \[seUseWorktrees, setSeUseWorktrees\] = useState\(false\)/],
  ['max parallel agents is 3', /const \[seMaxParallelAgents, setSeMaxParallelAgents\] = useState\(3\)/],
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
      automationMode={'manual' as never}
      onChangeAutomationMode={spy('onChangeAutomationMode')}
      cliPermissionPreset={UNTOUCHED.cliPermissionPreset as never}
      onChangeCliPermissionPreset={spy('onChangeCliPermissionPreset')}
      maxParallelAgents={UNTOUCHED.maxParallelAgents}
      onChangeMaxParallelAgents={spy('onChangeMaxParallelAgents')}
      useWorktrees={UNTOUCHED.useWorktrees}
      onChangeUseWorktrees={spy('onChangeUseWorktrees')}
      sections={sections}
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
assert.ok(rosterPage.includes('Roster'), 'the roster page renders the roster')
// The agent cap the run page displays IS the default create sends: the control is
// controlled, so a page that showed something else would be showing a value the
// skipped create never had.
const capInput = /<input[^>]*id="sprintengine-max-parallel-agents"[^>]*>/.exec(runPage)?.[0]
assert.ok(capInput, 'the run page renders the max-parallel-agents input')
assert.match(capInput, new RegExp(`value="${UNTOUCHED.maxParallelAgents}"`), 'and shows the default agent cap')
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
    roleCounts: state.roleCounts,
    visibleRoleCounts: state.roleCounts,
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

// And the run those defaults produce is the one the footer promises: the balanced
// default team, the default agent cap, no worktrees, no automation, and none of
// the workflow init keys (an untouched run sends none — self-review on, reviewer
// = same agent, no mandated sweeps are all engine defaults).
assert.deepEqual(skippedCreate.sprintEngineState?.roleCounts, DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, 'the skipped run starts on the default roster')
assert.equal(skippedCreate.sprintEngineState?.useWorktrees, undefined, 'the skipped run does not turn worktrees on')
assert.equal(skippedCreate.sprintEngineAutoState?.maxConcurrentAgents, 3, 'the skipped run keeps the default agent cap')
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
