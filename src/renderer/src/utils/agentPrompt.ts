import type {
  SprintEngineAllowedRuntime,
  SprintEngineModelCatalogEntry,
  SprintEngineRoleId,
  SprintEngineRosterSource,
  SprintEngineState,
} from '../types/workspace'

export function normalizeAgentIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function normalizeRoleLabel(value: string): string {
  const normalized = normalizeAgentIdentifier(value)
  if (!normalized) return ''

  const [firstWord, ...rest] = normalized.split(' ')
  return [firstWord, ...rest.map((word) => word.toLowerCase())].join(' ')
}

export function prependAgentIdentifier(
  prompt: string,
  identifier: string,
  roleLabel?: string
): string {
  const normalizedIdentifier = normalizeAgentIdentifier(identifier)
  if (!normalizedIdentifier) return prompt

  const normalizedRole = roleLabel ? normalizeRoleLabel(roleLabel) : ''
  const prefix = normalizedRole
    ? `${normalizedIdentifier}: ${normalizedRole} - `
    : `${normalizedIdentifier}: `

  return `${prefix}${prompt}`
}

function jsonBlock(payload: Record<string, unknown>): string {
  return ['```json', JSON.stringify(payload, null, 2), '```'].join('\n')
}

// One palette line for an architect-roster startup prompt: the ticked runtime
// joined to its global-model-catalog scores by cli+model. Scores/notes are never
// stored on the run — they live in the catalog — so an entry the user deleted
// since creation degrades to a scoreless line rather than vanishing.
function formatSprintPaletteLine(
  runtime: SprintEngineAllowedRuntime,
  catalog: SprintEngineModelCatalogEntry[],
): string {
  const modelLabel = runtime.model ?? '(CLI default)'
  const head = `${runtime.cli} / ${modelLabel}`
  const entry = catalog.find((candidate) => candidate.cli === runtime.cli && candidate.model === runtime.model)
  if (!entry) return `- ${head} — scores not in your model catalog`
  const scores = `intelligence ${entry.intelligence} · frontend design ${entry.frontendDesign} · mobile ${entry.mobile} · speed ${entry.speed} · cost ${entry.cost}x`
  return `- ${head} — ${scores}${entry.note ? ` — ${entry.note}` : ''}`
}

// The architect-roster boundary block: replaces the fixed-roster boundary line
// (MC-1454) only when the run's roster is architect-chosen. States the ticked
// model palette as the closed set the engine enforces, quotes the user's
// guidance verbatim when set, and gives the configure-then-plan sequence. Pure
// text — no statePath/workspaceRoot, preserving the autonomous-payload invariant.
function buildArchitectRosterBoundaryBlock(
  allowedRuntimes: SprintEngineAllowedRuntime[],
  modelCatalog: SprintEngineModelCatalogEntry[],
  guidance: string | undefined,
): string {
  const paletteLines = allowedRuntimes.length > 0
    ? allowedRuntimes.map((runtime) => formatSprintPaletteLine(runtime, modelCatalog))
    : ['- (no models were selected for this run)']
  const trimmedGuidance = guidance?.trim()
  return [
    '## Your Run\'s Team — You Pick It',
    'This run\'s roster is not preset. Survey the work, then choose the roles and one model per role and record the team for the user to approve. Only your own architect seat is fixed (it runs this planning session).',
    'Models for this sprint — the ONLY models you may assign to a role; `sprintengine.roster.configure` rejects anything else:',
    paletteLines.join('\n'),
    'Match each role to the score its work exercises: planning → intelligence; frontend/creative/UI-heavy tasks → frontend design; mobile surfaces → mobile; mechanical, well-specified tasks → speed and cost. Reviews are where quality is enforced — give review-capability roles the highest-intelligence model you can justify against its cost multiplier, and name that trade-off in the Team table. Pick the cheapest model that clears each role\'s bar. Notes are guidance to weigh, not rules.',
    trimmedGuidance ? `The user's guidance for this sprint: "${trimmedGuidance}"` : null,
    'Do this, in order:',
    [
      '1. Survey the goal and codebase before choosing anyone.',
      '2. List the available roles with the role-read tools, then pick the SMALLEST team that covers the work.',
      '3. Call `sprintengine.roster.configure` with your chosen roles and one cli/model each (from the palette above) BEFORE creating any task.',
      '4. Record the team in `plan.md` under a `## Team` section: one row per role with its cli/model and a one-line why — including which review roles you chose and why, and which you deliberately left off.',
      '5. Non-default review roles (security, performance, ui_ux_reviewer, cross_platform, production_readiness_reviewer) only gate a task when you attach them with `plan add-task --require-gate <role-id>`.',
      '6. You may revise the team with another `sprintengine.roster.configure` call until the plan is approved; after approval the roster is locked and any later gap routes to needs_input(user).',
    ].join('\n'),
  ].filter(Boolean).join('\n')
}

