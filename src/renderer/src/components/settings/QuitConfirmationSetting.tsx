import { useEffect, useState } from 'react'

import { SettingToggle } from './SettingsAtoms'

// Settings → General: "Ask before quitting while agents are working". Main
// owns the value (the quit dialog's "Don't ask again" turns it off), so it is
// read from main when the page opens and every write answers with what main
// now holds. A client with no quit of its own (a browser tab) shows nothing.
export function QuitConfirmationSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (typeof window.api?.getQuitConfirmation !== 'function') return
    let cancelled = false
    void window.api
      .getQuitConfirmation()
      .then((next) => {
        if (!cancelled) setEnabled(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  if (enabled === null) return null
  return (
    <SettingToggle
      label="Ask before quitting while agents are working"
      description="Quitting stops any agent that is mid-turn or waiting on you."
      enabled={enabled}
      disabled={pending}
      onChange={(next) => {
        if (pending) return
        setPending(true)
        setEnabled(next)
        void window.api
          .setQuitConfirmation(next)
          .then((held) => {
            if (held !== null) setEnabled(held)
          })
          .catch(() => setEnabled(!next))
          .finally(() => setPending(false))
      }}
    />
  )
}
