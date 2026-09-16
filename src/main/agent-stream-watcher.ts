// Pure logic for watching an agent's pty output stream to drive the two
// plugin-driven lifecycle hooks introduced in BYO-CLI Phase 3:
//
//   - send-after-ready injection: wait for a readiness pattern in the output
//     stream, then write the user prompt to stdin. This lets the autonomous
//     runner stop using `claude --print` (which bills as full-rate API
//     usage) and instead drive an interactive subscription-billed session.
//
//   - output-sentinel completion: watch the output stream for a sentinel
//     literal the agent is taught to emit at the end of its turn, and tear
//     the session down without waiting for the process to exit.
//
// This watcher is plugin-descriptor driven (agent plugins choose
// their own sentinel literal).
//
// No I/O, no pty, no electron — just the pure stream-matching state machine
// so the runtime wiring stays thin and the tricky bits stay unit-testable.

export type AgentStreamWatcherInput = {
  readinessPattern?: RegExp
  completionSentinel?: string
  rollingBufferSize?: number
}

type AgentStreamWatcherIngestResult = {
  readyMatched: boolean
  completionMatched: boolean
}

export type AgentStreamWatcher = {
  ingest(chunk: string): AgentStreamWatcherIngestResult
  reset(): void
}

const DEFAULT_ROLLING_BUFFER_SIZE = 8192

export function createAgentStreamWatcher(input: AgentStreamWatcherInput): AgentStreamWatcher {
  const bufferSize = Math.max(64, input.rollingBufferSize ?? DEFAULT_ROLLING_BUFFER_SIZE)
  let buffer = ''
  let readyAlreadyMatched = false
  let completionAlreadyMatched = false

  function ingest(chunk: string): AgentStreamWatcherIngestResult {
    if (chunk.length === 0) {
      return { readyMatched: false, completionMatched: false }
    }
    buffer = buffer.length + chunk.length > bufferSize
      ? buffer.slice(-(bufferSize - chunk.length)) + chunk
      : buffer + chunk

    const result: AgentStreamWatcherIngestResult = {
      readyMatched: false,
      completionMatched: false,
    }

    if (!readyAlreadyMatched && input.readinessPattern && input.readinessPattern.test(buffer)) {
      readyAlreadyMatched = true
      result.readyMatched = true
    }

    if (
      !completionAlreadyMatched &&
      input.completionSentinel &&
      buffer.includes(input.completionSentinel)
    ) {
      completionAlreadyMatched = true
      result.completionMatched = true
    }

    return result
  }

  function reset(): void {
    buffer = ''
    readyAlreadyMatched = false
    completionAlreadyMatched = false
  }

  return { ingest, reset }
}
