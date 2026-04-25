export function normalizeAgentIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function prependAgentIdentifier(prompt: string, identifier: string): string {
  const normalizedIdentifier = normalizeAgentIdentifier(identifier)
  if (!normalizedIdentifier) return prompt

  return [
    `Agent name: ${normalizedIdentifier}`,
    'Use this exact name as your identifier in status updates, task claims, notes, and recovery context.',
    '',
    prompt,
  ].join('\n')
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
