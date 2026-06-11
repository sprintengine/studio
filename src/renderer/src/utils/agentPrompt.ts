import type { SprintEngineState } from '../types/workspace'

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
  role: string,
  agentId: string,
  goal: string,
  options: {
    executionCwd?: string
    workspaceRoot?: string
    sprintEngineStatePath?: string
    rosterArgs?: string[]
    commandMode?: 'init' | 'join'
    autonomousPlanningOverride?: boolean
    useWorktrees?: boolean
  } = {}
): string {
  const commandMode = options.commandMode ?? (role === 'architect' ? 'init' : 'join')

  // The managed Sprint Engine MCP server resolves run and workspace routing
  // from the HTTP run context. Agents do not pass statePath or
  // workspaceRoot in tool payloads.
  const joinPayload = {
    role,
    agentId,
  }
  const directivePayload = {
    role,
    agentId,
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
      'Then request your structured directive with `sprintengine.agent.next_directive`:',
      jsonBlock(directivePayload),
    ].join('\n')
    : [
      '## First MCP Calls',
      'Call `sprintengine.help` first to read the current Sprint Engine MCP workflow contract:',
      jsonBlock(helpPayload),
      'Register this agent with `sprintengine.agent.join`:',
      jsonBlock(joinPayload),
      'Then request your structured directive with `sprintengine.agent.next_directive`:',
      jsonBlock(directivePayload),
    ].join('\n')

  const directiveContract = [
    '## Directive Contract',
    '`sprintengine.agent.next_directive` returns a structured payload:',
    '- `nextMcpToolName` and `nextMcpArguments` are the exact MCP tool and payload to invoke next, or `null` when there is no follow-up tool.',
    'Use `sprintengine.help` for the current workflow/tool details instead of relying on this startup prompt.',
  ].join('\n')

  const autoModeBlock = [
    '## Directive Handling',
    'After you finish one task or gate, publish evidence or a gate verdict as described by `sprintengine.help`.',
    'If a returned directive includes `nextMcpToolName`, invoke it once with `nextMcpArguments`; otherwise there is no MCP tool to invoke for that directive.',
    'Multicode owns later runtime dispatch and continuation.',
  ].join('\n')

  const roleBoundary = [
    '## Role Boundaries',
    `You are assigned role: ${role}. Only claim work whose Sprint Engine \`task.role\` matches \`${role}\`. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role. You may read other roles' state via MCP read tools to diagnose blockers.`,
    'Sprint Engine work runs through the managed `multicode-sprintengine` MCP server in this terminal. If the managed MCP server cannot be reached, stop and surface the failure.',
  ].join('\n')

  const missingRunNote = commandMode === 'join' && options.sprintEngineStatePath
    ? 'If `sprintengine.agent.join` or `sprintengine.agent.next_directive` reports that the run is missing, surface the failure to the caller/runtime with the same payload context. Do not create a different run.'
    : null

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    commandMode === 'init' && options.rosterArgs?.length
      ? `Selected Sprint Engine roster: ${options.rosterArgs.join(', ')}. The architect must create tasks only for roles present in this roster.`
      : null,
  ].filter(Boolean)
  const autonomousPlanningOverride = options.autonomousPlanningOverride
    ? [
      '## Autonomous Planning Override',
      'Sprint Engine automation mode is Run agents + approve artifacts. Treat this as user intent for non-interactive planning and artifact-gate progression.',
      'Agent automation controls spawning; artifact approval automation is the signal to skip normal grilling.',
      'Use approved artifacts, the Knowledge Graph, current code, tests, and commands to answer discovery questions yourself where possible.',
      'Do not pause for ordinary preference, naming, scope-shaping, or plan-review questions. Proceed with conservative defaults, record them in `plan.md`, and only ask the user if a decision is unsafe to default, destructive, privacy/security-sensitive, legally sensitive, impossible to verify, or blocked by a missing dependency.',
    ].join('\n')
    : null

  return [
    'Your first action is to run the MCP calls listed in the "First MCP Calls" section below, in order, exactly as shown. Do not call any other tool first. Do not summarize your role or describe what you are about to do. The `sprintengine.agent.join` response contains your Soul, your role rules, and your initial directive — read those after registering, then act on the directive immediately.',
    context.length > 0 ? context.join('\n') : null,
    autonomousPlanningOverride,
    roleBoundary,
    initBlock,
    directiveContract,
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
