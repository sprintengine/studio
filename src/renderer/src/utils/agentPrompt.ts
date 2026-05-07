import type { SwarmState } from '../types/workspace'

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

function buildWindowsSwarmToolCommand(command: string, workspaceRoot?: string): string {
  const python = workspaceRoot
    ? `${workspaceRoot.replace(/[\\/]+$/u, '')}\\.venv\\Scripts\\python.exe`
    : '.\\.venv\\Scripts\\python.exe'
  return `& ${quotePowerShellArg(python)} .\\scripts\\sprintengine_tool.py ${command}`
}

function quotePowerShellArg(value: string): string {
  return `"${value.replace(/"/g, '`"')}"`
}

export function buildSwarmStartupPrompt(
  role: string,
  agentId: string,
  goal: string,
  options: {
    executionCwd?: string
    workspaceRoot?: string
    swarmStatePath?: string
    rosterArgs?: string[]
    commandMode?: 'init' | 'join'
  } = {}
): string {
  const commandMode = options.commandMode ?? (role === 'architect' ? 'init' : 'join')
  const rosterFlags = commandMode === 'init' && options.rosterArgs?.length
    ? ` ${options.rosterArgs.map((arg) => `--agent ${quoteShellArg(arg)}`).join(' ')}`
    : ''
  const swarmCommand = commandMode === 'init'
    ? `init --goal ${quoteShellArg(goal)}${rosterFlags}`
    : `join --role ${role} --id ${agentId}`
  const command = commandMode === 'init'
    ? `Run \`sprintengine ${swarmCommand}\` to receive your full prompt and instructions.`
    : `Run \`sprintengine ${swarmCommand}\` to receive your full prompt and next directive.`

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    options.swarmStatePath ? `Shared Sprint Engine state: ${options.swarmStatePath}` : null,
    commandMode === 'init' && options.rosterArgs?.length
      ? `Selected Sprint Engine roster: ${options.rosterArgs.join(', ')}. The architect must create tasks only for roles present in this roster.`
      : null,
  ].filter(Boolean)

  return [
    'Fetch the canonical Sprint Engine instructions from the Python tool.',
    context.length > 0 ? context.join('\n') : null,
    `You are assigned role: ${role}. Only claim and work Sprint Engine tasks whose role exactly matches ${role}. Keep picking up ready ${role} tasks with this same agent id until no ${role} task is ready, you are blocked, you need user input, or your context window is about 70% full. Do not claim, complete, mark ready, or otherwise advance tasks assigned to any other role.`,
    [
      'On Windows, prefer the repo virtual environment command if `sprintengine` or global Python is unreliable:',
      '```powershell',
      buildWindowsSwarmToolCommand(swarmCommand, options.workspaceRoot),
      '```',
    ].join('\n'),
    command,
  ].filter(Boolean).join('\n\n')
}

export function getSwarmStartupCommandMode(
  role: string,
  agentId: string,
  swarmState: Pick<SwarmState, 'tasks'> | null | undefined
): 'init' | 'join' {
  if (role !== 'architect') return 'join'
  if (agentId !== 'architect') return 'join'

  const hasCompletedArchitectTask = swarmState?.tasks.some((task) =>
    task.role === 'architect' && task.status === 'done'
  )
  return hasCompletedArchitectTask ? 'join' : 'init'
}
