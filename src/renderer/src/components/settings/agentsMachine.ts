import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentCliAvailabilityMap } from '../../../../shared/electron-api'
import {
  isWslHostId,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSummary,
  type HostsListResult,
} from '../../../../shared/execution-host'
import { useWorkspaceStore } from '../../store/workspaceStore'

// Settings ▸ Agents lists ONE machine's agent CLIs at a time (owner ruling
// 2026-09-24). Before, the CLIs were listed twice — this computer's on the
// Agents tab, each WSL distribution's under its row on the Machines tab — and
// neither list said which machine it was about. Now Machines holds only what is
// about the machine (on, default, environment, shell, state) and Agents holds
// everything about a CLI, for whichever machine the switcher at its top names.

export type AgentsMachine = { id: ExecutionHostId; label: string }

/**
 * The machines the Agents tab can show: this one, then each WSL distribution
 * turned on in Settings ▸ Machines, in the order main lists them. A
 * distribution that is off is not a machine new chats can use, so it is not
 * offered here either — its row on the Machines tab turns it on.
 *
 * One entry (macOS, Linux, Windows with no distribution on, or before main has
 * answered) means the tab draws no switcher at all.
 */
export function agentsMachines(listing: HostsListResult | null, fallbackLabel: string): AgentsMachine[] {
  const hosts: ExecutionHostSummary[] = listing?.hosts ?? []
  const local = hosts.find((host) => host.id === LOCAL_HOST_ID)
  const machines: AgentsMachine[] = [{ id: LOCAL_HOST_ID, label: local?.label ?? fallbackLabel }]
  for (const host of hosts) {
    if (host.kind === 'wsl' && isWslHostId(host.id) && host.enabled === true) {
      machines.push({ id: host.id, label: host.label })
    }
  }
  return machines
}

/** The machine a pick resolves to: the pick while it is still offered, else this one. */
export function resolveAgentsMachine(
  machines: readonly AgentsMachine[],
  picked: ExecutionHostId | null,
): AgentsMachine {
  return machines.find((machine) => machine.id === picked) ?? machines[0]
}

/**
 * Installed CLIs first, in the order they were given, then the ones this
 * machine definitively does not have, in that same order. Only a DEFINITIVE
 * absence moves a row down: a probe that never answered is not absence, and
 * must not push a CLI that is probably there to the bottom of the list.
 */
export function orderInstalledFirst<T>(rows: readonly T[], isMissing: (row: T) => boolean): T[] {
  const present: T[] = []
  const missing: T[] = []
  for (const row of rows) (isMissing(row) ? missing : present).push(row)
  return [...present, ...missing]
}

// The machine last shown on this window's Agents tab. Module state rather than
// a setting: it is a per-window convenience — which list you were looking at —
// and not a preference worth syncing, so it lives as long as the window does.
let lastViewedMachine: ExecutionHostId | null = null

export function rememberAgentsMachine(id: ExecutionHostId): void {
  lastViewedMachine = id === LOCAL_HOST_ID ? null : id
}

export function lastAgentsMachine(): ExecutionHostId | null {
  return lastViewedMachine
}

export type MachineCliAvailability = {
  hostId: ExecutionHostId
  map: AgentCliAvailabilityMap
  status: 'loading' | 'ready' | 'error'
  error: string | null
  checkedAt: number | null
}

// How long a WSL machine waits after the last keystroke in a command override
// before it probes again. Each probe starts a process inside the distribution,
// and one per character would be one per character.
const COMMAND_PROBE_DELAY_MS = 500

/**
 * A WSL machine's agent CLIs, through the same batch read this machine's list
 * uses (`pluginsDetectAvailability`), with every CLI's runtime naming the
 * machine and that machine's own command override. Main detected them at
 * startup and holds the answer, so asking here probes only a CLI whose command
 * is new. Asked when the machine is shown, when an override changes, and on
 * `reload` — after a Re-check or an install main ran, which have already
 * detected what changed — and never on window focus.
 *
 * Null for this machine: its answer is the store's, as it always was.
 */
export function useMachineCliAvailability(
  hostId: ExecutionHostId,
  cliIds: readonly string[],
): { availability: MachineCliAvailability | null; reload: () => void } {
  const commands = useWorkspaceStore((s) => (isWslHostId(hostId) ? s.appSettings.hosts?.[hostId]?.cliCommands : null))
  const [availability, setAvailability] = useState<MachineCliAvailability | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const idsKey = cliIds.join('\u0000')
  const commandsKey = JSON.stringify(commands ?? {})
  const lastProbe = useRef<{
    hostId: ExecutionHostId
    idsKey: string
    commandsKey: string
    reloadToken: number
  } | null>(null)

  useEffect(() => {
    if (!isWslHostId(hostId) || typeof window.api?.pluginsDetectAvailability !== 'function') {
      setAvailability(null)
      lastProbe.current = null
      return
    }
    // Only an override edit waits for typing to stop; a new machine, a new
    // list or a reload asks at once.
    const previous = lastProbe.current
    const sameTarget = previous?.hostId === hostId && previous.idsKey === idsKey
    const reloaded = sameTarget && previous.reloadToken !== reloadToken
    const edited = sameTarget && previous.commandsKey !== commandsKey
    lastProbe.current = { hostId, idsKey, commandsKey, reloadToken }
    let cancelled = false
    setAvailability((current) =>
      current?.hostId === hostId
        ? { ...current, status: current.status === 'ready' ? 'ready' : 'loading' }
        : { hostId, map: {}, status: 'loading', error: null, checkedAt: null },
    )
    const probe = (): void => {
      const own = JSON.parse(commandsKey) as Record<string, string>
      const cliRuntimes = Object.fromEntries(
        idsKey
          .split('\u0000')
          .filter(Boolean)
          .map((cli) => [cli, { command: own[cli] ?? '', hostId }]),
      )
      void window.api
        .pluginsDetectAvailability({ cliRuntimes })
        .then((result) => {
          if (cancelled) return
          setAvailability(
            result.ok
              ? { hostId, map: result.availability, status: 'ready', error: null, checkedAt: Date.now() }
              : { hostId, map: {}, status: 'error', error: result.message, checkedAt: null },
          )
        })
        .catch((error: unknown) => {
          if (cancelled) return
          const message = error instanceof Error ? error.message : String(error)
          setAvailability({ hostId, map: {}, status: 'error', error: message, checkedAt: null })
        })
    }
    const timer = edited && !reloaded ? setTimeout(probe, COMMAND_PROBE_DELAY_MS) : null
    if (timer === null) probe()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [hostId, idsKey, commandsKey, reloadToken])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  return { availability: availability?.hostId === hostId ? availability : null, reload }
}
