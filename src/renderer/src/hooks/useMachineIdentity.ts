import React from 'react'

import { LOCAL_HOST_ID, isWslHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { resolveMachineIdentity, type MachineIdentity, type MachineRef } from '../../../shared/machine-identity'
import type { SshEnvironmentSummary } from '../../../shared/ssh-environments'
import { useWorkspaceStore } from '../store/workspaceStore'

// The window's side of machine identity (shared/machine-identity): a machine's
// kind and colour with the person's overrides from Settings › Machines applied.
// Every surface that marks a machine reads it here, so a change in Settings
// moves every mark at once.

/** A machine's identity, or null for this machine and for no machine. */
export function useMachineIdentity(machine: MachineRef | null): MachineIdentity | null {
  const marks = useWorkspaceStore((s) => s.appSettings.machineMarks)
  return React.useMemo(() => (machine ? resolveMachineIdentity(machine, marks) : null), [machine, marks])
}

/** The ref for a machine on this computer: a WSL distribution, or this machine. */
export function hostMachineRef(hostId: ExecutionHostId | null | undefined): MachineRef {
  return hostId && isWslHostId(hostId) ? { kind: 'wsl', hostId } : { kind: 'local' }
}

/** The ref for an SSH machine, by the host its config resolves to (what every device agrees on). */
export function sshMachineRef(machine: Pick<SshEnvironmentSummary, 'resolved' | 'destination'>): MachineRef {
  return machine.resolved
    ? { kind: 'ssh', host: machine.resolved.hostname, port: machine.resolved.port }
    : { kind: 'ssh', host: machine.destination }
}

// ── SSH machines by saved id ──────────────────────────────────────────────
//
// A workspace on an SSH machine records the machine's SAVED id and label, and
// the saved id is this device's own (main mints it at random). The identity is
// keyed by the host name instead, so a row that knows only the saved id looks
// the host up here: one list for the window, read once and kept current from
// main's pushes, rather than one IPC per sidebar row.

type SshDirectory = { machines: SshEnvironmentSummary[]; listeners: Set<() => void>; started: boolean }

const sshDirectory: SshDirectory = { machines: [], listeners: new Set(), started: false }

function startSshDirectory(): void {
  if (sshDirectory.started) return
  const api = typeof window !== 'undefined' ? window.api : undefined
  if (typeof api?.sshEnvironmentsList !== 'function') return
  sshDirectory.started = true
  const reload = (): void => {
    void Promise.resolve(api.sshEnvironmentsList())
      .then((listed) => {
        sshDirectory.machines = Array.isArray(listed) ? listed : []
        for (const listener of sshDirectory.listeners) listener()
      })
      .catch(() => undefined)
  }
  reload()
  if (typeof api.onSshEnvironmentsChanged === 'function') api.onSshEnvironmentsChanged(() => reload())
}

function subscribeSshDirectory(listener: () => void): () => void {
  sshDirectory.listeners.add(listener)
  startSshDirectory()
  return () => sshDirectory.listeners.delete(listener)
}

/** Test seam: forget the window's SSH directory. */
export function resetSshDirectoryForTests(): void {
  sshDirectory.machines = []
  sshDirectory.listeners.clear()
  sshDirectory.started = false
}

/**
 * The machine a workspace runs on, as a ref: its SSH machine (looked up by
 * saved id), the paired machine it was born on, or the machine on this
 * computer its `hostId` names. Null while an SSH machine's host is not known
 * yet, so a row never shows a colour it would change a moment later.
 */
export function useWorkspaceMachineRef(
  workspace:
    | {
        hostId?: ExecutionHostId | null
        environment?: { kind: 'ssh'; id: string; label: string } | null
        remoteOrigin?: { machineName: string } | null
      }
    | null
    | undefined,
): MachineRef | null {
  const sshId = workspace?.environment?.kind === 'ssh' ? workspace.environment.id : null
  const sshMachines = React.useSyncExternalStore(
    sshId ? subscribeSshDirectory : noopSubscribe,
    () => sshDirectory.machines,
    () => sshDirectory.machines,
  )
  const remoteName = workspace?.remoteOrigin?.machineName ?? null
  const hostId = workspace?.hostId ?? LOCAL_HOST_ID
  const sshMachine = sshId ? (sshMachines.find((machine) => machine.id === sshId) ?? null) : null
  // The same ref the composer and Settings › Machines build for this machine.
  const sshHost = sshMachine ? (sshMachine.resolved?.hostname ?? sshMachine.destination) : null
  const sshPort = sshMachine?.resolved?.port ?? null
  return React.useMemo<MachineRef | null>(() => {
    if (sshId) return sshHost ? { kind: 'ssh', host: sshHost, port: sshPort } : null
    if (remoteName) return { kind: 'paired', name: remoteName }
    return hostMachineRef(hostId)
  }, [hostId, remoteName, sshHost, sshId, sshPort])
}

function noopSubscribe(): () => void {
  return () => undefined
}
