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

export function buildSwarmStartupPrompt(role: string, agentId: string, goal: string): string {
  const command = role === 'architect'
    ? `Run \`swarm init --goal "${goal}"\` to receive your full prompt and instructions.`
    : `Run \`swarm join --role ${role} --id ${agentId}\` to receive your full prompt and next directive.`

  return [
    'Fetch the canonical swarm instructions from the Python tool.',
    command,
  ].join('\n\n')
}
