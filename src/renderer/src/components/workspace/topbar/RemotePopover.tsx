import React from 'react'

import type { TailnetPresence } from './useTailnetPresence'
import { CloseIconButton, GhostButton, IconButton, OutlineButton, PanelHeader, RefreshIcon, Tooltip } from '../../ui'
import { RemoteMachineGlyph } from '../../AppIcons'
import { useRelativeNow } from '../../../hooks/useRelativeNow'
import { formatElapsedMs, formatRelativeMsAgo } from '../../../utils/relativeTime'
import type { TailnetLiveDevice } from '../../../../../shared/tailnet'
import type { MeshConnection } from '../../../../../shared/tailnet-mesh'
import { showToast } from '../../../store/toastStore'
import { PairRequestCard } from '../../remote/PairRequestCard'
import { OutboundPairRequestCard } from '../../remote/OutboundPairRequestCard'
import {
  meshMachinePhase,
  machineGlyphToneClass,
  machineIsAnswering,
  machinePhaseText,
  machineRowAction,
  shortMachineName,
  type MeshMachinePhase,
} from '../../remote/machineRowModel'

// The machine-row vocabulary lives in `remote/machineRowModel.ts` now (pair-
// from-the-scan-and-stay-paired, phase 4), shared with the Mesh; re-exported
// so the glyph's tests keep one import.
export { meshMachinePhase, machinePhaseText, type MeshMachinePhase }

// The Remote glyph's surface (remote-sessions-ux / remote-glyph-topbar):
// ONE list of the other machines — the devices holding a socket here and the
// machines this Studio drives, each a name, a state, and the one action it
// earns. `popupRole="dialog"`, like the notifications popover — the rows
// carry their own buttons and are not activatable items.
// Everything here is fed by the push channel; nothing polls.
//
// NO ADDRESSES (owner ruling 2026-09-05). This machine's listening endpoint
// and every peer's tailnet address used to read here in mono; a popover that
// is opened on a shared screen or a stream should not be the place a person's
// tailnet is enumerated, and the address answers no question the name and the
// state do not. Settings → Remote still shows this machine's endpoint, which
// is where someone goes to type it somewhere else. The split into "This
// machine" and "Machines" went with them: a phone connected here is not this
// machine, and two headings over two flavours of the same fact was the
// confusion the ruling names.

export function RemotePopover({
  presence,
  onOpenRemoteSettings,
}: {
  presence: TailnetPresence
  onOpenRemoteSettings: () => void
}) {
  const { status, live, mesh, meshRequests, meshReachability } = presence
  const now = useRelativeNow(1000)
  const pairRequests = status?.pairRequests ?? []
  // The count over the list is what the list holds: connected devices and
  // paired machines, the rows a person came to look at.
  const rowCount = live.devices.length + mesh.length
  // Where "Add a machine…" and "Pair again" go: Settings → Remote, which
  // draws the picker. The Fleet panel is being retired (owner, 2026-09-05),
  // so this surface no longer routes anyone into it.
  const quiet = rowCount === 0 && pairRequests.length === 0 && meshRequests.length === 0
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
        {meshRequests.map((request) => (
          <OutboundPairRequestCard key={request.requestId} request={request} now={now} />
        ))}
        {live.devices.map((device) => (
          <ConnectedDeviceRow key={device.deviceId} device={device} now={now} />
        ))}
        {mesh.map((connection) => (
          <MachineRow
            key={connection.id}
            connection={connection}
            phase={meshMachinePhase(connection.id, meshReachability)}
            now={now}
            listening={listening}
            onPairAgain={onOpenRemoteSettings}
          />
        ))}
        {quiet ? (
          <div className="px-2.5 pb-1 pt-1 text-micro text-[color:var(--text-subtle)]">No machines connected.</div>
        ) : null}
        {/* The two ways out of the list, on one row: pairing another machine
            and the tab that holds everything this popover leaves out. */}
        <div className="flex items-center gap-2 px-2.5 pb-1 pt-0.5">
          <Tooltip
            content={
              listening ? 'Scan the tailnet and pair another machine' : 'Not connected to Tailscale — nothing to scan'
            }
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
 * One inbound device holding a socket here: its name, how long it has been
 * connected ("Connected for 12m"), and Revoke.
 *
 * Connected is connected: the glyph is steady green whatever the device is
 * doing, because amber in this app means someone has to do something and a
 * phone following a chat is the feature working.
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
  return (
    <div className="px-2.5 py-1.5 text-meta">
      <div className="flex items-center gap-2">
        {/* Connected is green, on the glyph (owner ruling 2026-09-05: the
            glyph is the row's one status channel; no dot beside it). */}
        <span role="img" aria-label="Connected" className="flex shrink-0 items-center">
          <RemoteMachineGlyph className="size-icon-sm shrink-0 text-[color:var(--tone-good)]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-[color:var(--text-default)]">
            {shortMachineName(device.deviceName)}
          </span>
          <span className="block truncate text-micro tabular-nums text-[color:var(--text-subtle)]">
            {deviceLivenessText(device, now)}
          </span>
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
    </div>
  )
}

/** "Connected for 12m" from the socket's open, else "Last seen 3m ago" from the last activity main saw. */
export function deviceLivenessText(
  device: Pick<TailnetLiveDevice, 'connectedSince' | 'lastActivityAt'>,
  now: number,
): string {
  if (device.connectedSince !== null) return `Connected for ${formatElapsedMs(device.connectedSince, now)}`
  if (device.lastActivityAt !== null) return `Last seen ${formatRelativeMsAgo(device.lastActivityAt, now)}`
  return 'Connected'
}

/**
 * One paired machine: its phase from main's reachability check (phase 4), the
 * one action the phase earns (Retry for a machine that stopped answering, Pair
 * again for one that revoked us), and Disconnect, which is always available
 * (owner ruling 2026-09-05: a machine you can add here is a machine you can
 * drop here).
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
  connection: MeshConnection
  phase: MeshMachinePhase
  now: number
  /** This device is on the tailnet. Off it the row is remembered, not reachable: disabled ink, no Retry. */
  listening: boolean
  onPairAgain: () => void
}) {
  const [retrying, setRetrying] = React.useState(false)
  const [forgetting, setForgetting] = React.useState(false)
  const action = listening ? machineRowAction(phase) : null
  const name = shortMachineName(connection.machineName)
  const phaseText = listening ? machinePhaseText(phase, now) : ''
  const ink = listening ? 'text-[color:var(--text-default)]' : 'text-[color:var(--text-disabled)]'
  const retry = async (): Promise<void> => {
    if (retrying) return
    setRetrying(true)
    try {
      await window.api.meshCheckReachability(connection.id)
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
      await window.api.meshForget(connection.id)
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
        <Tooltip
          content={`${name} took back its pairing — ask it again`}
          placement="bottom"
          wrapperClassName="shrink-0"
        >
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

// The glyph vocabulary now lives beside this file (see `remoteGlyph.ts`) so the
// title-bar trigger can read it without pulling this popover into the eager
// boot chunk. Re-exported here because this module is the surface those helpers
// describe, and every existing importer names it.
export { remoteGlyphState, remoteGlyphTooltip, remoteGlyphToneClass, useOpenRemoteSettings } from './remoteGlyph'
