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
