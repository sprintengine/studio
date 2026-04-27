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

export function buildSwarmStartupPrompt(
  role: string,
  agentId: string,
  goal: string,
  options: {
    executionCwd?: string
    swarmStatePath?: string
  } = {}
): string {
  const command = role === 'architect'
    ? `Run \`swarm init --goal ${quoteShellArg(goal)}\` to receive your full prompt and instructions.`
    : `Run \`swarm join --role ${role} --id ${agentId}\` to receive your full prompt and next directive.`

  const context = [
    options.executionCwd ? `Worker cwd: ${options.executionCwd}` : null,
    options.swarmStatePath ? `Shared swarm state: ${options.swarmStatePath}` : null,
  ].filter(Boolean)

  return [
    'Fetch the canonical swarm instructions from the Python tool.',
    context.length > 0 ? context.join('\n') : null,
    command,
  ].filter(Boolean).join('\n\n')
}
