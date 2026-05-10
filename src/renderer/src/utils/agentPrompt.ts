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

  return [
    'Fetch the canonical Sprint Engine instructions from the Python tool.',
    context.length > 0 ? context.join('\n') : null,
    `You are assigned role: ${role}. Only claim and work Sprint Engine tasks whose role exactly matches ${role}. Keep polling for ready ${role} tasks with this same agent id: claim one task, complete it, publish evidence, mark it done, then poll again. If no ${role} task is ready, wait briefly and rerun the Sprint Engine join/task-next flow instead of exiting while this Sprint Engine roster session remains active. Stop only when auto mode is paused, you are blocked, you need user input, the terminal is being shut down, or your context window is about 70% full. At about 70% context, publish a concise continuation note, compact or restart, fetch your Soul again, rerun the Sprint Engine join command with this same id, and continue. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.`,
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
