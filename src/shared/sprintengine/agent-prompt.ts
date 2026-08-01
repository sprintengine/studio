/**
 * Sprint Engine agent prompt builders, shared by the renderer and the main
 * process.
 *
 * Relocated verbatim from `src/renderer/src/utils/agentPrompt.ts`
 * (sprint-runtime-ownership Phase 2: the main process runs the auto-run
 * planner, which composes these prompts), following the established shim
 * pattern (`sprintengineAutomationLifecycle.ts`). The renderer file remains
 * as a re-export shim, so every existing import site and test keeps working
 * unchanged.
 */
import type {
  SprintEngineRoleId,
  SprintEngineState,
} from './run-types'
import { STUDIO_MCP_SERVER_ID } from '../product-identity'

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

export function buildSprintEngineStartupPrompt(
  role: string | undefined,
  agentId: string,
  goal: string,
  options: {
    executionCwd?: string
    workspaceRoot?: string
    sprintEngineStatePath?: string
    rosterArgs?: string[]
    configuredRoles?: SprintEngineRoleId[]
    commandMode?: 'init' | 'join'
    autonomousPlanningOverride?: boolean
    useWorktrees?: boolean
  } = {}
): string {
  const commandMode = options.commandMode ?? (role === 'architect' ? 'init' : 'join')
  // A roleless agent joins (never inits) and works a shared task graph as a
  // pool — plan, build, self-review, test, publish, owning each task from claim
  // to done. The launch wiring (managed MCP + state path) is identical to a
  // specialist; only the absent role and the roleless join result differ. This
  // used to key off the literal role `general`, which existed only so an agent
  // with no role could be named on the wire (MC-2057).
  const isRoleless = !role && commandMode !== 'init'
  // One claim tool. MC-1542 deleted `gate.next`: an agent owns its task from claim
  // to done, so there is no second queue to fall back to.
  const claimTool = 'sprintengine.task.next'

  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  // A roleless agent omits `role` rather than sending a stand-in — the engine
  // schema marks it optional precisely so a roleless sprint can leave it out.
  const rolePayload = role ? { role } : {}
  const joinPayload = {
    ...rolePayload,
    agentId,
  }
  const claimPayload = {
    ...rolePayload,
    id: agentId,
  }
  const helpPayload = {
    ...rolePayload,
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
    : isRoleless
      ? 'If it returns no claim and the run has no task graph yet, you are the planner: create the tasks, self-approve the plan artifact, then claim your first task. If a plan already exists and nothing is claimable, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.'
      : 'If it returns no claim, reply that no work was claimed and stop — Multicode re-engages this terminal when work is ready.'

  const claimContract = [
    '## Claim Contract',
    role
      ? `\`${claimTool}\` claims the next ready item for your role, or returns your active one to resume. Work what it returns.`
      : `\`${claimTool}\` claims the next ready item that carries no role, or returns your active one to resume. Work what it returns.`,
    noClaimFallback,
    'Use `sprintengine.help` for the current workflow/tool details instead of relying on this startup prompt.',
  ].join('\n')

  // Belt-and-braces with the orchestration skill a roleless agent reads from the
  // join response: reinforce the full loop and the roles-are-user-config rule
  // so the agent drives plan → build → review → publish itself.
  const rolelessLoopBlock = isRoleless
    ? [
      '## Orchestration',
      'You are an agent with no role, working a task graph shared with the other agents on this sprint. With no architect and no specialists, the sprint plans the work, implements it, reviews it, tests it, and publishes it. You take work by claiming tasks — no central coordinator assigns anything, and when several agents run, the same loop runs in parallel over the shared graph.',
      'Drive every piece of work through the same loop, in order: plan → build → publish → self-review → advance. You own a task from claim to done: carry each one through to done before claiming new ready work.',
      'When the run has no task graph yet, you are the planner: author the tasks, plan validation where testing is actually meaningful (one whole-flow task at the end, or one per milestone), self-approve the plan artifact, then implement. Multicode owns run initialization — you never initialize the run yourself.',
      'The run\'s roles are user config: if work seems to need a role the run does not have, raise it with `needs_input` and let the user decide — never invent or enable roles yourself. Read your full role rules from the `sprintengine.agent.join` response.',
    ].join('\n')
    : null

  const autoModeBlock = [
    '## Completion Handling',
    'After a task reaches `done`, stop. `sprintengine.help` describes the publish → review → advance lifecycle.',
    'Multicode owns dispatch and continuation: it re-engages this terminal when more work is ready. Do not keep checking for work.',
  ].join('\n')

  const mcpBoundaryLine = `Sprint Engine work runs through the managed \`${STUDIO_MCP_SERVER_ID}\` MCP server in this terminal. If the managed MCP server cannot be reached, stop and surface the failure.`
  const roleBoundary = role
    ? [
      '## Role Boundaries',
      `You are assigned role: ${role}. Only claim work whose sprint \`task.role\` matches \`${role}\`. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role. You may read other roles' state via MCP read tools to diagnose blockers.`,
      mcpBoundaryLine,
    ].join('\n')
    : [
      '## Work Boundaries',
      'You have no role. Claim only work that carries no role either — a task assigned to a named role belongs to that role, not to you.',
      mcpBoundaryLine,
    ].join('\n')

  const missingRunNote = commandMode === 'join' && options.sprintEngineStatePath
    ? `If \`sprintengine.agent.join\` or \`${claimTool}\` reports that the run is missing, surface the failure to the caller/runtime with the same payload context. Do not create a different run.`
    : null

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    // The run's roles are user config, not architect-picked ceremony. This
    // constraint rides EVERY architect dispatch (init and wake): the roster is
    // an enforced invariant, so a woken architect planning later tasks keeps
    // scheduling only for the run's roles and raises needs_input to the user
    // rather than inventing an off-roster role.
    role === 'architect' && options.configuredRoles?.length
      ? `Your run's roles are: ${options.configuredRoles.join(', ')}. Create tasks and schedule reviews only for these roles. If the work needs a role you don't have, raise needs_input to the user rather than adding the role.`
      : null,
  ].filter(Boolean)
  const autonomousPlanningOverride = options.autonomousPlanningOverride
    ? [
      '## Autonomous Planning Override',
      'Sprint automation mode is Run agents + approve artifacts. Treat this as user intent for non-interactive planning and artifact-approval progression.',
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
    rolelessLoopBlock,
    autoModeBlock,
    missingRunNote,
  ].filter(Boolean).join('\n\n')
}

export function getSprintEngineStartupCommandMode(
  role: string | undefined,
  agentId: string,
  sprintEngineState: Pick<SprintEngineState, 'tasks'> | null | undefined
): 'init' | 'join' {
  if (role !== 'architect') return 'join'
  if (agentId !== 'architect') return 'join'
  return sprintEngineState?.tasks.length ? 'join' : 'init'
}
