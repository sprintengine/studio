import { useEffect, useState } from 'react'

import { GhostButton } from '../ui'
import { Banner } from '../ui/Banner'
import { useStudioServerStatus } from './useStudioServerStatus'
import { studioServerNotice } from './studioServerWords'

// The strip across the top of a workspace window while the Studio server is
// not there: starting (only once it has taken a noticeable moment),
// reconnecting after a crash, or stopped. Everything the shell owns keeps
// working meanwhile (terminals, the git panel, the file explorer); the strip
// says why chats and the panes the server backs are waiting.

/** A server ready within this shows no "starting" strip at all. */
const STARTING_GRACE_MS = 1_500

export function StudioServerBanner() {
  const [status] = useStudioServerStatus()
  const [showStarting, setShowStarting] = useState(false)
  const starting = status?.phase === 'starting'
  useEffect(() => {
    if (!starting) {
      setShowStarting(false)
      return
    }
    const timer = window.setTimeout(() => setShowStarting(true), STARTING_GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [starting])

  const notice = studioServerNotice(status, { showStarting })
  if (!notice) return null
  return (
    <Banner
      tone={notice.tone}
      message={notice.message}
      {...(notice.recoverable ? { onRetry: () => void window.api.studioServerRetry() } : {})}
      // One recovery cluster: Retry, and the way back to running the server
      // inside the app. Its log is a Settings action (Agents → Studio server).
      action={
        notice.recoverable ? (
          <GhostButton onClick={() => void window.api.studioServerRelaunch({ compatibility: true })}>
            Restart in compatibility mode
          </GhostButton>
        ) : undefined
      }
    />
  )
}
