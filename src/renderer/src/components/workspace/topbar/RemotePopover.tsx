import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import { GhostButton, MENU_DIVIDER_CLASS, MENU_GROUP_LABEL_CLASS, PanelHeader, StatusDot } from '../../ui'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useRelativeNow } from '../../../hooks/useRelativeNow'

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
  const { status, live, fleet, fleetLiveSessions } = presence
  const now = useRelativeNow(1000)
  const openSettingsLabel = 'Remote settings'
  const machineCount = fleet.length
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
            <StatusDot tone="neutral" label="Not serving" />
            {status?.lastError ? status.lastError : 'The listener is off.'}
          </div>
        )}
        {status?.pairRequests.map((request) => {
          const msLeft = Math.max(0, Date.parse(request.expiresAt) - now)
          const minutes = Math.floor(msLeft / 60_000)
          const seconds = Math.floor((msLeft % 60_000) / 1000)
          return (
            <div key={request.id} className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
              <StatusDot tone="warn" pulse label="Pair request" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-[color:var(--text-default)]">
                  {request.peerNode ?? request.peerAddress}
                </span>{' '}
                <span className="text-[color:var(--text-subtle)]">asks to pair</span>
                <span className="ml-1.5 font-mono text-micro tabular-nums text-[color:var(--tone-warn)]">
                  {minutes}:{String(seconds).padStart(2, '0')}
                </span>
              </span>
              <GhostButton size="xs" onClick={onOpenRemoteSettings}>
                Review
              </GhostButton>
            </div>
          )
        })}
        {live.devices.map((device) => (
          <div key={device.deviceId} className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
            <StatusDot
              tone={device.attachedTerminalSessions.length > 0 ? 'warn' : 'good'}
              pulse={device.attachedTerminalSessions.length > 0}
              label={device.attachedTerminalSessions.length > 0 ? 'Driving a terminal' : 'Connected'}
            />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium text-[color:var(--text-default)]">{device.deviceName}</span>
              <span className="text-[color:var(--text-subtle)]">
                {device.attachedTerminalSessions.length > 0
                  ? ` — driving ${device.attachedTerminalSessions.length === 1 ? 'a terminal' : `${device.attachedTerminalSessions.length} terminals`}`
                  : ' — connected'}
              </span>
            </span>
            <GhostButton
              size="xs"
              className="text-[color:var(--tone-error)]"
              onClick={() => void window.api.tailnetRevokeDevice(device.deviceId)}
            >
              Revoke
            </GhostButton>
          </div>
        ))}
        {status?.running && live.devices.length === 0 && (status.pairRequests.length === 0) ? (
          <div className="px-2.5 pb-1 text-micro text-[color:var(--text-subtle)]">
            No device is connected right now.
          </div>
        ) : null}

        <div className={MENU_DIVIDER_CLASS} role="separator" />
        <div className={`${MENU_GROUP_LABEL_CLASS} pb-0.5 pt-1.5`}>Machines</div>
        {fleet.length === 0 ? (
          <div className="px-2.5 pb-1 text-micro text-[color:var(--text-subtle)]">
            No machines paired. Pair one from the Fleet.
          </div>
        ) : (
          fleet.map((connection) => {
            const liveCount = fleetLiveSessions.get(connection.id)?.size ?? 0
            return (
              <div key={connection.id} className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
                <StatusDot
                  tone={liveCount > 0 ? 'good' : 'neutral'}
                  label={liveCount > 0 ? 'Attached' : 'Paired'}
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-[color:var(--text-default)]">{connection.machineName}</span>
                  <span className="text-[color:var(--text-subtle)]">
                    {liveCount > 0
                      ? ` — ${liveCount === 1 ? 'a terminal attached' : `${liveCount} terminals attached`}`
                      : ' — paired'}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">
                  {connection.endpoint}
                </span>
              </div>
            )
          })
        )}
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

/** The stacked-server mark at title-bar scale, matching its neighbour icons. */
export function RemoteMachinesIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <rect x="2" y="2.8" width="12" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="8.6" width="12" height="4.6" rx="1.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.7" cy="5.1" r="0.75" fill="currentColor" />
      <circle cx="4.7" cy="10.9" r="0.75" fill="currentColor" />
    </svg>
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
  requestCount: number
} {
  const enabled = presence.status?.enabled === true
  const driving = presence.live.devices.some((device) => device.attachedTerminalSessions.length > 0)
  const connected =
    presence.live.devices.length > 0
    || [...presence.fleetLiveSessions.values()].some((sessions) => sessions.size > 0)
  return {
    // Hidden entirely while the feature is off — absent, not present-but-empty
    // (epic cross-cutting acceptance). A fleet-only user still gets it: paired
    // machines are remote presence even with the inbound listener off.
    visible: enabled || presence.fleet.length > 0,
    driving,
    connected,
    requestCount: presence.status?.pairRequests.length ?? 0,
  }
}

// Not a component so the store hook stays out of the popover proper: the
// trigger needs the settings opener too, and both hosts read it here.
export function useOpenRemoteSettings(): () => void {
  const openSettingsOverlay = useWorkspaceStore((state) => state.openSettingsOverlay)
  return React.useCallback(() => openSettingsOverlay({ initialTab: 'remote' }), [openSettingsOverlay])
}
