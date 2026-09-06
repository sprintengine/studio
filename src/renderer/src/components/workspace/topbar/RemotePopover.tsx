import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import { CloseIconButton, GhostButton, IconButton, OutlineButton, PanelHeader, RefreshIcon, Tooltip } from '../../ui'
import { RemoteMachineGlyph } from '../../AppIcons'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { useTerminalSessions } from '../../../hooks/useTerminalSessions'
import { revealAgentTerminalTab } from '../../../utils/agentTabReveal'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { formatElapsedMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import type { TailnetLiveDevice } from '../../../../../shared/tailnet'
import type { FleetConnection } from '../../../../../shared/tailnet-fleet'
import { showToast } from '../../../store/toastStore'
import { PairRequestCard } from '../../remote/PairRequestCard'
import { OutboundPairRequestCard } from '../../remote/OutboundPairRequestCard'
import {
  drivenTerminalView,
  fleetMachinePhase,
  machineGlyphToneClass,
  machineIsAnswering,
  machinePhaseText,
  machineRowAction,
  shortMachineName,
  type FleetMachinePhase,
} from '../../remote/machineRowModel'

// The machine-row vocabulary lives in `remote/machineRowModel.ts` now (pair-
// from-the-scan-and-stay-paired, phase 4), shared with the Fleet; re-exported
// so the glyph's tests keep one import.
export { fleetMachinePhase, machinePhaseText, type FleetMachinePhase }

// The Remote glyph's surface (remote-sessions-ux / remote-glyph-topbar):
// ONE list of the other machines — the devices holding a socket here and the
// machines this Studio drives, each a name, a state, and the one action it
// earns. `popupRole="dialog"`, like the notifications popover — the rows
// carry their own buttons and are not activatable items (MC-2138's ruling).
// Everything here is fed by the push channel; nothing polls.
//
// NO ADDRESSES (owner ruling 2026-09-05). This machine's listening endpoint
// and every peer's tailnet address used to read here in mono; a popover that
// is opened on a shared screen or a stream should not be the place a person's
// tailnet is enumerated, and the address answers no question the name and the
// state do not. Settings → Remote still shows this machine's endpoint, which
// is where someone goes to type it somewhere else. The split into "This
// machine" and "Machines" went with them: a phone driving a terminal here is
// not this machine, and two headings over two flavours of the same fact was
// the confusion the ruling names.

export function RemotePopover({
  presence,
  onOpenRemoteSettings,
}: {
  presence: TailnetPresence
  onOpenRemoteSettings: () => void
}) {
  const { status, live, fleet, fleetAttachments, fleetRequests, fleetReachability } = presence
  const now = useRelativeNow(1000)
  const pairRequests = status?.pairRequests ?? []
  // The count over the list is what the list holds: connected devices and
  // paired machines, the rows a person came to look at.
  const rowCount = live.devices.length + fleet.length
  // Where "Add a machine…" and "Pair again" go: Settings → Remote, which
  // draws the picker. The Fleet panel is being retired (owner, 2026-09-05),
  // so this surface no longer routes anyone into it.
  const quiet = rowCount === 0 && pairRequests.length === 0 && fleetRequests.length === 0
  // Whether this device is on the tailnet at all. The header does not say it
  // (owner ruling 2026-09-05: no dot, no "Serving" — the glyph that opened
  // this popover is green when the listener is up, and its tooltip has the
  // words). Off the tailnet, the rows below are drawn in disabled ink: they
  // are remembered, not reachable, and nothing here can check on them.
  const listening = status?.running === true
  return (
    <div className="w-[360px]" data-tailnet-listening={listening ? 'true' : 'false'}>
      <PanelHeader title="Remote" count={rowCount > 0 ? rowCount : undefined} />
      <div className="max-h-[420px] overflow-y-auto pb-1">
        {/* Requests waiting on a person here, first: the only rows that ask
            for anything. Then the machines, in one list. */}
        {pairRequests.map((request) => (
          <PairRequestCard key={request.id} request={request} now={now} />
        ))}
        {/* Requests THIS machine made, waiting: the code to read out lives
            here as well as in the panel that asked (phase 3). */}
        {fleetRequests.map((request) => (
          <OutboundPairRequestCard key={request.requestId} request={request} now={now} />
        ))}
        {live.devices.map((device) => (
          <ConnectedDeviceRow key={device.deviceId} device={device} now={now} />
        ))}
        {fleet.map((connection) => (
          <MachineRow
            key={connection.id}
            connection={connection}
            phase={fleetMachinePhase(connection.id, fleetAttachments, fleetReachability)}
            now={now}
            listening={listening}
            onPairAgain={onOpenRemoteSettings}
          />
        ))}
        {quiet ? (
          <div className="px-2.5 pb-1 pt-1 text-micro text-[color:var(--text-subtle)]">
            No machines connected.
          </div>
        ) : null}
        {/* The two ways out of the list, on one row: pairing another machine
            and the tab that holds everything this popover leaves out. */}
        <div className="flex items-center gap-2 px-2.5 pb-1 pt-0.5">
          <Tooltip
            content={listening ? 'Scan the tailnet and pair another machine' : 'Not connected to Tailscale — nothing to scan'}
            placement="top"
          >
            <GhostButton size="sm" onClick={onOpenRemoteSettings} disabled={!listening}>
              Add a machine…
            </GhostButton>
          </Tooltip>
          <span className="flex-1" />
          <GhostButton size="sm" onClick={onOpenRemoteSettings}>
            Remote settings
          </GhostButton>
        </div>
      </div>
    </div>
  )
}

/**
 * One inbound device holding a socket here: its name and how long it has been
 * connected ("Connected for 12m"), Revoke, and — on its OWN LINE —
 * what it is driving, by the agent's name and as a way in (owner ruling
 * 2026-09-05). The session id used to ride the title line and was the one
 * thing on the row nobody could read.
 *
 * Connected is connected: the dot is steady green whether or not the device is
 * typing, because amber in this app means someone has to do something and a
 * phone driving a terminal is the feature working.
 */
function ConnectedDeviceRow({ device, now }: { device: TailnetLiveDevice; now: number }) {
  const [revoking, setRevoking] = React.useState(false)
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
  const driving = device.attachedTerminalSessions.length > 0
  return (
    <div className="px-2.5 py-1.5 text-meta">
      <div className="flex items-center gap-2">
        {/* Connected is green, on the glyph (owner ruling 2026-09-05: the
            glyph is the row's one status channel; no dot beside it). */}
        <span role="img" aria-label={driving ? 'Driving a terminal' : 'Connected'} className="flex shrink-0 items-center">
          <RemoteMachineGlyph className="size-icon-sm shrink-0 text-[color:var(--tone-good)]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[color:var(--text-default)]">
            {shortMachineName(device.deviceName)}
          </span>
          <span className="block truncate text-micro tabular-nums text-[color:var(--text-subtle)]">{deviceLivenessText(device, now)}</span>
        </span>
        {/* A glyph, not a word (owner ruling 2026-09-05): the row is narrow,
            the actions are the same two everywhere, and a red X is read faster
            than "Revoke" — the tooltip and the accessible name carry what it
            does and to whom. */}
        <Tooltip
          content={`Revoke ${shortMachineName(device.deviceName)} — it must pair again to come back`}
          placement="left"
          wrapperClassName="shrink-0"
        >
          <CloseIconButton
            tone="danger"
            aria-label={`Revoke ${device.deviceName}`}
            disabled={revoking}
            onClick={() => void revoke()}
          />
        </Tooltip>
      </div>
      {device.attachedTerminalSessions.map((sessionId) => (
        <DrivenTerminalLine key={sessionId} sessionId={sessionId} />
      ))}
    </div>
  )
}

/**
 * What the device is typing into, named and openable. Indented under its
 * device and one per driven session: two terminals driven at once is two
 * lines, because each is a different place to go.
 */
function DrivenTerminalLine({ sessionId }: { sessionId: string }) {
  const sessions = useTerminalSessions()
  const workspaces = useWorkspaceStore((state) => state.workspaces)
  const view = React.useMemo(
    () =>
      drivenTerminalView(sessionId, sessions, (workspaceId, agentId) => {
        const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
        return workspace?.agents[agentId]?.name ?? null
      }),
    [sessionId, sessions, workspaces]
  )
  const label = (
    <>
      <span className="text-[color:var(--text-subtle)]">Driving </span>
      <span className="truncate">{view.label}</span>
    </>
  )
  const target = view.target
  return (
    <div className="flex min-w-0 items-center pl-6 pt-0.5 text-micro">
      {target ? (
        <Tooltip content={`Open ${view.label}`} placement="bottom">
          <button
            type="button"
            className="interactive min-w-0 max-w-full truncate rounded-[3px] text-left text-[color:var(--accent-primary)] hover:underline focus-visible:focus-ring"
            onClick={() => {
              // The reveal activates the workspace, which is what clears a door
              // or modal surface standing over the layout (agentTabReveal).
              if (!revealAgentTerminalTab(target)) {
                showToast({ tone: 'neutral', title: `${view.label} is not open in a workspace right now` })
              }
            }}
          >
            {label}
          </button>
        </Tooltip>
      ) : (
        <span className="min-w-0 truncate text-[color:var(--text-subtle)]">{label}</span>
      )}
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
 * with none — from main's reachability check (phase 4), the one action the
 * phase earns (Retry for a machine that stopped answering, Pair again for one
 * that revoked us), and Disconnect, which is always available (owner ruling
 * 2026-09-05: a machine you can add here is a machine you can drop here).
 *
 * Disconnect only ends the half of the pairing this device owns — the grant over
 * there is that machine's to revoke — and the toast says so, because
 * "removed" and "revoked" are different promises.
 */
function MachineRow({
  connection,
  phase,
  now,
  listening,
  onPairAgain,
}: {
  connection: FleetConnection
  phase: FleetMachinePhase
  now: number
  /** This device is on the tailnet. Off it the row is remembered, not reachable: disabled ink, no Retry. */
  listening: boolean
  onPairAgain: () => void
}) {
  const [retrying, setRetrying] = React.useState(false)
  const [forgetting, setForgetting] = React.useState(false)
  const action = listening ? machineRowAction(phase) : null
  const name = shortMachineName(connection.machineName)
  const phaseText = listening ? machinePhaseText(name, phase, now) : ''
  const ink = listening ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-disabled)]'
  const retry = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    try {
      await window.api.fleetCheckReachability(connection.id)
      // The push channel updates the row; nothing to do locally.
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not check ${name}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRetrying(false)
    }
  }
  const disconnect = async (): Promise<void> => {
    if (forgetting) return
    setForgetting(true)
    try {
      await window.api.fleetForget(connection.id)
      // `machine-forgotten` clears the row everywhere and announces the
      // removal; the half only a person over there can do is added here.
      showToast({
        tone: 'neutral',
        title: `${name} disconnected`,
        description: `Revoke “${connection.deviceName}” in that machine's Remote settings to end the grant it gave this device.`,
      })
    } catch (error) {
      showToast({
        tone: 'error',
        title: `Could not disconnect ${name}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setForgetting(false)
    }
  }
  return (
    <div
      className="flex items-center gap-2 px-2.5 py-1.5 text-meta"
      data-machine-phase={phase.phase}
      data-machine-answering={listening && machineIsAnswering(phase) ? 'true' : 'false'}
    >
      {/* One glyph vocabulary for anything remote (epic decision 7), and the
          glyph's ink is the row's whole status (owner ruling 2026-09-05):
          green while the machine answers, the default ink while it does not,
          disabled ink while this device cannot ask. */}
      <span
        role="img"
        aria-label={
          !listening
            ? 'Not connected to Tailscale'
            : machineIsAnswering(phase)
              ? 'Answering'
              : phase.phase === 'revoked'
                ? 'Revoked there'
                : 'Not answering'
        }
        className="flex shrink-0 items-center"
      >
        <RemoteMachineGlyph
          className={`size-icon-sm shrink-0 ${listening ? machineGlyphToneClass(phase) : 'text-[color:var(--text-disabled)]'}`}
        />
      </span>
      {/* The name column is what gives way when the row is tight: the tooltip's
          own wrapper is the flex child, so it carries the shrink (its actions
          were being clipped off the right edge without it). */}
      <Tooltip content={connection.machineName} placement="bottom" wrapperClassName="min-w-0 flex-1">
        <span className="block min-w-0">
          <span className={`block truncate font-medium ${ink}`}>{name}</span>
          {/* A machine that answers gets no line under its name — green is
              the whole message. Only a machine with something to say does. */}
          {phaseText ? (
            <span className="block truncate text-micro tabular-nums text-[color:var(--text-subtle)]">{phaseText}</span>
          ) : null}
        </span>
      </Tooltip>
      {/* Glyphs, not words: the check is the canonical refresh mark and the
          removal a red X, so three machines in a 360px popover keep their
          names instead of losing them to two buttons. "Pair again" stays a
          word — it is a different, rarer act than re-checking, and no glyph
          says it. */}
      {action === 'retry' ? (
        <Tooltip
          content={retrying ? `Checking ${name}…` : `Check whether ${name} is answering`}
          placement="bottom"
          wrapperClassName="shrink-0"
        >
          <IconButton
            aria-label={`Check whether ${name} is answering`}
            onClick={() => void retry()}
            disabled={retrying}
          >
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      ) : action === 'pair-again' ? (
        <Tooltip content={`${name} took back its pairing — ask it again`} placement="bottom" wrapperClassName="shrink-0">
          <OutlineButton size="xs" onClick={onPairAgain}>
            Pair again
          </OutlineButton>
        </Tooltip>
      ) : null}
      <Tooltip content={`Remove ${name} from this device`} placement="left" wrapperClassName="shrink-0">
        <CloseIconButton
          tone="danger"
          aria-label={`Remove ${name} from this device`}
          disabled={forgetting}
          onClick={() => void disconnect()}
        />
      </Tooltip>
    </div>
  )
}

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
    presence.live.devices.length > 0
    || [...presence.fleetLiveSessions.values()].some((sessions) => sessions.size > 0)
  const degraded =
    [...presence.fleetAttachments.values()].some(
      (attachment) => attachment.state === 'reconnecting' || attachment.state === 'offline'
    )
    // A machine that revoked us is degraded too: it will not fix itself, and
    // the glyph is where a person would look before opening anything.
    || [...presence.fleetReachability.values()].some((entry) => entry.unauthorized)
  const serving = presence.status?.running === true
  const answering = serving
    ? presence.fleet.filter((connection) =>
        machineIsAnswering(fleetMachinePhase(connection.id, presence.fleetAttachments, presence.fleetReachability))
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
    listenerError: enabled && !serving ? presence.status?.lastError ?? null : null,
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
    return state.listenerError ? `Remote — not connected to Tailscale. ${state.listenerError}` : 'Remote — not connected to Tailscale'
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
