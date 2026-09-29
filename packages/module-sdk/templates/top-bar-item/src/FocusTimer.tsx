import { useEffect, useState, useSyncExternalStore } from 'react'

import type { RendererHost } from '@sprintengine/module-sdk'
import { GhostButton } from '@sprintengine/module-sdk/ui'

const ENDS_AT_KEY = 'focusEndsAt'
const FOCUS_MINUTES = 25

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

// The end time lives in module app state, so a running timer survives a
// reload and shows the same time in every window.
export function createFocusTimer(host: RendererHost) {
  const subscribe = (onChange: () => void) => host.watchModuleAppState(() => onChange())
  const readEndsAt = () => host.getModuleAppState<number>(ENDS_AT_KEY) ?? null

  return function FocusTimer() {
    const endsAt = useSyncExternalStore(subscribe, readEndsAt)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
      if (endsAt === null) return
      const timer = window.setInterval(() => setNow(Date.now()), 1000)
      return () => window.clearInterval(timer)
    }, [endsAt])

    const remaining = endsAt === null ? null : endsAt - now
    const done = remaining !== null && remaining <= 0
    const toggle = () => {
      setNow(Date.now())
      host.setModuleAppState(ENDS_AT_KEY, endsAt === null ? Date.now() + FOCUS_MINUTES * 60_000 : undefined)
    }

    const label =
      endsAt === null
        ? `Start a ${FOCUS_MINUTES}-minute focus timer`
        : done
          ? 'Focus time is up; clear the timer'
          : 'Stop the focus timer'
    return (
      <GhostButton size="sm" aria-label={label} title={label} pressed={endsAt !== null && !done} onClick={toggle}>
        {endsAt === null ? 'Focus' : done ? 'Done' : formatRemaining(remaining ?? 0)}
      </GhostButton>
    )
  }
}
