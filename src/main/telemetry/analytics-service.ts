/**
 * The only thing in SprintEngine that sends product usage data anywhere.
 *
 * Buffers events in memory, batches them, and POSTs to PostHog's capture
 * endpoint on a timer. No PostHog SDK: the batch API is one JSON body, and a
 * dependency that autocaptures by default is the wrong shape for a desktop app
 * whose whole collection boundary is "scalars we chose to send" (see
 * `src/shared/telemetry.ts`).
 *
 * THREE GATES, checked in this order, any one of which stops collection:
 *
 *   1. A project key. Empty by default, so a from-source build, a fork and
 *      every test run are silent without opting out of anything.
 *   2. `SPRINTENGINE_TELEMETRY_ENABLED=false` in the process environment, for
 *      the machine or fleet that wants it off with no window open.
 *   3. The user's Settings toggle, mirrored into `consent-store.ts`.
 *
 * `record` is synchronous, returns nothing, and never throws — it sits on the
 * agent-launch paths, which must not get slower or more failure-prone
 * because a metric was added. Everything after it is best effort: a failed flush
 * costs a batch, never a user action.
 */
import { containsLocalPath } from '../mobile/control/relay-path-safety'
import {
  DEFAULT_POSTHOG_HOST,
  DEFAULT_POSTHOG_PROJECT_KEY,
  POSTHOG_HOST_ENV_VAR,
  POSTHOG_PROJECT_KEY_ENV_VAR,
  TELEMETRY_ENABLED_ENV_VAR,
  type TelemetryEventName,
  type TelemetryProperties,
  type TelemetryPropertyValue,
} from '../../shared/telemetry'
import { readInstallId } from './install-id'

/** Longest string a property may carry. Identifiers and enums, not prose. */
const MAX_PROPERTY_LENGTH = 120
/** Most properties one event may carry, after sanitizing. */
const MAX_PROPERTY_COUNT = 32

export type TelemetryConfig = {
  projectKey: string
  host: string
  /** False only when the environment kill switch is set. */
  envEnabled: boolean
  flushBatchSize: number
  maxBufferedEvents: number
  flushIntervalMs: number
}

export function resolveTelemetryConfig(env: NodeJS.ProcessEnv = process.env): TelemetryConfig {
  const host = (env[POSTHOG_HOST_ENV_VAR] ?? '').trim() || DEFAULT_POSTHOG_HOST
  return {
    projectKey: (env[POSTHOG_PROJECT_KEY_ENV_VAR] ?? '').trim() || DEFAULT_POSTHOG_PROJECT_KEY,
    // Trailing slashes are stripped so the URL join below cannot produce `//batch/`.
    host: host.replace(/\/+$/u, ''),
    // Explicit 'false' only. An unset or misspelled value leaves the decision
    // to the user's toggle rather than silently disabling the product default.
    envEnabled: env[TELEMETRY_ENABLED_ENV_VAR] !== 'false',
    flushBatchSize: 20,
    maxBufferedEvents: 500,
    flushIntervalMs: 30_000,
  }
}

/**
 * Enforce the collection boundary on one event's properties.
 *
 * Type first: only string/number/boolean survive, so no nested shape can carry
 * something nobody reviewed. Then the path check — a string that looks like a
 * local filesystem path is DROPPED rather than redacted, because a property
 * that arrives as `[redacted-path]` still reports that this user had a path
 * worth redacting there, and the property was useless as a measurement anyway.
 *
 * Exported for its test, and because the rule is worth reading on its own.
 */
export function sanitizeProperties(
  properties: TelemetryProperties | undefined,
): Record<string, TelemetryPropertyValue> {
  const out: Record<string, TelemetryPropertyValue> = {}
  if (!properties) return out
  for (const [key, value] of Object.entries(properties)) {
    if (Object.keys(out).length >= MAX_PROPERTY_COUNT) break
    if (typeof value === 'boolean') {
      out[key] = value
      continue
    }
    // NaN and Infinity serialize to `null` in JSON, which reads downstream as a
    // measurement that was taken and came back empty rather than one that was
    // never valid.
    if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value
      continue
    }
    if (typeof value !== 'string') continue
    if (value.length > MAX_PROPERTY_LENGTH) continue
    if (containsLocalPath(value)) continue
    out[key] = value
  }
  return out
}

type BufferedEvent = {
  event: TelemetryEventName
  properties: Record<string, TelemetryPropertyValue>
  capturedAt: string
}

