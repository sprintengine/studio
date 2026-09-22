/**
 * Which release channel the updater follows, and the person's saved choice.
 *
 * An install follows the channel its own version names — a build versioned
 * `X.Y.Z-nightly.DATE.RUN` came from the nightly train and keeps to it, and
 * every other packaged build is stable — unless the person picked a channel in
 * Settings. That pick is persisted here, under userData, and main owns it: the
 * updater is configured at startup, before any renderer exists to ask, so the
 * value has to be readable synchronously from main and belongs to no renderer
 * setting.
 *
 * Absent, unreadable, or malformed all read as "no choice", which falls back to
 * the version's own channel — exactly the behaviour before the choice existed,
 * so a store we cannot trust never moves anybody onto a train they did not ask
 * for. Follows the shape of `background-mode-store.ts`.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AppUpdateTrack } from '../shared/electron-api'

const FILE_NAME = 'update-channel.json'

const TRACKS: readonly AppUpdateTrack[] = ['stable', 'nightly']

export function isUpdateTrack(value: unknown): value is AppUpdateTrack {
  return typeof value === 'string' && (TRACKS as readonly string[]).includes(value)
}

/**
 * The channel a version was built for. Only the nightly train's own spelling
 * counts: the workflow tags nightlies `-nightly.` and nothing else, so any
 * other prerelease part (the retired preview train's bridge release among
 * them) is a stable install, whose next update is the latest stable.
 */
export function channelForVersion(version: string): AppUpdateTrack {
  return /^\d+\.\d+\.\d+-nightly(\.|$)/.test(version.replace(/^v/, '')) ? 'nightly' : 'stable'
}

/** The saved choice wins; without one, the version decides. */
export function resolveUpdateTrack(version: string, saved: AppUpdateTrack | null): AppUpdateTrack {
  return saved ?? channelForVersion(version)
}

export type UpdateChannelStoreDeps = {
  resolveUserDataDir: () => string
  logDiagnostic?: (input: { level: 'warning'; title: string; message: string; details?: string }) => void
}

export type UpdateChannelStore = ReturnType<typeof createUpdateChannelStore>

export function createUpdateChannelStore(deps: UpdateChannelStoreDeps) {
  // `undefined` is "not read yet"; `null` is "read, and there is no choice".
  let cached: AppUpdateTrack | null | undefined

  function filePath(): string {
    return join(deps.resolveUserDataDir(), FILE_NAME)
  }

  return {
    /** The person's saved channel, or null when they never chose. Never throws. */
    get(): AppUpdateTrack | null {
      if (cached !== undefined) return cached
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath(), 'utf8'))
        const channel =
          raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).channel : null
        cached = isUpdateTrack(channel) ? channel : null
      } catch {
        cached = null
      }
      return cached
    },

    /** Save a choice. Idempotent: an unchanged value never rewrites the file. */
    set(channel: AppUpdateTrack): void {
      if (!isUpdateTrack(channel)) throw new Error(`Unknown update channel: ${String(channel)}`)
      if (this.get() === channel) return
      cached = channel
      const target = filePath()
      const tmp = `${target}.tmp-${process.pid}`
      try {
        writeFileSync(tmp, `${JSON.stringify({ channel })}\n`, 'utf8')
        renameSync(tmp, target)
      } catch (error) {
        try {
          unlinkSync(tmp)
        } catch {
          // The temp file may never have been created; nothing to clean up.
        }
        // The in-memory value still applies, so the updater follows the new
        // channel for this session; it just will not survive a restart.
        deps.logDiagnostic?.({
          level: 'warning',
          title: 'Update channel not persisted',
          message:
            'The update channel could not be written to disk; it applies for this session but will not survive a restart.',
          details: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
