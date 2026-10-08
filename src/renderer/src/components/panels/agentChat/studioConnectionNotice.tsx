// What a chat on the Studio protocol says while its window's connection to
// Studio is down. The transcript stays drawn from what the window holds, and
// this row in the composer tray says, in words, that the connection is being
// made again, so a quiet chat never reads as a stuck one. A short blip says
// nothing: the row waits a moment before it appears.
//
// A window on the conversation IPC has no such connection, and this is never
// drawn there.

import React, { useEffect, useState, useSyncExternalStore } from 'react'

import { Spinner } from '../../ui'
import { watchWindowStudio, windowStudioState, type WindowStudioState } from '../../../studio/windowStudioClient'
import { ComposerTrayRow } from './composerTray'
import { chatOverStudioProtocol } from './conversationTransport'

/** How long a dropped connection goes unmentioned, so a blip does not flicker a row. */
export const STUDIO_RECONNECT_GRACE_MS = 1_500

const noWatch = () => () => undefined

/** The window's connection to Studio, or null for a window on the conversation IPC. */
export function useWindowStudioConnection(): WindowStudioState | null {
  const api = chatOverStudioProtocol() ? (window.api as object) : null
  return useSyncExternalStore(
    api ? (listener) => watchWindowStudio(api, listener) : noWatch,
    () => (api ? windowStudioState(api) : null),
    () => null,
  )
}

/** The words a state is told in, or null when there is nothing to say. */
export function studioConnectionWords(state: WindowStudioState | null): string | null {
  switch (state) {
    case 'reconnecting':
      return 'Reconnecting to Studio… The chat picks up where it left off.'
    // Neither tries again by itself: the window's next use of the chat does.
    case 'parked':
      return 'This window lost its connection to Studio. It tries again the next time you use the chat.'
    case 'unavailable':
      return 'This window could not reach Studio. It tries again the next time you use the chat.'
    default:
      return null
  }
}

export const StudioConnectionNotice = React.memo(function StudioConnectionNotice({
  graceMs = STUDIO_RECONNECT_GRACE_MS,
}: {
  graceMs?: number
}) {
  const state = useWindowStudioConnection()
  const words = studioConnectionWords(state)
  const down = words !== null
  // Whether the connection has been down for longer than a blip.
  const [lasting, setLasting] = useState(false)
  useEffect(() => {
    if (!down) {
      setLasting(false)
      return
    }
    const timer = window.setTimeout(() => setLasting(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [down, graceMs])
  if (!words || !lasting) return null
  return (
    <ComposerTrayRow tone="warn" glyph={state === 'reconnecting' ? <Spinner /> : undefined}>
      {words}
    </ComposerTrayRow>
  )
})
