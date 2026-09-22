/**
 * The window's side of main's agent-launch settings.
 *
 * Main owns the settings a launch is composed from (CLI runtimes, MCP, project
 * knowledge roots, the last-selected CLI, the spawn permission preset). The
 * store's `appSettings` copy of them is a read model: this client fills it at
 * boot, keeps it current from main's `changed` broadcast, and turns every
 * setter into a partial `update` on main. A setter may apply its change to the
 * store at once so the control does not lag, but main's answer is what the
 * store ends up holding.
 *
 * Boot, in order: subscribe to the broadcast (so nothing is missed), read the
 * snapshot, and — only when main holds no record and this window still has the
 * values it used to keep in localStorage — offer those once through `migrate`.
 * `ready` resolves when that is done, and the workspace window does not render
 * before it (bounded), so no picker shows defaults the person never chose.
 * Updates issued before then wait for it, so a setter can never create main's
 * record ahead of the migration and get the offer refused.
 *
 * Ordering: a record is adopted only when its revision is newer than the last
 * one adopted, and nothing is adopted while this window has an update in
 * flight. When the last in-flight update settles, the newest record seen is
 * adopted, which is also what reverts an optimistic change main refused or
 * never received.
 *
 * Configured by `workspaceStore` (which owns the store) with `start`; this
 * module imports nothing from the store, so the slices can call `update`
 * without an import cycle.
 */
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsPatch,
  AgentLaunchSettingsRecord,
} from '../../../shared/launch-settings'

export type LaunchSettingsApi = Pick<
  Window['api'],
  'launchSettingsGet' | 'launchSettingsUpdate' | 'launchSettingsMigrate' | 'onLaunchSettingsChanged'
>

export type LaunchSettingsClientConfig = {
  api: LaunchSettingsApi | null
  /** Replace the store's launch fields with these settings. */
  apply: (settings: AgentLaunchSettings) => void
  /** The values this window kept in localStorage before main owned them, or null. */
  legacyOffer: () => AgentLaunchSettings | null
  /** Main holds a record, so the window's localStorage copy is no longer needed. */
  onLegacySettled: () => void
}

export type LaunchSettingsClient = {
  start: (config: LaunchSettingsClientConfig) => Promise<void>
  update: (patch: AgentLaunchSettingsPatch) => void
  /** Resolves once the boot read (and any migration) has finished or failed. */
  ready: Promise<void>
  stop: () => void
}

export function launchSettingsApiFromWindow(): LaunchSettingsApi | null {
  if (typeof window === 'undefined') return null
  const api = window.api as Partial<LaunchSettingsApi> | undefined
  if (
    typeof api?.launchSettingsGet !== 'function' ||
    typeof api.launchSettingsUpdate !== 'function' ||
    typeof api.launchSettingsMigrate !== 'function' ||
    typeof api.onLaunchSettingsChanged !== 'function'
  ) {
    return null
  }
  return api as LaunchSettingsApi
}

export function createLaunchSettingsClient(): LaunchSettingsClient {
  let config: LaunchSettingsClientConfig | null = null
  let booted = false
  let latest: AgentLaunchSettingsRecord | null = null
  let appliedRevision = 0
  let inFlight = 0
  // An update was issued since the last adoption: re-adopt main's record when
  // the in-flight ones settle, even at an unchanged revision, so a refused or
  // lost update does not leave its optimistic value behind.
  let dirty = false
  let unsubscribe: (() => void) | null = null
  let resolveReady: () => void = () => undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function offer(record: AgentLaunchSettingsRecord | null | undefined): void {
    if (!record || typeof record.revision !== 'number') return
    if (!latest || record.revision > latest.revision) latest = record
  }

  function settle(): void {
    if (!config || !booted || inFlight > 0 || !latest) return
    if (latest.revision <= appliedRevision && !dirty) return
    appliedRevision = latest.revision
    dirty = false
    config.apply(latest.settings)
  }

  async function boot(active: LaunchSettingsClientConfig, api: LaunchSettingsApi): Promise<void> {
    unsubscribe = api.onLaunchSettingsChanged((record) => {
      offer(record)
      settle()
    })
    try {
      const snapshot = await api.launchSettingsGet()
      let record = snapshot?.record ?? null
      const legacy = active.legacyOffer()
      if (!record && legacy) {
        const ack = await api.launchSettingsMigrate(legacy)
        record = ack?.record ?? null
      }
      if (record) {
        offer(record)
        active.onLegacySettled()
      } else if (snapshot?.settings && !latest) {
        // Main has never been written and this window has nothing to offer:
        // show what main would launch with (an old unrevisioned file, or the
        // defaults), so the two agree before the first write.
        active.apply(snapshot.settings)
      }
    } catch (error) {
      // Main did not answer. Keep this window's own values on screen and in
      // localStorage; the next boot offers them again.
      const legacy = active.legacyOffer()
      if (legacy) active.apply(legacy)
      console.warn('[launchSettings] could not read the launch settings from main', {
        message: error instanceof Error ? error.message : 'unknown',
      })
    } finally {
      booted = true
      resolveReady()
      settle()
    }
  }

  return {
    ready,

    start(next) {
      config = next
      const api = next.api
      if (!api) {
        booted = true
        resolveReady()
        return ready
      }
      void boot(next, api)
      return ready
    },

    update(patch) {
      const api = config?.api
      if (!api) return
      inFlight += 1
      dirty = true
      void ready
        .then(() => api.launchSettingsUpdate(patch))
        .then((ack) => offer(ack?.record))
        .catch((error: unknown) => {
          console.warn('[launchSettings] update was not applied by main', {
            message: error instanceof Error ? error.message : 'unknown',
          })
        })
        .finally(() => {
          inFlight -= 1
          settle()
        })
    },

    stop() {
      unsubscribe?.()
      unsubscribe = null
    },
  }
}

/** The one client the store and its slices share. */
export const launchSettingsClient: LaunchSettingsClient = createLaunchSettingsClient()
