import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'

import type { AgentCli } from '../../../types/workspace'
import { buildSprintEngineNewTeamCreation } from './controllers'
import { STEPS_BY_MODE } from './creationStepFlows'
import {
  DEFAULT_SPRINT_ENGINE_ROLE_CLI_DEFAULTS,
  DEFAULT_SPRINT_ENGINE_ROLE_COUNTS,
  resolveInitialSprintEngineRoster,
} from './savedRosters'
import { SprintEngineRosterPanel } from './SprintEngineRosterPanel'
import { SprintEngineToolsPanel } from './SprintEngineToolsPanel'
import { SprintEngineStartPanel } from './SprintEngineStartPanel'

// "Skip the rest and create" leaves as soon as the sprint's intent page (the
// team objective) is answered, so the roster, tools, and review-&-start pages
// may never be rendered. The promise the footer makes is that this creates
// exactly what walking those pages and changing nothing would have created.
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
// MC-1875 moved PLAIN_AGENT_ROLE_COUNTS out of the panel so the wizard and the
// plan-sourced launch path share one constant. Its source pin moved with it.
const savedRostersSource = readFileSync(join(HERE, 'savedRosters.ts'), 'utf8')
// MC-1879 lifted the roster editor's state out of the panel; its source-shape
// pins moved with it.
const rosterEditorSource = readFileSync(join(HERE, 'useRosterEditor.ts'), 'utf8')

// The pages a skip from the team page skips over (MC-1646 flow).
const SKIPPED_PAGES = STEPS_BY_MODE.sprintengine.slice(
  STEPS_BY_MODE.sprintengine.indexOf('sprintengine-team') + 1,
)
assert.deepEqual(
  SKIPPED_PAGES,
  ['sprintengine-roster', 'sprintengine-tools', 'sprintengine-start'],
  'skip leaves the team, tools, and review-&-start pages unseen',
)

// ---------------------------------------------------------------------------
// The untouched sprint state — the panel's own defaults, from the panel's own
// sources. This is what create reads on a skip.
// ---------------------------------------------------------------------------

