import { useEffect, useState } from 'react'

import { SettingToggle } from './SettingsAtoms'

// A switch whose value main owns, because main is what acts on it with no
// window to ask (the quit question, the keep-awake blocker). It is read from
// main when the page opens and every write answers with what main now holds.
// A client that answers null — a browser tab, with no quit and no machine of
// its own — shows nothing.
export function MainOwnedSettingToggle({
  label,
  description,
  read,
  write,
}: {
  label: string
  description: string
  read: (() => Promise<boolean | null>) | undefined
  write: (enabled: boolean) => Promise<boolean | null>
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (typeof read !== 'function') return
    let cancelled = false
    void read()
      .then((next) => {
        if (!cancelled) setEnabled(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [read])
  if (enabled === null) return null
  return (
    <SettingToggle
      label={label}
      description={description}
      enabled={enabled}
      disabled={pending}
      onChange={(next) => {
        if (pending) return
        setPending(true)
        setEnabled(next)
        void write(next)
          .then((held) => {
            if (held !== null) setEnabled(held)
          })
          .catch(() => setEnabled(!next))
          .finally(() => setPending(false))
      }}
    />
  )
}