export function buildSprintEngineStartupPrompt(
  role: string,
  agentId: string,
  goal: string,
  options: {
    executionCwd?: string
    workspaceRoot?: string
    sprintEngineStatePath?: string
    rosterArgs?: string[]
    configuredRoles?: SprintEngineRoleId[]
    // Architect-roster ("Architect picks the team") inputs. When rosterSource is
    // 'architect' and the role is architect, the fixed-roster boundary line is
    // replaced by the configure-then-plan block built from the ticked model
    // palette (allowedRuntimes joined to modelCatalog for scores) and the
    // optional guidance line. Absent/'user' keeps the existing boundary line.
    rosterSource?: SprintEngineRosterSource
    allowedRuntimes?: SprintEngineAllowedRuntime[]
    modelCatalog?: SprintEngineModelCatalogEntry[]
    architectGuidance?: string
    commandMode?: 'init' | 'join'
    autonomousPlanningOverride?: boolean
    useWorktrees?: boolean
    claimTool?: 'sprintengine.task.next' | 'sprintengine.gate.next'
  } = {}
): string {
  const commandMode = options.commandMode ?? (role === 'architect' ? 'init' : 'join')
  // A General is the soul-less single-agent variant: it joins (never inits) and
  // owns the whole sprint — plan, build, self-review, test, publish. The launch
  // wiring (managed MCP + state path) is identical to a specialist; only the
  // role and the soul-less join result differ.
  const isGeneral = role === 'general' && commandMode !== 'init'
  const claimTool = options.claimTool ?? 'sprintengine.task.next'
  const fallbackClaimTool = claimTool === 'sprintengine.task.next'
    ? 'sprintengine.gate.next'
    : 'sprintengine.task.next'

  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  const joinPayload = {
    role,
    agentId,
  }
  const claimPayload = {
    role,
    id: agentId,
  }
  const helpPayload = {
    role,
    agentId,
    topic: 'agent_workflow',
  }
  const initPayload: Record<string, unknown> = {
    goal: goal || '<run goal>',
  }
  if (options.rosterArgs?.length) initPayload.agent = options.rosterArgs
  // Worktree mode is set at workspace creation. The architect's init call
  // creates (or reuses) the one shared run worktree + branch so every agent
  // works and commits in the same isolated checkout.
  if (options.useWorktrees) initPayload.useWorktrees = true

  const initBlock = commandMode === 'init'
    ? [
      '## First MCP Calls — architect bootstrap',
      'Call `sprintengine.help` first to read the current Sprint Engine MCP workflow contract:',
      jsonBlock(helpPayload),
      'Call `sprintengine.init` once to initialize the run:',
      jsonBlock(initPayload),
      'Then register as the architect agent with `sprintengine.agent.join`:',
      jsonBlock(joinPayload),
      'Then claim your first architect task with `sprintengine.task.next`:',
      jsonBlock(claimPayload),
    ].join('\n')
    : [
      '## First MCP Calls',
      'Call `sprintengine.help` first to read the current Sprint Engine MCP workflow contract:',
      jsonBlock(helpPayload),
      'Register this agent with `sprintengine.agent.join`:',
      jsonBlock(joinPayload),
      `Then claim your work with \`${claimTool}\`:`,
      jsonBlock(claimPayload),
    ].join('\n')

  const noClaimFallback = commandMode === 'init'
    ? 'If it returns no claim, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.'
    : isGeneral
      ? `If it returns no claim, call \`${fallbackClaimTool}\` once with the same payload — prefer satisfying your own pending review/testing gates before starting new work. If neither returns work and the run has no task graph yet, you are the planner: create the tasks and their quality gates, self-approve the plan gate, then claim your first task. If a plan already exists and nothing is claimable, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.`
      : `If it returns no claim, call \`${fallbackClaimTool}\` once with the same payload. If neither returns work, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.`

  const claimContract = [
    '## Claim Contract',
    `\`${claimTool}\` claims the next ready item for your role, or returns your active one to resume. Work what it returns.`,
    noClaimFallback,
    'Use `sprintengine.help` for the current workflow/tool details instead of relying on this startup prompt.',
  ].join('\n')

  // Belt-and-braces with the orchestration skill the General reads from the
  // join response: reinforce the full loop and the no-roster-growth rule so the
  // single agent drives plan → build → review → publish itself.
  const generalLoopBlock = isGeneral
    ? [
      '## General Orchestration',
      'You are a General: one soul-less agent that owns this whole sprint. With no architect and no specialists, you plan the work, implement it, review it, test it, and publish it yourself. When several Generals run, you share the work by claiming tasks and gates — no central coordinator assigns anything.',
      'Drive every piece of work through the same loop, in order: plan → build → self-review → test → publish. Finish and review/test your open tasks through to done before claiming new ready work, and prefer your own pending review/testing gates over starting a fresh task.',
      'When the run has no task graph yet, you are the planner: author the tasks with their quality gates (typically a self-review gate and a testing gate), self-approve the plan gate, then implement. Multicode owns run initialization — you never initialize the run yourself.',
      'Keep the team exactly the size the user set: never add roster members or specialists. Read your full role rules from the `sprintengine.agent.join` response.',
    ].join('\n')
    : null

  const autoModeBlock = [
    '## Completion Handling',
    'After you finish one task or gate, publish evidence or a gate verdict as described by `sprintengine.help`, then stop.',
    'Multicode owns dispatch and continuation: it re-engages this terminal when more work is ready. Do not keep checking for work.',
  ].join('\n')

  const roleBoundary = [
    '## Role Boundaries',
    `You are assigned role: ${role}. Only claim work whose sprint \`task.role\` matches \`${role}\`. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role. You may read other roles' state via MCP read tools to diagnose blockers.`,
    'Sprint Engine work runs through the managed `multicode-sprintengine` MCP server in this terminal. If the managed MCP server cannot be reached, stop and surface the failure.',
  ].join('\n')

  const missingRunNote = commandMode === 'join' && options.sprintEngineStatePath
    ? `If \`sprintengine.agent.join\` or \`${claimTool}\` reports that the run is missing, surface the failure to the caller/runtime with the same payload context. Do not create a different run.`
    : null

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    // The configured-roster boundary rides EVERY architect dispatch (init and
    // wake), not just init: the roster is an enforced invariant, so a woken
    // architect planning later tasks must keep scheduling only for the run's
    // roles and escalate to the user rather than inventing an off-roster role.
    role === 'architect' && options.rosterSource === 'architect'
      ? buildArchitectRosterBoundaryBlock(
        options.allowedRuntimes ?? [],
        options.modelCatalog ?? [],
        options.architectGuidance,
      )
      : role === 'architect' && options.configuredRoles?.length
        ? `Your run's roles are: ${options.configuredRoles.join(', ')}. Create tasks and schedule reviews only for these roles. If the work needs a role you don't have, raise needs_input to the user rather than adding the role.`
        : null,
  ].filter(Boolean)
  const autonomousPlanningOverride = options.autonomousPlanningOverride
    ? [
      '## Autonomous Planning Override',
      'Sprint automation mode is Run agents + approve artifacts. Treat this as user intent for non-interactive planning and artifact-gate progression.',
      'Agent automation controls spawning; artifact approval automation is the signal to skip normal grilling.',
      'Use approved artifacts, the Knowledge Graph, current code, tests, and commands to answer discovery questions yourself where possible.',
      'Do not pause for ordinary preference, naming, scope-shaping, or plan-review questions. Proceed with conservative defaults, record them in `plan.md`, and only ask the user if a decision is unsafe to default, destructive, privacy/security-sensitive, legally sensitive, impossible to verify, or blocked by a missing dependency.',
    ].join('\n')
    : null

  return [
    'Your first action is to run the MCP calls listed in the "First MCP Calls" section below, in order, exactly as shown. Do not call any other tool first. Do not summarize your role or describe what you are about to do. The `sprintengine.agent.join` response contains your Soul and your role rules — read those after registering, then claim your work immediately.',
    context.length > 0 ? context.join('\n') : null,
    autonomousPlanningOverride,
    roleBoundary,
    initBlock,
    claimContract,
    generalLoopBlock,
    autoModeBlock,
    missingRunNote,
  ].filter(Boolean).join('\n\n')
}

export function getSprintEngineStartupCommandMode(
  role: string,
  agentId: string,
  sprintEngineState: Pick<SprintEngineState, 'tasks'> | null | undefined
): 'init' | 'join' {
  if (role !== 'architect') return 'join'
  if (agentId !== 'architect') return 'join'
  return sprintEngineState?.tasks.length ? 'join' : 'init'
}
