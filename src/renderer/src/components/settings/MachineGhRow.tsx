import React from 'react'

import {
  GH_NEEDED_FOR,
  ghInstallHint,
  ghSignInCommands,
  type HostGhMachine,
  type HostGhStatus,
} from '../../../../shared/host-gh'
import { ProviderRow, ProviderStateId } from '../ui'
import { SettingCard } from './SettingsAtoms'

// GitHub CLI on a WSL distribution or an SSH machine: listed beside that
// machine's agent CLIs, installed or missing, and whether it is signed in.
// A chat there opens its pull requests with that machine's `gh`, and the
// marks for its chats are looked up with it. Studio never installs it from
// here and never signs anyone in: the row names the command, and the person
// runs it in a terminal on that machine.

/** The mono `gh` mark, the binary's own name in the row's monogram box. */
export function GhMark(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="flex size-icon-lg items-center justify-center rounded-[var(--radius-xs)] border border-[color:var(--border-subtle)] bg-[color:var(--bg-app)] font-mono text-micro font-semibold text-[color:var(--text-muted)]"
    >
      gh
    </span>
  )
}

/** One machine's `gh`, as a row: what it is now, and what to do about it. */
export function MachineGhRow({
  status,
  machine,
  machineLabel,
  as = 'li',
}: {
  /** `loading` while it is asked; null when the machine did not answer. */
  status: HostGhStatus | null | 'loading'
  machine: HostGhMachine
  machineLabel: string
  as?: 'li' | 'div'
}): React.JSX.Element {
  const missing = status !== 'loading' && status !== null && !status.installed
  return (
    <ProviderRow
      as={as}
      surface="card"
      icon={<GhMark />}
      recessed={missing}
      name="GitHub CLI"
      version={status !== 'loading' && status?.installed ? status.version : null}
      stateLine={<GhStateLine status={status} machine={machine} machineLabel={machineLabel} />}
    />
  )
}

function GhStateLine({
  status,
  machine,
  machineLabel,
}: {
  status: HostGhStatus | null | 'loading'
  machine: HostGhMachine
  machineLabel: string
}): React.JSX.Element {
  const why = <span className="block">{GH_NEEDED_FOR}</span>
  if (status === 'loading') return <>Checking {machineLabel}…</>
  if (status === null)
    return (
      <>
        {machineLabel} did not say whether <ProviderStateId>gh</ProviderStateId> is installed.
        {why}
      </>
    )
  if (!status.installed) {
    const hint = ghInstallHint(machine)
    return (
      <>
        Not installed — no <ProviderStateId>gh</ProviderStateId> on {machineLabel}.{' '}
        {hint.command ? (
          <>
            Install it there with <ProviderStateId>{hint.command}</ProviderStateId>.
          </>
        ) : (
          <>
            Install it there as <ProviderStateId>{hint.url}</ProviderStateId> describes.
          </>
        )}
        {why}
      </>
    )
  }
  if (status.signedIn === false) {
    const [login, reuse] = ghSignInCommands(machine)
    return (
      <>
        Installed, not signed in. Run <ProviderStateId>{login}</ProviderStateId> in a terminal on {machineLabel}
        {reuse ? (
          <>
            , or reuse This PC&apos;s sign-in with <ProviderStateId>{reuse}</ProviderStateId> inside WSL
          </>
        ) : null}
        .{why}
      </>
    )
  }
  return (
    <>
      {status.signedIn ? 'Installed and signed in.' : 'Installed.'}
      {why}
    </>
  )
}

/** A WSL machine's `gh`, asked when the machine is shown and again on `recheck`. */
export function useWslGh(hostId: string | null, recheck: number): HostGhStatus | null | 'loading' {
  const [status, setStatus] = React.useState<HostGhStatus | null | 'loading'>('loading')
  React.useEffect(() => {
    if (!hostId || typeof window.api?.probeHostGh !== 'function') {
      setStatus(null)
      return
    }
    let cancelled = false
    setStatus('loading')
    void window.api
      .probeHostGh(hostId)
      .then((next) => {
        if (!cancelled) setStatus(next ?? null)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [hostId, recheck])
  return status
}

/** The GitHub CLI card under a WSL machine's agent CLIs in Settings › Agents. */
export function WslGhSection({
  hostId,
  label,
  recheck,
}: {
  hostId: string
  label: string
  recheck: number
}): React.JSX.Element {
  const status = useWslGh(hostId, recheck)
  return (
    <SettingCard as="ul" ariaLabel={`GitHub CLI on ${label}`}>
      <MachineGhRow status={status} machine={{ kind: 'wsl' }} machineLabel={label} />
    </SettingCard>
  )
}
