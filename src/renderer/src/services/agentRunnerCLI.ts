import type { AgentMessage } from '../types/workspace'

// Active cleanup callbacks per agent — used by cancelAgentCLI
const cleanups = new Map<string, Array<() => void>>()

function buildPrompt(history: AgentMessage[], message: string): string {
  if (history.length === 0) return message

  const ctx = history
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n\n')

  return `Previous conversation:\n${ctx}\n\nHuman: ${message}`
}

export function runAgentCLI(
  agentId: string,
  history: AgentMessage[],
  message: string,
  callbacks: {
    onChunk: (chunk: string) => void
    onDone:  () => void
    onError: (err: Error) => void
  }
): void {
  const fns: Array<() => void> = []

  function cleanup() {
    fns.forEach((fn) => fn())
    cleanups.delete(agentId)
  }

  fns.push(
    window.api.onClaudeChunk(agentId, (chunk) => callbacks.onChunk(chunk))
  )
  fns.push(
    window.api.onClaudeDone(agentId, () => {
      cleanup()
      callbacks.onDone()
    })
  )
  fns.push(
    window.api.onClaudeError(agentId, (err) => {
      cleanup()
      callbacks.onError(new Error(err))
    })
  )

  cleanups.set(agentId, fns)

  const prompt = buildPrompt(history, message)
  window.api.claudeRun(agentId, prompt)
}

export function cancelAgentCLI(agentId: string): void {
  cleanups.get(agentId)?.forEach((fn) => fn())
  cleanups.delete(agentId)
  window.api.claudeCancel(agentId)
}