const initialRoster = resolveInitialSprintEngineRoster({
  savedRosters: [],
  lastSelectedRosterId: null,
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
}

// Mirrors the panel's useState initializers for every roster/run value create
// consumes. The source contracts below pin each one, so this model cannot drift
// away from the panel without a test failing.
const UNTOUCHED: SprintWizardState = {
  roleCounts: initialRoster.roleCounts,
  roleCliDefaults: initialRoster.roleCliDefaults,
  roleModelOverrides: initialRoster.roleModelOverrides,
  // MC-1585: a fresh install opens on plain agents — the Team page's segmented
  // control sits on "Plain agent pool", and create stages exactly one `general`
  // planner.
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
}

// MC-1585: the resolved initial roster still holds the balanced specialist team
// behind the pool segment (so switching to "Pick roles yourself" restores it),
// but a fresh install opens on plain agents and creates a `general` run.
assert.deepEqual(UNTOUCHED.roleCounts, DEFAULT_SPRINT_ENGINE_ROLE_COUNTS, 'the specialist roster held behind the pool segment is the default team')
assert.ok(UNTOUCHED.roleCounts.architect >= 1 && UNTOUCHED.roleCounts.developer >= 1, 'that specialist roster can plan and implement once revealed')
assert.equal(UNTOUCHED.useSpecialistRoles, false, 'a fresh install opens on the plain agent pool')
assert.deepEqual(UNTOUCHED.effectiveCreateRoleCounts, { general: 1 }, 'and stages exactly one general planner seat')

// Source contracts: each default is established at mount, in the panel body.
for (const [what, pattern] of [
  ['plain-agents create swaps in that lone seat', /sprintEnginePlainAgents\n\s*\? PLAIN_AGENT_ROLE_COUNTS\n\s*: sprintEngineCreateRoleCounts/],
  ['agents-at-start is on', /const \[seStartRunner, setSeStartRunner\] = useState\(true\)/],
  ['artifact auto-approval is on', /const \[seAutoApproveArtifacts, setSeAutoApproveArtifacts\] = useState\(true\)/],
  ['automation starts untouched', /const \[seAutomationTouched, setSeAutomationTouched\] = useState\(false\)/],
  ['untouched automation follows the create path: manual only for an existing team', /: seExistingTeam\n\s*\? 'manual'\n\s*: 'run_agents_and_approve_artifacts'/],
  ['worktrees are off', /const \[seUseWorktrees, setSeUseWorktrees\] = useState\(false\)/],
] as const) {
  assert.match(panelSource, pattern, `panel default: ${what}`)
}

// MC-1879 moved the roster editor's state into useRosterEditor. These are the
// SAME source-shape contracts, repointed at their new home — the pins below
// establish that each roster default is still set once at mount, from the
// resolved roster, rather than drifting into an effect. (Every BEHAVIOURAL
// assertion in this file passed unchanged across that move, which is the real
// evidence the extraction changed nothing.)
for (const [what, pattern] of [
  ['the roster is seeded from the resolved initial roster', /useState<SprintEngineRoleCounts>\(\s*\(\) => cloneRoleCounts\(initial\.roleCounts\),/],
  ['the resolved roster is itself computed once, at mount', /const \[initial\] = useState\(\(\) => resolveInitialSprintEngineRoster\(\{/],
  ['the specialist-roles axis opens from the resolved formation', /const \[useSpecialistRoles, setUseSpecialistRoles\] = useState\(\(\) => initial\.mode === 'roles'\)/],
  ['the formation segment is that one axis projected — MC-1889 left no third formation', /const rosterMode: SprintEngineRosterMode = useSpecialistRoles \? 'roles' : 'pool'/],
  ['plain-agents runs default to 2 agents, specialist runs to 3', /const \[poolAgentCount, setPoolAgentCount\] = useState\(\(\) => \(initial\.mode === 'roles' \? 3 : 2\)\)/],
] as const) {
  assert.match(rosterEditorSource, pattern, `roster editor default: ${what}`)
}

// And the panel must not have kept a second copy of any of it.
for (const [what, pattern] of [
  ['no roster counts state', /useState<SprintEngineRoleCounts>/],
  ['no specialist-roles axis', /setSeUseSpecialistRoles/],
  ['no role registry state', /setSeRoleRegistry\(/],
] as const) {
  assert.doesNotMatch(panelSource, pattern, `panel kept no duplicate: ${what}`)
}

// The plain-agent seed itself, now shared (MC-1875). Pinned at its new home so
// the wizard and the plan-sourced launch cannot drift to two different seeds.
assert.match(
  savedRostersSource,
  /export const PLAIN_AGENT_ROLE_COUNTS: SprintEngineRoleCounts = \{ general: 1 \}/,
  'plain-agents create stages a lone general planner',
)

// The refinement pages can never block create — that is what lets skip appear
// the moment the team page is answered, four pages early.
for (const page of ['sprintengine-tools', 'sprintengine-start']) {
  assert.match(
    panelSource,
    new RegExp(`case '${page}':\\n\\s*return true\\n`),
    `the ${page} page is always ready: every control on it is defaulted`,
  )
}

// ---------------------------------------------------------------------------
// Walking the skipped pages changes nothing.
// ---------------------------------------------------------------------------

// Render the skipped pages exactly as the wizard does — the four
// SprintEngine*Panel step bodies with the untouched defaults — and wire EVERY
// callback to a spy. A page that seeds a default during render (an onChange
// fired from the render body) records a mutation here.
const mutations: string[] = []
const spy = (name: string) => (...args: unknown[]) => {
  mutations.push(`${name}(${args.map((value) => JSON.stringify(value) ?? String(value)).join(', ')})`)
}

const cliOptions = [{ id: 'claude' as AgentCli, label: 'Claude' } as never]

const teamPage = renderToStaticMarkup(
  <SprintEngineRosterPanel
    // The fresh-install experience: the segmented control opens on the pool.
    rosterMode="pool"
    onChangeRosterMode={spy('onChangeRosterMode')}
    roleCounts={UNTOUCHED.roleCounts}
    roleCliDefaults={UNTOUCHED.roleCliDefaults}
    roleModelOverrides={UNTOUCHED.roleModelOverrides}
    onSetRoleCount={spy('onSetRoleCount')}
    onSetRoleCli={spy('onSetRoleCli')}
    onSetRoleModel={spy('onSetRoleModel')}
    cliOptions={cliOptions}
    registry={null}
    registryStatus="ready"
    disabledRoleIds={null}
    rosterDisabled={false}
    hasExistingTeam={false}
    rosters={[]}
    selectedRosterId={null}
    selectedRosterDirty={false}
    onSelectRoster={spy('onSelectRoster')}
    onSaveRoster={spy('onSaveRoster')}
    onUpdateRoster={spy('onUpdateRoster')}
    onRenameRoster={spy('onRenameRoster')}
    onDeleteRoster={spy('onDeleteRoster')}
    poolAgentCount={UNTOUCHED.maxParallelAgents}
    onChangePoolAgentCount={spy('onChangePoolAgentCount')}
  />,
)

const toolsPage = renderToStaticMarkup(
  <SprintEngineToolsPanel
    mcpCatalog={[]}
    mcpSettings={null}
    onToggleMcp={spy('onToggleMcp')}
    skillPackCatalog={[]}
    selectedSkillPackIds={new Set()}
    onToggleSkillPack={spy('onToggleSkillPack')}
    message={null}
    knowledgeProjectRoot={null}
    committedKnowledgeRoot={null}
    onCommitKnowledge={spy('onCommitKnowledge')}
    knowledgeAutoAppliedRef={{ current: new Set<string>() }}
    designSystemAttachRoot={null}
    designSystemAttachSelection={null}
    onSelectDesignSystemAttach={spy('onSelectDesignSystemAttach')}
  />,
)

const startPage = renderToStaticMarkup(
  <SprintEngineStartPanel
    workspaceName="Sprint Roster"
    folderPath="/repo"
    objective="Ship the thing"
    rosterMode="pool"
    hasExistingTeam={false}
    existingTeamName={null}
    roleCounts={UNTOUCHED.roleCounts}
    registry={null}
    disabledRoleIds={null}
    cliOptions={cliOptions}
    roleCliDefaults={UNTOUCHED.roleCliDefaults}
    roleModelOverrides={UNTOUCHED.roleModelOverrides}
    poolAgentCount={UNTOUCHED.maxParallelAgents}
    selectedToolNames={[]}
    selectedSkillPackCount={0}
    onEditStep={spy('onEditStep')}
    cliPermissionPreset={UNTOUCHED.cliPermissionPreset as never}
    onChangeCliPermissionPreset={spy('onChangeCliPermissionPreset')}
    automationMode={'run_agents_and_approve_artifacts' as never}
    onChangeAutomationMode={spy('onChangeAutomationMode')}
    maxParallelAgents={UNTOUCHED.maxParallelAgents}
    onChangeMaxParallelAgents={spy('onChangeMaxParallelAgents')}
    // Pool mode: the Team page's stepper owns this value.
    showMaxParallelAgents={false}
    useWorktrees={UNTOUCHED.useWorktrees}
    onChangeUseWorktrees={spy('onChangeUseWorktrees')}
    worktreesDisabled={false}
    // Untouched, a run works in one project: "Also works in" is an explicit pick.
    declaredRepoNames={[]}
    createError={null}
  />,
)

assert.deepEqual(mutations, [], 'rendering the skipped pages changes no wizard state')

// The pages render the defaults they were handed, so a user who DOES walk them
// sees — and leaves — the same values a skip would have sent.
// The plain-agents team page is the stepper + one agent picker, not the
// specialist roster list.
assert.ok(teamPage.includes('How many agents'), 'the team page opens on the plain agents stepper')
assert.ok(teamPage.includes('Plain agent pool'), 'and the segmented control names the pool segment')
// The agent count the stepper shows IS the default create sends (the plain
// stepper drives the concurrency cap), so a page showing something else would be
// showing a value the skipped create never had.
assert.ok(
  teamPage.includes(`>${UNTOUCHED.maxParallelAgents}<`),
  'the stepper shows the default agent count',
)
// The tools page is optional and renders its empty state without inventing state.
assert.ok(toolsPage.includes('Search tools and skills'), 'the tools page renders its search field')
// The review-&-start page renders the run settings; in pool mode it drops its
// own cap row — the Team page's stepper owns that value, so it must not appear twice.
assert.ok(startPage.includes('Run settings'), 'the start page renders the run settings')
assert.doesNotMatch(startPage, /id="sprintengine-max-parallel-agents"/, 'the start page shows no duplicate agent-cap input in pool mode')
// The worktrees switch reflects the same default (off).
assert.doesNotMatch(startPage, /aria-label="Run in an isolated git worktree"[^>]*aria-checked="true"/, 'worktrees start off')

// The other channel a default could sneak in through is a mount effect: it does
// not run under static markup, and on a skip its page never mounts at all — so
// any default it seeded would exist on the walked path and be missing on the
// skipped one. None of the step-body panels may own one. (The tools page's
// knowledge/design-system sub-steps keep their own guarded effects — they write
// project-level settings, not run state, and are unchanged from the old
// Advanced setup surface.)
for (const file of [
  'WizardControls.tsx',
  'SprintEngineRosterTable.tsx',
  'SprintEngineRosterPanel.tsx',
  'SprintEngineToolsPanel.tsx',
  'SprintEngineStartPanel.tsx',
]) {
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
// page" and "walk to the review-&-start page and create" differ only in the
// state each carries. The renders above proved the walk carries the same state.
const walked: SprintWizardState = { ...UNTOUCHED }

function creationArgsFor(state: SprintWizardState) {
  return buildSprintEngineNewTeamCreation({
    folderPath: '/repo',
    teamName: 'Sprint Roster',
    goal: 'Ship the thing',
    // Plain-agents default: create stages the effective general seat, not the
    // specialist roster the pool segment holds collapsed.
    roleCounts: state.effectiveCreateRoleCounts,
    visibleRoleCounts: state.effectiveCreateRoleCounts,
    maxParallelAgents: state.maxParallelAgents,
    roleCliDefaults: state.roleCliDefaults,
    roleModelOverrides: state.roleModelOverrides,
    startRunner: state.startRunner,
    autoApproveArtifacts: state.autoApproveArtifacts,
    useWorktrees: state.useWorktrees,
    cliPermissionPreset: state.cliPermissionPreset as never,
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
// + approve eligible artifacts), and no workflow init keys — an untouched run
// keeps every engine default.
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
// The wizard no longer composes any workflow-override init key, so an untouched
// run cannot send one: the sprint create call must mention none of them.
for (const key of ['defaultPhases', 'requiredSweeps']) {
  assert.doesNotMatch(
    panelSource,
    new RegExp(`\\b${key}:`),
    `the wizard sends no ${key} init key — the run keeps the engine default`,
  )
}

// The create path reads state, never the page: if it ever branched on `step`, the
// two paths above could diverge no matter how equal their state was.
const sprintCreateCall = panelSource.slice(
  panelSource.indexOf('await runSprintEngineNewTeamCreation('),
  panelSource.indexOf('onCreate(args)', panelSource.indexOf('await runSprintEngineNewTeamCreation(')),
)
assert.ok(sprintCreateCall.length > 0, 'found the sprint create call')
assert.doesNotMatch(sprintCreateCall, /\bstep\b|\bstepIndex\b|\bisLastStep\b/, 'sprint create never reads the current page')

console.log('skipToCreateDefaults.test.tsx: ok')
