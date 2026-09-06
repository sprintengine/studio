import React from 'react'

import type { TailnetDevice, TailnetScope } from '../../../../shared/tailnet'
import type { FleetConnection, FleetMachineReachability } from '../../../../shared/tailnet-fleet'
import type { TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { Checkbox, OutlineButton, PrimaryButton, StatusDot, Tooltip } from '../ui'
import { RemoteMachineGlyph } from '../AppIcons'
import { connectDirectionNote, peerPickerView } from './peerPickerModel'
import { DEFAULT_PAIR_SCOPES } from './pairRequestAnswer'

// The one machine picker (pair-from-the-scan-and-stay-paired, phase 1),
// rendered by Settings → Remote and the Fleet alike. Scan, see every machine
// on the tailnet with what we know about it, and press Connect on one that
// answers as a Studio. The row says which way the grant runs before the
// click, and — when this machine's own listener is up — offers the reverse
// half so the two pair both ways in one exchange (phase 6).

export function PeerPicker({
  scan,
  scanning,
  connections,
  reachability,
  devices,
  now,
  onScan,
  onConnect,
  /** Whether this machine's own listener is running, so the reverse offer can be made. */
  canOfferReverse,
  busy,
  /** Set when a request is already waiting; Connect is dead meanwhile. */
  waitingOn,
  intro,
}: {
  scan: TailnetPeerScan | null
  scanning: boolean
  connections: readonly FleetConnection[]
  reachability: ReadonlyMap<string, FleetMachineReachability>
  /** Devices paired to this machine, so a paired phone is not read as a missing Studio. */
  devices?: readonly TailnetDevice[]
  now: number
  onScan: () => void
  onConnect: (endpoint: string, reverseScopes: TailnetScope[] | null) => void
  canOfferReverse: boolean
  busy: boolean
  waitingOn: string | null
  intro?: string
}) {
  const view = React.useMemo(
    () => peerPickerView({ scan, scanning, connections, reachability, devices, now }),
    [scan, scanning, connections, reachability, devices, now]
  )
  // The reverse offer, chosen once for the list: the structured families by
  // default, the terminal tier never — arbitrary shell on THIS machine is a
  // grant nobody ticked by default, in either direction.
  const [reverse, setReverse] = React.useState(true)
  const reverseScopes = DEFAULT_PAIR_SCOPES
  const offerReverse = canOfferReverse && reverse

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-meta text-[color:var(--text-muted)]">
          {intro ?? 'Pick a machine and press Connect. Someone at it types the code you are shown and chooses what you may do.'}
        </p>
        <OutlineButton size="xs" onClick={onScan} disabled={scanning}>
          {scanning ? 'Scanning' : 'Scan'}
        </OutlineButton>
      </div>
      {canOfferReverse ? (
        <Checkbox
          checked={reverse}
          onChange={setReverse}
          label="Also let that machine drive this device (workspaces, sprints, backlog — not terminals)"
        />
      ) : null}
      {view.emptyMessage ? (
        <p className="text-meta text-[color:var(--text-muted)]">{view.emptyMessage}</p>
      ) : (
        <div className="divide-y divide-[color:var(--bg-selected)]" data-peer-picker>
          {view.rows.map((row) => (
            <div key={row.peer.id} className="flex items-center gap-2 py-2 first:pt-0 last:pb-0" data-peer-state={row.state}>
              <RemoteMachineGlyph className="size-icon-sm shrink-0 text-[color:var(--text-subtle)]" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{row.peer.hostName}</span>
                  <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">{row.peer.address}</span>
                </div>
                <div className="flex items-center gap-1.5 text-micro text-[color:var(--text-subtle)]">
                  <StatusDot tone={row.tone} />
                  <span className="truncate">{row.label}</span>
                </div>
              </div>
              {row.state === 'connectable' ? (
                // The direction is said before the click: pressing Connect on
                // the laptop FROM the Mac mini asks to drive the laptop.
                <Tooltip content={connectDirectionNote(row.peer.hostName, offerReverse)} placement="left">
                  <PrimaryButton
                    size="xs"
                    onClick={() => onConnect(row.endpoint, offerReverse ? reverseScopes : null)}
                    disabled={busy || waitingOn !== null}
                  >
                    Connect
                  </PrimaryButton>
                </Tooltip>
              ) : row.state === 'paired' ? (
                <span className="rounded-[3px] border border-[color:var(--border-default)] px-1 text-micro text-[color:var(--text-muted)]">
                  Paired
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
