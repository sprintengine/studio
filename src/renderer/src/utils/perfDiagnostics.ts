type PerfPayload = Record<string, unknown>

export function logPerfEvent(scope: string, event: string, payload: PerfPayload = {}): void {
  if (!import.meta.env.DEV) return
  console.info(`[${scope}] ${event}`, payload)
}
