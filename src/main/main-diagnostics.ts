import { app } from 'electron'

const DIAGNOSTIC_SLOW_IPC_MS = 250

type MainDiagnosticsOptions = {
  enabled: boolean
}

export function createMainDiagnostics({ enabled }: MainDiagnosticsOptions) {
  function logMainPerfEvent(scope: string, event: string, payload: Record<string, unknown>): void {
    if (app.isPackaged && !enabled) return
    console.info(`[${scope}] ${event}`, payload)
  }

  async function withIpcDiagnostics<T>(
    scope: string,
    event: string,
    payload: Record<string, unknown>,
    action: () => Promise<T>
  ): Promise<T> {
    const startedAt = Date.now()
    try {
      const result = await action()
      const elapsedMs = Date.now() - startedAt
      if (enabled || elapsedMs >= DIAGNOSTIC_SLOW_IPC_MS) {
        logMainPerfEvent(scope, event, {
          ...payload,
          elapsedMs,
          ok: true,
        })
      }
      return result
    } catch (error) {
      logMainPerfEvent(scope, `${event}-error`, {
        ...payload,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  return {
    logMainPerfEvent,
    withIpcDiagnostics,
  }
}
