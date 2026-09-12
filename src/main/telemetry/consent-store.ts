/**
 * Main-owned mirror of the "Share anonymous usage data" setting.
 *
 * Same one-way push contract as background mode and window material: the
 * renderer owns the preference (`appSettings.telemetryEnabled`) and pushes it
 * on change; main persists a copy because it has to answer the question at
 * moments when there is no renderer to ask — the `app.boot` event, a headless
 * sprint run, a flush on quit after the last window is gone.
 *
 * ABSENT READS AS ON, which is the one place this store differs from the
 * background-mode mirror, and it is a deliberate inversion rather than a
 * copy-paste slip. Background mode defaults off because off is the behaviour
 * that already shipped. Here, on is the product default the renderer itself
 * seeds, and the mirror exists only to stand in for the renderer before it has
 * spoken. Reading absent as off would mean the very first boot of every fresh
 * profile — the only boot that can ever report a new install — is the one
 * SprintEngine throws away.
 *
 * This store is one of three gates, and the weakest of them. Above it sit the
 * `SPRINTENGINE_TELEMETRY_ENABLED=false` environment kill switch and the
 * absence of a project key, either of which stops collection without consulting
 * it at all.
 *
 * Deliberately carries no revision counter: main never writes this value and
 * never broadcasts it back, so there is no echo to order.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE_NAME = 'telemetry-consent.json'

export type TelemetryConsentStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type TelemetryConsentStore = ReturnType<typeof createTelemetryConsentStore>

export function createTelemetryConsentStore(deps: TelemetryConsentStoreDeps) {
  let cached: boolean | null = null

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  return {
    /** The gate every `record` call consults. Never throws. */
    isEnabled(): boolean {
      if (cached !== null) return cached
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
        // Only an explicit stored `false` turns collection off. A corrupt or
        // truncated file reads as on, matching the absent case above — a
        // profile whose file we cannot parse has not told us anything.
        cached =
          Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>).telemetryEnabled !== false
            : true
      } catch {
        cached = true
      }
      return cached
    },

    /** Adopt a renderer push. Idempotent: an unchanged value never rewrites the file. */
    set(enabled: boolean): void {
      const next = enabled !== false
      // `isEnabled()` first so the compare is against the persisted value on
      // the very first push of a session, not against an unread cache.
      if (this.isEnabled() === next) return
      cached = next
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      try {
        writeFileSync(tmp, `${JSON.stringify({ telemetryEnabled: next })}\n`, 'utf8')
        renameSync(tmp, target)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        // The in-memory value still applies, so the choice takes effect now.
        // It is worth a warning rather than a silent best-effort: this is the
        // one setting where losing a write on restart means sending data the
        // user asked us not to send.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Usage-data setting not saved',
          message:
            'Your usage-data choice could not be written to disk. It applies for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
