type PerfPayload = Record<string, unknown>

export function perfDiagnosticsEnabled(): boolean {
  return Boolean(
    import.meta.env.DEV
    || (typeof window !== 'undefined' && window.api?.isDiagnosticsEnabled)
  )
}

export function logPerfEvent(scope: string, event: string, payload: PerfPayload = {}): void {
  if (!perfDiagnosticsEnabled()) return
  console.info(`[${scope}] ${event} ${JSON.stringify(payload)}`)
}
