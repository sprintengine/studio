import React, { useEffect, useState } from 'react'

import type { BrowserRecordingState } from '../../../../../../shared/browser'
import { Badge, IconButton, Tooltip } from '../../../ui'
import { recordingClock } from './browserRecording'

// What the person sees while an agent records this tab: the word and a running
// clock in the toolbar, and a Stop that ends it the way the agent's own stop
// would (what was captured is saved). Said with a word and a timer, never a
// dot (AGENTS.md); a recording is a privacy fact, so it is never decorative.

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="icon-sm" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}

export function BrowserRecordingIndicator({
  recording,
  onStop,
}: {
  recording: BrowserRecordingState
  onStop: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [recording.recordingId])

  const elapsed = recordingClock(now - recording.startedAt)
  const limit = recordingClock(recording.maxDurationMs)
  return (
    <>
      <Badge tone="warn" ariaLabel={`An agent is recording this tab: ${elapsed}`} className="tabular-nums">
        Recording {elapsed}
      </Badge>
      <Tooltip content={`Stop recording (it stops by itself at ${limit})`} placement="bottom">
        <IconButton onClick={onStop} aria-label="Stop recording">
          <StopGlyph />
        </IconButton>
      </Tooltip>
    </>
  )
}
