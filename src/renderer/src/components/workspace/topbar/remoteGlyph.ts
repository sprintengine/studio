import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { fleetMachinePhase, machineIsAnswering } from '../../remote/machineRowModel'

// The Remote glyph's own vocabulary — state, tooltip, ink, and the settings
// opener the trigger needs. Split out of `RemotePopover.tsx` so the title bar's
// glyph can read it without the popover's body (machine rows, pair-request
// cards, the tailnet panel model) riding into the boot chunk: the popover
// itself is behind a `React.lazy` boundary in `WorkspaceActions` and only
// arrives when someone opens it. `RemotePopover` re-exports all four, so the
// module that owns the surface is still the one you can import them from.

/**
 * The glyph's state, derived once so the trigger and its tests agree. The
 * tone vocabulary is the app's (owner ruling 2026-09-05): the GLYPH ITSELF is
 * green while this Studio is serving or something is connected, amber while
 * something wants a person — a waiting pair request, or a machine that
 * stopped answering — and the default ink when remote is idle. A device
 * driving a terminal here is green like any other connection; it is reported
 * in the tooltip and the row, not by an alarm. The corner dot that used to
 * carry all this is gone: two indicators for one state, on a 16px glyph.
 */
export function remoteGlyphState(presence: TailnetPresence): {
  visible: boolean
  driving: boolean
  /** The inbound listener is up: this Studio can be reached, so the glyph is green. */
  serving: boolean
  connected: boolean
  /** An outbound link is reconnecting or has given up. Read by the tooltip; the glyph's ink no longer changes for it. */
  degraded: boolean
  requestCount: number
  /** Paired machines answering right now — the count the glyph wears, the way the terminal glyph counts sessions. */
  answering: number
  /** Why the listener is down when it was asked to be up; null while it is up or off. */
  listenerError: string | null
} {
  const enabled = presence.status?.enabled === true
  const driving = presence.live.devices.some((device) => device.attachedTerminalSessions.length > 0)
  const connected =
    presence.live.devices.length > 0 || [...presence.fleetLiveSessions.values()].some((sessions) => sessions.size > 0)
  const degraded =
    [...presence.fleetAttachments.values()].some(
      (attachment) => attachment.state === 'reconnecting' || attachment.state === 'offline',
    ) ||
    // A machine that revoked us is degraded too: it will not fix itself, and
    // the glyph is where a person would look before opening anything.
    [...presence.fleetReachability.values()].some((entry) => entry.unauthorized)
  const serving = presence.status?.running === true
  const answering = serving
    ? presence.fleet.filter((connection) =>
        machineIsAnswering(fleetMachinePhase(connection.id, presence.fleetAttachments, presence.fleetReachability)),
      ).length
    : 0
  return {
    // Hidden entirely while the feature is off — absent, not present-but-empty
    // (epic cross-cutting acceptance). A fleet-only user still gets it: paired
    // machines are remote presence even with the inbound listener off.
    visible: enabled || presence.fleet.length > 0,
    driving,
    serving,
    connected,
    degraded,
    requestCount: presence.status?.pairRequests.length ?? 0,
    answering,
    listenerError: enabled && !serving ? (presence.status?.lastError ?? null) : null,
  }
}

/**
 * What hovering the glyph says (owner ruling 2026-09-05): the glyph's ink is
 * the state, and the tooltip is where the words are — live, not connected,
 * or the error — since the popover's header no longer carries them.
 */
export function remoteGlyphTooltip(state: ReturnType<typeof remoteGlyphState>): string {
  if (state.requestCount > 0) return 'Remote — a pair request is waiting'
  if (!state.serving) {
    return state.listenerError
      ? `Remote — not connected to Tailscale. ${state.listenerError}`
      : 'Remote — not connected to Tailscale'
  }
  const machines = state.answering === 1 ? '1 machine answering' : `${state.answering} machines answering`
  if (state.driving) return `Remote — live · ${machines} · a device is driving a terminal here`
  if (state.degraded) return `Remote — live · ${machines} · a link is reconnecting`
  return `Remote — live · ${machines}`
}

// Not a component so the store hook stays out of the popover proper: the
// trigger needs the settings opener too, and both hosts read it here.
export function useOpenRemoteSettings(): () => void {
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  return React.useCallback(() => openSettingsOverlay({ initialTab: 'remote' }), [openSettingsOverlay])
}

/**
 * The glyph's own ink, from the state above. Amber pulses because it is the
 * only tone that asks for something; green never does — a steady mark is a
 * fact, an animated one is a request (owner ruling 2026-09-05).
 *
 * Green means one thing: this device is on the tailnet and can be reached. Off
 * it, the default ink — grey, never red, because being offline is not an
 * error (owner ruling 2026-09-05). A machine that stopped answering no longer
 * turns the glyph amber either: its own glyph in the popover says so.
 */
export function remoteGlyphToneClass(state: ReturnType<typeof remoteGlyphState>): string {
  if (state.requestCount > 0) {
    return 'animate-pulse text-[color:var(--tone-warn)] motion-reduce:animate-none'
  }
  if (state.serving) return 'text-[color:var(--tone-good)]'
  return ''
}