export type AnalyticsServiceDeps = {
  resolveUserDataDir: () => string
  /** The user's Settings toggle, read per event rather than cached. */
  isConsented: () => boolean
  /** Reported as `appVersion` on every event. */
  appVersion: string
  /** Whether this is an installed build; separates real usage from dev noise. */
  packaged: boolean
  config?: TelemetryConfig
  fetchImpl?: typeof fetch
  now?: () => Date
  timers?: {
    setInterval: (handler: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type AnalyticsService = {
  /** Fire and forget. Silent when any gate is closed. Never throws. */
  record: (event: TelemetryEventName, properties?: TelemetryProperties) => void
  /** Send everything buffered now. Resolves when the buffer is empty or a send failed. */
  flush: () => Promise<void>
  /** Stop the timer and make one last flush attempt. */
  shutdown: () => Promise<void>
  /** Whether a `record` right now would be kept. Exposed for diagnostics and tests. */
  isActive: () => boolean
}

export function createAnalyticsService(deps: AnalyticsServiceDeps): AnalyticsService {
  const config = deps.config ?? resolveTelemetryConfig()
  const now = deps.now ?? (() => new Date())
  const timers = deps.timers ?? {
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  }
  // Resolved through a getter so an unkeyed build never calls it, and a keyed
  // one never calls it before the first event it actually sends.
  const doFetch = (): typeof fetch => deps.fetchImpl ?? globalThis.fetch

  const buffer: BufferedEvent[] = []
  let installId: string | null = null
  let flushing: Promise<void> | null = null
  let timer: unknown = null
  let stopped = false
  // One warning per process. A machine with no route to PostHog would otherwise
  // write a diagnostic every flush interval for as long as the app is open.
  let warnedOnFailure = false

  const keyed = config.projectKey.length > 0

  function isActive(): boolean {
    return keyed && config.envEnabled && !stopped && deps.isConsented()
  }

  function ensureTimer(): void {
    if (timer !== null || stopped) return
    timer = timers.setInterval(() => {
      void flush()
    }, config.flushIntervalMs)
  }

  function record(event: TelemetryEventName, properties?: TelemetryProperties): void {
    try {
      if (!isActive()) return
      buffer.push({
        event,
        properties: sanitizeProperties(properties),
        capturedAt: now().toISOString(),
      })
      // Drop the OLDEST on overflow. A buffer this full means sending has been
      // failing for a long while; the recent events describe what the app is
      // doing now, and the stale ones have already lost their context.
      while (buffer.length > config.maxBufferedEvents) buffer.shift()
      ensureTimer()
    } catch {
      // A metric must never be able to break the thing it measures.
    }
  }

  async function sendBatch(events: readonly BufferedEvent[]): Promise<'sent' | 'retry' | 'drop'> {
    if (installId === null) {
      installId = readInstallId({ resolveUserDataDir: deps.resolveUserDataDir }).value
    }
    const payload = {
      api_key: config.projectKey,
      batch: events.map((buffered) => ({
        event: buffered.event,
        distinct_id: installId,
        properties: {
          ...buffered.properties,
          // No person profiles. The install id is the whole identity, and a
          // profile would accumulate a history against it that nothing here
          // intends to build.
          $process_person_profile: false,
          platform: process.platform,
          arch: process.arch,
          appVersion: deps.appVersion,
          packaged: deps.packaged,
        },
        timestamp: buffered.capturedAt,
      })),
    }

    try {
      const response = await doFetch()(`${config.host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        // Without a deadline a stalled connection pins the batch and every
        // event behind it for as long as the app is open.
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return 'sent'
      // A rejected-on-content response will be rejected again with the same
      // body: a wrong key, a malformed payload, a project that no longer
      // exists. Requeueing it would retry forever and never drain. 429 is the
      // exception — that one is a "later", not a "no".
      if (response.status >= 400 && response.status < 500 && response.status !== 429) return 'drop'
      return 'retry'
    } catch {
      // Offline, DNS, TLS, timeout: all worth another attempt on the next tick.
      return 'retry'
    }
  }

  function warnOnce(details: string): void {
    if (warnedOnFailure) return
    warnedOnFailure = true
    deps.logDiagnostic?.({
      level: 'warning',
      title: 'Usage data not sent',
      message: 'Anonymous usage events could not be delivered. This does not affect anything else in the app.',
      details,
    })
  }

  async function drain(): Promise<void> {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, config.flushBatchSize)
      const outcome = await sendBatch(batch)
      if (outcome === 'sent') continue
      if (outcome === 'drop') {
        warnOnce('The capture endpoint rejected the batch; those events were discarded.')
        continue
      }
      // Back to the front, in order, and stop for this tick: a second attempt
      // now would hit whatever just failed.
      buffer.unshift(...batch)
      while (buffer.length > config.maxBufferedEvents) buffer.pop()
      warnOnce('The capture endpoint could not be reached; events are buffered for the next attempt.')
      return
    }
  }

  function flush(): Promise<void> {
    if (!keyed || !config.envEnabled) return Promise.resolve()
    // Coalesce: the timer and an explicit flush (quit) can land together, and
    // two drains over one buffer would interleave batches.
    if (flushing) return flushing
    flushing = drain()
      .catch(() => undefined)
      .finally(() => {
        flushing = null
      })
    return flushing
  }

  async function shutdown(): Promise<void> {
    if (timer !== null) {
      timers.clearInterval(timer)
      timer = null
    }
    await flush()
    stopped = true
  }

  return { record, flush, shutdown, isActive }
}

/**
 * A service that accepts every call and sends nothing. For tests and for any
 * host that wires the app without telemetry — a caller should never have to
 * check whether `analytics` exists before recording.
 */
export function createNoopAnalyticsService(): AnalyticsService {
  return {
    record: () => undefined,
    flush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
    isActive: () => false,
  }
}
