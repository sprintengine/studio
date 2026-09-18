import { recordPerfEvent } from './diagnostics/perfEventStore'

type PerfPayload = Record<string, unknown>

export function perfDiagnosticsEnabled(): boolean {
  return Boolean(import.meta.env.DEV || (typeof window !== 'undefined' && window.api?.isDiagnosticsEnabled))
}

export function logPerfEvent(scope: string, event: string, payload: PerfPayload = {}): void {
  if (!perfDiagnosticsEnabled()) return
  // Feed the in-memory rollup the diagnostics panel reads, then keep the console
  // line for live tailing. Only the `elapsedMs` field is pulled for percentiles;
  // events without it still count toward call volume.
  const elapsedMs =
    typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs) ? payload.elapsedMs : null
  recordPerfEvent(scope, event, elapsedMs)
  console.info(`[${scope}] ${event} ${JSON.stringify(payload)}`)
}
