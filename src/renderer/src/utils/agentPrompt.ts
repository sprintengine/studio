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

function quoteShellArg(value: string): string {
  return JSON.stringify(value)
}

function buildWindowsSprintEngineToolCommand(command: string, workspaceRoot?: string): string {
  const python = workspaceRoot
    ? `${workspaceRoot.replace(/[\\/]+$/u, '')}\\.venv\\Scripts\\python.exe`
    : '.\\.venv\\Scripts\\python.exe'
  return `& ${quotePowerShellArg(python)} .\\scripts\\sprintengine_tool.py ${command}`
}

function quotePowerShellArg(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`
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
  const rosterFlags = commandMode === 'init' && options.rosterArgs?.length
    ? ` ${options.rosterArgs.map((arg) => `--agent ${quoteShellArg(arg)}`).join(' ')}`
    : ''
  const sprintEngineCommand = commandMode === 'init'
    ? `init --goal ${quoteShellArg(goal)}${rosterFlags}`
    : `join --role ${role} --id ${agentId}`
  const command = commandMode === 'init'
    ? `Run \`sprintengine ${sprintEngineCommand}\` to receive your full prompt and instructions.`
    : `Run \`sprintengine ${sprintEngineCommand}\` to receive your full prompt and next directive.`

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    options.sprintEngineStatePath ? `Shared Sprint Engine state: ${options.sprintEngineStatePath}` : null,
    commandMode === 'init' && options.rosterArgs?.length
      ? `Selected Sprint Engine roster: ${options.rosterArgs.join(', ')}. The architect must create tasks only for roles present in this roster.`
      : null,
  ].filter(Boolean)
  const autonomousPlanningOverride = options.autonomousPlanningOverride
    ? [
      '## Autonomous Planning Override',
      'Sprint Engine Approve all artifacts is enabled. Treat this as user intent for non-interactive planning and artifact-gate progression.',
      'Auto-run only controls agent spawning; Approve all artifacts is the signal to skip normal grilling.',
      'Use approved artifacts, the Knowledge Graph, current code, tests, and commands to answer discovery questions yourself where possible.',
      'Do not pause for ordinary preference, naming, scope-shaping, or plan-review questions. Proceed with conservative defaults, record them in `plan.md`, and only ask the user if a decision is unsafe to default, destructive, privacy/security-sensitive, legally sensitive, impossible to verify, or blocked by a missing dependency.',
    ].join('\n')
    : null

  return [
    'Fetch the canonical Sprint Engine instructions from the Python tool.',
    context.length > 0 ? context.join('\n') : null,
    autonomousPlanningOverride,
    `You are assigned role: ${role}. Only claim and work Sprint Engine tasks whose role exactly matches ${role}. Use the Sprint Engine join/task-next flow with this same agent id. If no ${role} task is ready, wait briefly with a foreground sleep/backoff, then retry while this Sprint Engine roster session remains active. Do not leave a background polling loop running, and stop all idle retrying as soon as a task is returned. After you claim one task, focus only on that task: complete it, publish evidence, mark it done, then stop. Stop earlier if auto mode is paused, you are blocked, you need user input, the terminal is being shut down, or your context window is about 70% full. If you move a task to needs_input, --needs-input-kind is the actor who must act: use architect for task-card/scope/artifact-review/tooling/verification blockers, user for product decisions or approvals, and owner when you are waiting for your own external condition. Add --needs-input-reason such as task_scope, artifact_review, tooling, verification, product_decision, or blocked_other; include --needs-input-artifact-id for artifact_review blockers when available. Include --needs-input-question and, when useful, --needs-input-suggested-resolution. If you receive a Sprint Engine notification that your blocked task was resolved, re-read the task card, notes, acceptance criteria, and evidence, then continue that same task; if the notification says the task is complete, stop. At about 70% context, publish a concise continuation note, compact or restart, fetch your Soul again, rerun the Sprint Engine join command with this same id, and continue. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.`,
    commandMode === 'join' && options.sprintEngineStatePath
      ? `If the shared Sprint Engine state file does not exist yet or the join command reports that state is missing, wait briefly and retry the same join command. Do not create a different state file and do not stop just because the architect has not initialized the run yet.`
      : null,
    [
      'On Windows, prefer the repo virtual environment command if `sprintengine` or global Python is unreliable:',
      '```powershell',
      buildWindowsSprintEngineToolCommand(sprintEngineCommand, options.workspaceRoot),
      '```',
    ].join('\n'),
    command,
  ].filter(Boolean).join('\n\n')
}

export function getSprintEngineStartupCommandMode(
  role: string,
  agentId: string,
  sprintEngineState: Pick<SprintEngineState, 'tasks'> | null | undefined
): 'init' | 'join' {
  if (role !== 'architect') return 'join'
  if (agentId !== 'architect') return 'join'

  const hasCompletedArchitectTask = sprintEngineState?.tasks.some((task) =>
    task.role === 'architect' && task.status === 'done'
  )
  return hasCompletedArchitectTask ? 'join' : 'init'
}
