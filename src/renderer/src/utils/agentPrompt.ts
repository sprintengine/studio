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
  const initPayload: Record<string, unknown> = {
    goal: goal || '<run goal>',
  }
  if (options.rosterArgs?.length) initPayload.agent = options.rosterArgs

  const initBlock = commandMode === 'init'
    ? [
      '## First MCP Calls — architect bootstrap',
      'Call `sprintengine.init` once to initialize the run:',
      jsonBlock(initPayload),
      'Then register as the architect agent with `sprintengine.agent.join`:',
      jsonBlock(joinPayload),
      'Then request your structured directive with `sprintengine.agent.next_directive`:',
      jsonBlock(directivePayload),
    ].join('\n')
    : [
      '## First MCP Calls',
      'Register this agent with `sprintengine.agent.join`:',
      jsonBlock(joinPayload),
      'Then request your structured directive with `sprintengine.agent.next_directive`:',
      jsonBlock(directivePayload),
    ].join('\n')

  const directiveContract = [
    '## Directive Contract',
    '`sprintengine.agent.next_directive` returns a structured payload:',
    '- `directiveType`: `task_work` | `resume` | `gate_work` | `needs_input_triage` | `idle` | `complete` | `blocked` | `error`',
    '- `nextMcpToolName` and `nextMcpArguments`: the exact MCP tool and payload to invoke next (or `null` when idle/complete/blocked)',
    '- `task`, `gate`, `triage`, `blocker`, `error`: contextual fields when applicable',
    '- `runnerPolicy.cliWatchPolling`: `enabled` or `disabled` (CLI-only; Multicode supervisor ignores)',
    'Invoke `nextMcpToolName` with `nextMcpArguments` verbatim to claim or resume work.',
  ].join('\n')

  const workflowTools = [
    '## Workflow MCP Tools',
    `- Claim next ready role work: \`sprintengine.task.next\` with \`{role, id: "${agentId}"}\`.`,
    `- Claim next ready quality gate: \`sprintengine.gate.next\` with \`{role, id: "${agentId}"}\`.`,
    `- Architect-actionable triage: \`sprintengine.triage.needs_input\` with \`{id: "${agentId}"}\`.`,
    '- Read a task card: `sprintengine.task.get` with `{taskId}`.',
    '- Log evidence: `sprintengine.task.log` with `{taskId, id, summary, file, command, result, scopeExpansionJson}`.',
    '- Publish implementation evidence: `sprintengine.task.publish` with `{taskId, id, summary, ...}`.',
    '- Register an artifact: `sprintengine.artifact.add` with `{taskId, kind, title, path, createdBy, ready}` — set `ready: true` only when the artifact must wait for human approval.',
    '- Record a gate verdict: `sprintengine.gate.verdict` (or `sprintengine.gate.publish`) with `{taskId, gateId, role, id, verdict, summary}`.',
    '- Move a task to `needs_input`: `sprintengine.task.status` with `{taskId, id, status: "needs_input", needsInputKind, needsInputReason, needsInputQuestion, needsInputArtifactId?, needsInputSuggestedResolution?}`.',
    '  - `needsInputKind` is the actor who must act: `architect` for task-card/scope/artifact-review/tooling/verification blockers, `user` for product decisions or approvals, `owner` when you are waiting for your own external condition.',
    '  - `needsInputReason` classifies the blocker: `task_scope`, `artifact_review`, `tooling`, `verification`, `product_decision`, or `blocked_other`.',
  ].join('\n')

  const autoModeBlock = [
    '## Directive Handling',
    'After you finish one task or gate, publish evidence (or a gate verdict) through the MCP tools above. If a returned directive includes `nextMcpToolName`, invoke it once with `nextMcpArguments`; otherwise there is no MCP tool to invoke for that directive.',
    'Multicode owns later runtime dispatch and continuation.',
    'Stop earlier if Auto Mode is off, you are blocked, you need user input, the terminal is being shut down, or your context window is about 70% full. At about 70% context, publish a concise continuation note via `sprintengine.task.note`, compact or restart, then fetch your Soul again via `sprintengine.soul.get` when the runtime continues this terminal.',
    'If you receive a Sprint Engine notification that your blocked task was resolved, re-read the task card via `sprintengine.task.get`, then continue that same task; if the notification says the task is complete, stop.',
  ].join('\n')

  const roleBoundary = [
    '## Role Boundaries',
    `You are assigned role: ${role}. Only claim work whose Sprint Engine \`task.role\` matches \`${role}\`. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role. You may read other roles' state via MCP read tools to diagnose blockers.`,
    'Sprint Engine work runs exclusively through the managed `multicode-sprintengine` MCP server in this terminal. Do not run `sprintengine` shell commands for autonomous Sprint Engine work; the CLI is reserved for human and debug operators. If the managed MCP server cannot be reached, stop and surface the failure — do not fall back to shell commands.',
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
    workflowTools,
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
