// The quiet "Nightly" mark beside the wordmark, worn only by a nightly build.
//
// It is a fact about the build — true before the person arrived and still true
// after they leave — so it is the micro chip (design-system/components/
// micro-chip), not a badge: no tone, a hairline, micro type. The splash says
// the same thing on launch with its night-sky plate; this is the one place the
// running window says it.
//
// It says what the BUILD is, never what the updater follows. Main reads both
// (`AppUpdateState.buildChannel` from the version it was cut with, `channel`
// from the person's pick in Settings); the renderer does not parse the version
// itself, so a nightly that was switched to stable is still labelled a nightly
// until the stable update actually installs over it — and the tooltip says
// which train it is on meanwhile.

import { useEffect, useState } from 'react'
import type { AppUpdateState } from '../../../../shared/electron-api'
import { MicroChip } from '../ui/DefaultChip'
import { Tooltip } from '../ui'

type BuildIdentity = Pick<AppUpdateState, 'version' | 'channel' | 'buildChannel'>

/** One or two sentences: the build's version, then what it updates from. */
export function nightlyChipTooltip({ version, channel }: BuildIdentity): string {
  const build = `Nightly build ${version}.`
  if (channel === 'dev') return `${build} A development build; it does not update itself.`
  if (channel === 'stable') return `${build} Following the stable channel: the next stable release replaces it.`
  return `${build} Updates from the nightly channel.`
}

/** The build identity main reports, or null until it answers. */
function useBuildIdentity(): BuildIdentity | null {
  const [identity, setIdentity] = useState<BuildIdentity | null>(null)
  useEffect(() => {
    const api = typeof window === 'undefined' ? null : window.api
    if (!api || typeof api.updateGetState !== 'function') return
    let cancelled = false
    void api
      .updateGetState()
      .then((state) => {
        if (!cancelled) setIdentity(state)
      })
      .catch(() => undefined)
    // A channel switch in Settings changes `channel`, and so the tooltip.
    const unsubscribe =
      typeof api.onUpdateStateChanged === 'function' ? api.onUpdateStateChanged((state) => setIdentity(state)) : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [])
  return identity
}

/**
 * `className` carries the host row's visibility (a container query), so the
 * chip drops out before the wordmark does when the sidebar narrows.
 */
export function NightlyBuildChip({ className }: { className?: string }) {
  const identity = useBuildIdentity()
  if (identity?.buildChannel !== 'nightly') return null
  return (
    <Tooltip content={nightlyChipTooltip(identity)} placement="bottom" wrapperClassName={className || 'inline-flex'}>
      {/* `app-no-drag`: the row is a window-drag region, which swallows the
          hover the tooltip opens on. */}
      <span className="app-no-drag inline-flex">
        <MicroChip>Nightly</MicroChip>
      </span>
    </Tooltip>
  )
}
