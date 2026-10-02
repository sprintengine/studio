import type { StudioServerStatus } from '../../../../shared/studio-server-status'

// The sentence a window shows about the Studio server, or none. Said in words,
// never as a dot: "starting", "reconnecting" and "stopped" would read alike as
// a coloured disc.

export type StudioServerNotice = { tone: 'warn' | 'error'; message: string; recoverable: boolean } | null

export function studioServerNotice(
  status: StudioServerStatus | null,
  options: { showStarting: boolean },
): StudioServerNotice {
  if (!status) return null
  if (status.fellBack) {
    return {
      tone: 'warn',
      message: `Studio server could not start in its own process, so it runs inside the app this time. ${status.fellBack}`,
      recoverable: false,
    }
  }
  switch (status.phase) {
    case 'starting':
      // A server that is up within a moment needs no sentence at all.
      return options.showStarting ? { tone: 'warn', message: 'Starting Studio server…', recoverable: false } : null
    case 'reconnecting':
      return { tone: 'warn', message: 'Reconnecting to Studio server…', recoverable: false }
    case 'stopped':
      return {
        tone: 'error',
        message: `Studio server stopped.${status.reason ? ` ${status.reason}` : ''}`,
        recoverable: true,
      }
    default:
      return null
  }
}

/** How long a running server has been up, in words. */
export function uptimeWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return `${hours} h ${minutes % 60} min`
}
