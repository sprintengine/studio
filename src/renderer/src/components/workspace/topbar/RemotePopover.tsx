import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import { GhostButton, MENU_DIVIDER_CLASS, MENU_GROUP_LABEL_CLASS, OutlineButton, PanelHeader, StatusDot } from '../../ui'
import { RemoteMachineGlyph } from '../../AppIcons'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { formatElapsedMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import type { TailnetLiveDevice } from '../../../../../shared/tailnet'
import type { FleetConnection } from '../../../../../shared/tailnet-fleet'
import { showToast } from '../../../store/toastStore'
import { PairRequestCard } from '../../remote/PairRequestCard'
import { OutboundPairRequestCard } from '../../remote/OutboundPairRequestCard'
import {
  fleetMachinePhase,
  MACHINE_PHASE_DOT,
  machinePhaseText,
  machineRowAction,
  type FleetMachinePhase,
} from '../../remote/machineRowModel'

// The machine-row vocabulary lives in `remote/machineRowModel.ts` now (pair-
// from-the-scan-and-stay-paired, phase 4), shared with the Fleet; re-exported
// so the glyph's tests keep one import.
export { fleetMachinePhase, machinePhaseText, type FleetMachinePhase }

// The Remote glyph's surface (remote-sessions-ux / remote-glyph-topbar):
// what this machine is serving and who is driving it, then the machines this
// Studio drives. `popupRole="dialog"`, like the notifications popover — the
// rows carry their own buttons and are not activatable items (MC-2138's
// ruling). Everything here is fed by the push channel; nothing polls.

export function RemotePopover({
  presence,
  onOpenFleet,
  onOpenRemoteSettings,
}: {
  presence: TailnetPresence
  /** Absent when no workspace is open to dock the Fleet panel into. */
  onOpenFleet: (() => void) | null
  onOpenRemoteSettings: () => void
}) {
  const { status, live, fleet, fleetAttachments, fleetRequests, fleetReachability } = presence
  const now = useRelativeNow(1000)
  const openSettingsLabel = 'Remote settings'
  const machineCount = fleet.length
  // Where "Add a machine…" and "Pair again" go: the Fleet when a workspace
  // can dock it, else Settings → Remote, which draws the same picker.
  const openPicker = onOpenFleet ?? onOpenRemoteSettings
  return (
    <div className="w-[360px]">
      <PanelHeader
        title="Remote"
        count={machineCount > 0 ? machineCount : undefined}
      />
      <div className="max-h-[420px] overflow-y-auto pb-1">
        <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>This machine</div>
        {status?.running && status.endpoint ? (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
            <StatusDot tone="good" label="Serving" />
            <span className="font-mono text-micro text-[color:var(--text-default)]">{status.endpoint}</span>
            <span className="text-[color:var(--text-subtle)]">serving</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-2.5 py-1.5 text-meta text-[color:var(--text-subtle)]">
            <StatusDot tone={status?.enabled && status.lastError ? 'error' : 'neutral'} label="Not serving" />
            {status?.lastError ? status.lastError : 'The listener is off.'}
          </div>
        )}
        {status?.pairRequests.map((request) => (
          <PairRequestCard key={request.id} request={request} now={now} />
        ))}
        {live.devices.map((device) => (
          <ConnectedDeviceRow key={device.deviceId} device={device} now={now} />
        ))}
        {status?.running && live.devices.length === 0 && (status.pairRequests.length === 0) ? (
          <div className="px-2.5 pb-1 text-micro text-[color:var(--text-subtle)]">
            No device is connected right now.
          </div>
        ) : null}

        <div className={MENU_DIVIDER_CLASS} role="separator" />
        <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>Machines</div>
        {/* Requests THIS machine made, waiting: the code to read out lives
            here as well as in the panel that asked (phase 3). */}
        {fleetRequests.map((request) => (
          <OutboundPairRequestCard key={request.requestId} request={request} now={now} />
        ))}
        {fleet.length === 0 && fleetRequests.length === 0 ? (
          <div className="px-2.5 pb-1 text-micro text-[color:var(--text-subtle)]">No machines paired.</div>
        ) : (
          fleet.map((connection) => (
            <MachineRow
              key={connection.id}
              connection={connection}
              phase={fleetMachinePhase(connection.id, fleetAttachments, fleetReachability)}
              now={now}
              onPairAgain={openPicker}
            />
          ))
        )}
        <div className="px-2.5 pb-1 pt-0.5">
          <GhostButton size="sm" onClick={openPicker}>
            Add a machine…
          </GhostButton>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-[color:var(--border-subtle)] px-2.5 py-1.5">
        {onOpenFleet ? (
          <GhostButton size="sm" onClick={onOpenFleet}>
            Open Fleet
          </GhostButton>
        ) : null}
        <GhostButton size="sm" onClick={onOpenRemoteSettings}>
          {openSettingsLabel}
        </GhostButton>
      </div>
    </div>
  )
}

/**
 * One inbound device holding a socket here: what it is attached to, how
 * long it has been connected, the peer the
 * transport saw, and Revoke — busy while pending, a toast when it fails,
 * the same shape Settings' `revokingDeviceId` gives its rows.
 */
function ConnectedDeviceRow({ device, now }: { device: TailnetLiveDevice; now: number }) {
  const [revoking, setRevoking] = React.useState(false)
  const driving = device.attachedTerminalSessions.length > 0
  const revoke = async (): Promise<void> => {
    if (revoking) return
    setRevoking(true)
    try {
      await window.api.tailnetRevokeDevice(device.deviceId)
      // The push channel removes the row everywhere; nothing to do locally.
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not revoke ${device.deviceName}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRevoking(false)
    }
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
      <StatusDot
        tone={driving ? 'warn' : 'good'}
        pulse={driving}
        label={driving ? 'Driving a terminal' : 'Connected'}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          <span className="font-medium text-[color:var(--text-default)]">{device.deviceName}</span>
          <span className="text-[color:var(--text-subtle)]">{driving ? ' — driving ' : ' — connected'}</span>
          {driving ? (
            // Named, not counted (the child's acceptance): the session ids
            // are the fact a person acts on — which terminal is being typed
            // into from another machine.
            <span className="font-mono text-micro text-[color:var(--text-default)]">
              {device.attachedTerminalSessions.join(', ')}
            </span>
          ) : null}
        </span>
        <span className="block truncate text-micro tabular-nums text-[color:var(--text-subtle)]">
          {deviceLivenessText(device, now)}
          {device.peerNode ?? device.peerAddress ? (
            <>
              {' · '}
              <span className="font-mono">{device.peerNode ?? device.peerAddress}</span>
            </>
          ) : null}
        </span>
      </span>
      <GhostButton
        size="xs"
        className="text-[color:var(--tone-error)]"
        disabled={revoking}
        onClick={() => void revoke()}
      >
        {revoking ? 'Revoking…' : 'Revoke'}
      </GhostButton>
    </div>
  )
}

/** "Connected for 12m" from the socket's open, else "Last seen 3m ago" from the last activity main saw. */
export function deviceLivenessText(device: Pick<TailnetLiveDevice, 'connectedSince' | 'lastActivityAt'>, now: number): string {
  if (device.connectedSince !== null) return `Connected for ${formatElapsedMs(device.connectedSince, now)}`
  if (device.lastActivityAt !== null) return `Last seen ${formatRelativeMsAgo(device.lastActivityAt, now)}`
  return 'Connected'
}

/**
 * One paired machine: its phase from the links this app holds to it, or —
 * with none — from main's reachability check (phase 4), and the one action
 * the phase earns: Retry for a machine that stopped answering, Pair again
 * for one that revoked us.
 */
function MachineRow({
  connection,
  phase,
  now,
  onPairAgain,
}: {
  connection: FleetConnection
  phase: FleetMachinePhase
  now: number
  onPairAgain: () => void
}) {
  const [retrying, setRetrying] = React.useState(false)
  const dot = MACHINE_PHASE_DOT[phase.phase]
  const action = machineRowAction(phase)
  const retry = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    try {
      await window.api.fleetCheckReachability(connection.id)
      // The push channel updates the row; nothing to do locally.
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not check ${connection.machineName}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-meta" data-machine-phase={phase.phase}>
      {/* One glyph vocabulary for anything remote (epic decision 7). */}
      <RemoteMachineGlyph className="size-icon-sm shrink-0 text-[color:var(--text-subtle)]" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate font-medium text-[color:var(--text-default)]">{connection.machineName}</span>
          <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">{connection.endpoint}</span>
        </span>
        <span className="flex items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
          <StatusDot tone={dot.tone} pulse={dot.pulse} label={dot.label} />
          <span className="truncate">{machinePhaseText(connection.machineName, phase, now)}</span>
        </span>
      </span>
      {action === 'retry' ? (
        <GhostButton size="sm" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Checking…' : 'Retry'}
        </GhostButton>
      ) : action === 'pair-again' ? (
        <OutlineButton size="sm" onClick={onPairAgain}>
          Pair again
        </OutlineButton>
      ) : null}
    </div>
  )
}

/**
 * The glyph's badge state, derived once so the trigger and its tests agree:
 * a waiting pair request outranks connection good-news, and "a remote device
 * is driving a terminal HERE" is the state that pulses.
 */
export function remoteGlyphState(presence: TailnetPresence): {
  visible: boolean
  driving: boolean
  connected: boolean
  /** An outbound link is reconnecting or has given up: the warn (non-pulsing) dot. */
  degraded: boolean
  requestCount: number
} {
  const enabled = presence.status?.enabled === true
  const driving = presence.live.devices.some((device) => device.attachedTerminalSessions.length > 0)
  const connected =
    presence.live.devices.length > 0
    || [...presence.fleetLiveSessions.values()].some((sessions) => sessions.size > 0)
  const degraded =
    [...presence.fleetAttachments.values()].some(
      (attachment) => attachment.state === 'reconnecting' || attachment.state === 'offline'
    )
    // A machine that revoked us is degraded too: it will not fix itself, and
    // the glyph is where a person would look before opening anything.
    || [...presence.fleetReachability.values()].some((entry) => entry.unauthorized)
  return {
    // Hidden entirely while the feature is off — absent, not present-but-empty
    // (epic cross-cutting acceptance). A fleet-only user still gets it: paired
    // machines are remote presence even with the inbound listener off.
    visible: enabled || presence.fleet.length > 0,
    driving,
    connected,
    degraded,
    requestCount: presence.status?.pairRequests.length ?? 0,
  }
}

// Not a component so the store hook stays out of the popover proper: the
// trigger needs the settings opener too, and both hosts read it here.
export function useOpenRemoteSettings(): () => void {
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  return React.useCallback(() => openSettingsOverlay({ initialTab: 'remote' }), [openSettingsOverlay])
}
