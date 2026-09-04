import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import {
  GhostButton,
  MENU_DIVIDER_CLASS,
  MENU_GROUP_LABEL_CLASS,
  OutlineButton,
  PanelHeader,
  PrimaryButton,
  StatusDot,
} from '../../ui'
import { RemoteMachineGlyph } from '../../AppIcons'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { formatElapsedMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import type { TailnetLiveDevice, TailnetPairRequest, TailnetScope } from '../../../../../shared/tailnet'
import type { FleetLiveAttachment, FleetLinkState } from '../../../../../shared/tailnet-fleet'
import type { StatusTone } from '../../ui/tokens'
import { pairRequestAnswerable } from '../../settings/tailnetPanelModel'
import { showToast } from '../../../store/toastStore'

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
  const { status, live, fleet, fleetAttachments } = presence
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
        {fleet.length === 0 ? (
          <div className="px-2.5 pb-1 text-micro text-[color:var(--text-subtle)]">
            No machines paired. Pair one from the Fleet.
          </div>
        ) : (
          fleet.map((connection) => {
            const phase = fleetMachinePhase(connection.id, fleetAttachments)
            const dot = MACHINE_PHASE_DOT[phase.phase]
            return (
              <div key={connection.id} className="flex items-center gap-2 px-2.5 py-1.5 text-meta">
                {/* One glyph vocabulary for anything remote (epic decision 7). */}
                <RemoteMachineGlyph className="size-icon-sm shrink-0 text-[color:var(--text-subtle)]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-[color:var(--text-default)]">{connection.machineName}</span>
                    <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">
                      {connection.endpoint}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
                    <StatusDot tone={dot.tone} pulse={dot.pulse} label={dot.label} />
                    <span className="truncate">{machinePhaseText(connection.machineName, phase)}</span>
                  </span>
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

// ── Machines: a per-machine phase from its attachments ───────────────────
//
// The fleet holds no per-machine supervisor (the live-state child's recorded
// drift), so the phase is DERIVED from the links this app holds to it, the
// same source that supplies connection status:
// any live link → connected; otherwise any link dialling → connecting or
// reconnecting; otherwise a link that gave up → offline; no link → paired.
// Reachability of a machine nothing is attached to is not claimed.

export type FleetMachinePhase =
  | { phase: 'paired' }
  | { phase: 'connecting'; detail: string }
  | { phase: 'reconnecting'; detail: string }
  | { phase: 'offline'; detail: string }
  | { phase: 'connected'; liveSessions: number }

export function fleetMachinePhase(
  connectionId: string,
  attachments: ReadonlyMap<string, FleetLiveAttachment>
): FleetMachinePhase {
  const mine = [...attachments.values()].filter((attachment) => attachment.connectionId === connectionId)
  const liveSessions = new Set(mine.filter((a) => a.state === 'live').map((a) => a.sessionId))
  if (liveSessions.size > 0) return { phase: 'connected', liveSessions: liveSessions.size }
  const first = (state: FleetLinkState): FleetLiveAttachment | undefined => mine.find((a) => a.state === state)
  const reconnecting = first('reconnecting')
  if (reconnecting) return { phase: 'reconnecting', detail: reconnecting.detail }
  const connecting = first('connecting')
  if (connecting) return { phase: 'connecting', detail: connecting.detail }
  const offline = first('offline')
  if (offline) return { phase: 'offline', detail: offline.detail }
  return { phase: 'paired' }
}

/** Connection phases use consistent tones: good steady, warn with a halo while transitional, error when the peer stopped answering, muted otherwise. */
const MACHINE_PHASE_DOT: Record<FleetMachinePhase['phase'], { tone: StatusTone; pulse: boolean; label: string }> = {
  connected: { tone: 'good', pulse: false, label: 'Connected' },
  connecting: { tone: 'warn', pulse: true, label: 'Connecting' },
  reconnecting: { tone: 'warn', pulse: true, label: 'Reconnecting' },
  offline: { tone: 'error', pulse: false, label: 'Not answering' },
  paired: { tone: 'neutral', pulse: false, label: 'Paired' },
}

export function machinePhaseText(machineName: string, phase: FleetMachinePhase): string {
  switch (phase.phase) {
    case 'connected':
      return phase.liveSessions === 1 ? 'a terminal attached' : `${phase.liveSessions} terminals attached`
    case 'connecting':
      return `Connecting to ${machineName}…`
    case 'reconnecting':
      return `Reconnecting to ${machineName}…`
    case 'offline':
      return `${machineName} is not answering`
    case 'paired':
      return 'paired'
  }
}

// The scope choices the card offers, in the mockup's four combined rows:
// operate implies read within a family (shared/tailnet's own rule), so one
// checkbox per family grants the pair, and the terminal tier — arbitrary
// shell — stays its own named line, never bundled.
const PAIR_SCOPE_ROWS: Array<{ label: string; scopes: TailnetScope[]; note?: string; defaultOn: boolean }> = [
  { label: 'Workspaces — read & operate', scopes: ['workspace:read', 'workspace:operate'], defaultOn: true },
  { label: 'Sprints — read & operate', scopes: ['sprint:read', 'sprint:operate'], defaultOn: true },
  { label: 'Backlog — read & operate', scopes: ['backlog:read', 'backlog:operate'], defaultOn: true },
  { label: 'Horizons — read & operate', scopes: ['horizon:read', 'horizon:operate'], defaultOn: true },
  { label: 'Terminals — control', scopes: ['terminal:observe', 'terminal:control'], note: 'arbitrary shell', defaultOn: false },
]

/**
 * The ACTING surface for a request from another machine (remote-sessions-ux /
 * incoming-pair-request-prompt): the six-digit comparison code rendered
 * large — the person must see the same digits on the asker's screen — the
 * scopes chosen HERE, a live countdown, Allow and Decline. Approval and
 * denial go through the exact IPC Settings uses; resolution reaches every
 * surface over the push channel, so no double-approve is possible. The code
 * lives ONLY here and in Settings — never in the announcing toast.
 */
function PairRequestCard({ request, now }: { request: TailnetPairRequest; now: number }) {
  const [granted, setGranted] = React.useState<ReadonlySet<string>>(
    () => new Set(PAIR_SCOPE_ROWS.filter((row) => row.defaultOn).map((row) => row.label))
  )
  const [busy, setBusy] = React.useState<'allow' | 'decline' | null>(null)
  const msLeft = Math.max(0, Date.parse(request.expiresAt) - now)
  const minutes = Math.floor(msLeft / 60_000)
  const seconds = Math.floor((msLeft % 60_000) / 1000)
  const scopes = PAIR_SCOPE_ROWS.filter((row) => granted.has(row.label)).flatMap((row) => row.scopes)
  // Settings' own rule: a lapsed request stays on screen until the channel
  // clears it, with its buttons dead and the reason stated — not failing.
  const answerable = pairRequestAnswerable(request, now)
  const disabled = busy !== null || !answerable.canAnswer

  const answer = async (kind: 'allow' | 'decline'): Promise<void> => {
    if (busy) return
    setBusy(kind)
    try {
      // Allow is disabled at zero scopes, so `scopes` is always a real grant.
      if (kind === 'allow') {
        const result = await window.api.tailnetApprovePairRequest(request.id, scopes)
        // `request_not_found` is an answer, not an exception — answered
        // elsewhere or lapsed under the cursor — and swallowing it would
        // leave a person who pressed Allow believing they had paired.
        if (!result.ok) {
          showToast({ tone: 'error', title: 'Could not approve the pair request', description: result.message })
        }
      } else await window.api.tailnetDenyPairRequest(request.id)
      // The push channel clears the card everywhere; nothing to do locally.
    } catch (error) {
      showToast({
        tone: 'error',
        title: kind === 'allow' ? 'Could not approve the pair request' : 'Could not decline the pair request',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-2.5 my-1.5 rounded-[7px] border border-[color:var(--border-default)] p-2.5">
      <div className="flex items-center gap-2 text-meta">
        <StatusDot tone="warn" pulse label="Pair request" />
        <span className="min-w-0 flex-1 truncate font-medium text-[color:var(--text-default)]">
          {request.peerNode ?? request.peerAddress}{' '}
          <span className="font-normal text-[color:var(--text-subtle)]">asks to pair</span>
        </span>
      </div>
      {/* Both identities, labelled: the node is what the transport proved
          (Tailscale's whois, or the bare address, unverified); the device
          name is whatever the asker typed. The approver must know which is
          which — the digits below are compared against the PROVEN machine. */}
      <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-micro">
        <dt className="text-[color:var(--text-subtle)]">{request.peerNode ? 'Tailnet node' : 'Address (unverified)'}</dt>
        <dd className="truncate font-mono text-[color:var(--text-default)]">{request.peerNode ?? request.peerAddress}</dd>
        <dt className="text-[color:var(--text-subtle)]">Calls itself</dt>
        <dd className="truncate text-[color:var(--text-default)]">{request.deviceName}</dd>
      </dl>
      <div className="my-2 rounded-[7px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] py-1.5 text-center font-mono text-title tracking-[0.3em] text-[color:var(--text-strong)]">
        {request.comparisonCode}
      </div>
      <div className="flex flex-col gap-1 pb-2">
        {PAIR_SCOPE_ROWS.map((row) => (
          <label key={row.label} className="flex cursor-pointer items-center gap-2 text-meta text-[color:var(--text-default)]">
            <input
              type="checkbox"
              className="accent-[color:var(--accent-primary)]"
              checked={granted.has(row.label)}
              onChange={(event) => {
                setGranted((current) => {
                  const next = new Set(current)
                  if (event.target.checked) next.add(row.label)
                  else next.delete(row.label)
                  return next
                })
              }}
            />
            {row.label}
            {row.note ? <span className="text-[color:var(--text-subtle)]">({row.note})</span> : null}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="font-mono text-micro tabular-nums text-[color:var(--tone-warn)]">
          {answerable.canAnswer ? `${minutes}:${String(seconds).padStart(2, '0')}` : 'Lapsed'}
        </span>
        <span className="flex-1" />
        <OutlineButton size="sm" disabled={disabled} onClick={() => void answer('decline')}>
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </OutlineButton>
        <PrimaryButton size="sm" disabled={disabled || scopes.length === 0} onClick={() => void answer('allow')}>
          {busy === 'allow' ? 'Allowing…' : 'Allow'}
        </PrimaryButton>
      </div>
      {answerable.note ? (
        <p className="mt-1.5 text-micro text-[color:var(--text-subtle)]">{answerable.note}</p>
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
  const degraded = [...presence.fleetAttachments.values()].some(
    (attachment) => attachment.state === 'reconnecting' || attachment.state === 'offline'
  )
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
