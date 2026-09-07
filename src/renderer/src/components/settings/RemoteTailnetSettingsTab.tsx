import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { encodeQrCode } from '../../../../shared/qr-code'
import {
  type TailnetDevice,
  type TailnetPairingOfferView,
  type TailnetRemoteStatus,
  type TailnetScope,
} from '../../../../shared/tailnet'
import type { TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { FOCUS_RING_CLASS, InlineNotice, Input, OutlineButton, PrimaryButton, StatusDot } from '../ui'
import { MetaCell, SettingsPageHeader, SettingsSectionTitle, SettingToggle, formatDate } from './SettingsAtoms'
import { deviceSummary, outstandingPairingNote, pairingExpiry, tailnetReadiness } from './tailnetPanelModel'
import { PeerPicker } from '../remote/PeerPicker'
import { PairRequestCard } from '../remote/PairRequestCard'
import { OutboundPairRequestCard } from '../remote/OutboundPairRequestCard'
import { useTailnetPresence } from '../workspace/topbar/useTailnetPresence'

// Settings → Remote: tailnet remote control, both directions.
//
// Downward (who may drive this machine): whether Tailscale is up, where the
// listener is reachable, the one-time pairing code as a scannable square, and
// the paired devices with revoke.
//
// Outward (what this machine can drive): the tailnet's other machines, and
// which of them answer as a Studio — so connecting is picking a name off a
// list rather than typing an address.
//
// Everything here is IPC-only (`tailnet:*`). The matching `tailnet.*` gateway
// tools let an agent ON THIS MACHINE drive the same service over the local
// socket, so the two surfaces cannot answer differently — but that family is
// refused over the tailnet itself, so no paired remote device can pair another
// device or widen its own reach. That is a decision of the epic, not an
// accident of this panel.

/** The pairing code's countdown; a code with a minute left should look like it. */
const EXPIRY_TICK_MS = 1000

type ActionState = { tone: 'idle' | 'busy' | 'error'; message: string }

export function RemoteTailnetSettingsTab() {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [offer, setOffer] = useState<TailnetPairingOfferView | null>(null)
  const [scan, setScan] = useState<TailnetPeerScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  // A pairing link carried from a machine nobody is sitting at (the Fleet
  // panel's fallback, moved here when that panel was retired).
  const [pairingLink, setPairingLink] = useState('')
  const [action, setAction] = useState<ActionState>({ tone: 'idle', message: '' })
  const [now, setNow] = useState(() => Date.now())
  // The newest pushed revision applied, so a read that resolves after a push
  // (the mount race) cannot roll the tab back to what main knew a moment ago.
  const appliedRevision = useRef(0)

  const refresh = useCallback(async () => {
    const before = appliedRevision.current
    const read = await window.api.tailnetGetStatus()
    if (appliedRevision.current === before) setStatus(read)
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setAction({ tone: 'error', message: describe(error, 'Could not read tailnet remote control.') })
    })
  }, [refresh])

  // Live updates (remote-sessions-ux): every pushed payload carries fresh
  // status, so a pair request arriving — or being answered from any other
  // surface — lands here without a refetch. The fetch-on-mount above stays the
  // initial read; this keeps it true afterwards.
  useEffect(() => {
    // Tolerant of a host without the push bridge: the tab then stays
    // fetch-on-action, exactly as it was before the channel existed.
    if (typeof window.api.onTailnetEvent !== 'function') return
    return window.api.onTailnetEvent((payload) => {
      if (payload.revision < appliedRevision.current) return
      appliedRevision.current = payload.revision
      setStatus(payload.status)
      // The local offer holds the one-time CODE (main never re-serves it),
      // but the pairing's existence is main's fact: cancelled or replaced
      // from any other surface, a dead QR must not stay on screen.
      setOffer((current) =>
        current && payload.status.pairing?.expiresAt === current.expiresAt ? current : null
      )
    })
  }, [])

  const outstandingPairing = status?.pairing ?? null
  const pendingRequestCount = status?.pairRequests.length ?? 0
  // The outward half — machines this Studio drives, requests it has made,
  // whether each paired machine answers — from the same pushed presence the
  // Remote glyph reads, so this tab and the popover cannot disagree.
  const presence = useTailnetPresence()
  const askingCount = presence.fleetRequests.length

  // Only ticks while a countdown is on screen — an outbound offer, a request
  // whose Allow must go dead the second it lapses, or one this machine is
  // waiting on: an idle panel should not wake once a second for a number
  // nobody is looking at.
  useEffect(() => {
    if (!offer && !outstandingPairing && pendingRequestCount === 0 && askingCount === 0) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS)
    return () => clearInterval(timer)
  }, [offer, outstandingPairing, pendingRequestCount, askingCount])

  const readiness = tailnetReadiness(status)
  const enabled = status?.enabled ?? false
  const busy = action.tone === 'busy'
  const devices = status?.devices ?? []
  const pairRequests = status?.pairRequests ?? []

  const run = async (message: string, work: () => Promise<void>): Promise<void> => {
    setAction({ tone: 'busy', message })
    try {
      await work()
      setAction({ tone: 'idle', message: '' })
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'That did not work.') })
    }
  }

  const toggleEnabled = (next: boolean): Promise<void> =>
    run(next ? 'Starting the listener.' : 'Stopping the listener.', async () => {
      setStatus(await window.api.tailnetSetEnabled(next))
      // Turning it off drops any outstanding pairing in the main process; the
      // panel must not keep showing a code that no longer works.
      if (!next) setOffer(null)
    })

  const offerPairing = (): Promise<void> =>
    run('Creating a pairing code.', async () => {
      const next = await window.api.tailnetOfferPairing()
      setOffer(next)
      setNow(Date.now())
      await refresh()
    })

  const cancelPairing = (): Promise<void> =>
    run('Cancelling the pairing code.', async () => {
      setStatus(await window.api.tailnetCancelPairing())
      setOffer(null)
    })

  const revokeDevice = async (device: TailnetDevice): Promise<void> => {
    setRevokingDeviceId(device.id)
    try {
      await run(`Revoking ${device.name}.`, async () => {
        setStatus(await window.api.tailnetRevokeDevice(device.id))
      })
    } finally {
      setRevokingDeviceId(null)
    }
  }

  const scanPeers = async (): Promise<void> => {
    setScanning(true)
    try {
      await run('Looking for machines on your tailnet.', async () => {
        setScan(await window.api.tailnetListPeers())
      })
    } finally {
      setScanning(false)
    }
  }

  // Connect (pair-from-the-scan-and-stay-paired, phase 1): ask the machine,
  // and let main own the wait. The waiting card below, and the one in the
  // Remote popover, show the code the moment the ask is accepted.
  const connect = (endpoint: string, reverseScopes: TailnetScope[] | null): Promise<void> =>
    run('Asking that machine to pair.', async () => {
      const result = await window.api.fleetRequestPairing(endpoint, reverseScopes ? { reverseScopes } : undefined)
      if (!result.ok) {
        setAction({ tone: 'error', message: result.message })
        return
      }
    })

  // Pair by a carried link: the possession-based path for a machine with
  // nobody in front of it to approve a request — a server, a headless box.
  const pairByLink = (): Promise<void> => {
    const link = pairingLink.trim()
    if (!link) return Promise.resolve()
    return run('Pairing with that machine.', async () => {
      const result = await window.api.fleetPair(link)
      if (!result.ok) {
        setAction({ tone: 'error', message: result.message })
        return
      }
      setPairingLink('')
      setAction({ tone: 'idle', message: `Paired with ${result.connection.machineName}.` })
    })
  }

  const toggleNotifications = (next: boolean): Promise<void> =>
    run(next ? 'Turning notifications on.' : 'Turning notifications off.', async () => {
      setStatus(await window.api.tailnetSetNotifications(next))
    })

  const copy = async (value: string, label: string): Promise<void> => {
    try {
      await window.api.clipboardWriteText(value)
      setAction({ tone: 'idle', message: `${label} copied.` })
    } catch {
      setAction({ tone: 'error', message: `Could not copy the ${label.toLowerCase()}.` })
    }
  }

  return (
    <div role="tabpanel" id="settings-panel-remote" aria-labelledby="settings-tab-remote" className="space-y-5">
      {/* The listener's state is the page's fact, on the header band. No
          `label` on the dot: it sits beside text saying the same thing, which
          is exactly when the primitive asks to stay decorative. */}
      <SettingsPageHeader
        title="Remote"
        meta={
          <span className="inline-flex items-center gap-1.5">
            <StatusDot tone={readiness.tone} />
            {readiness.label}
          </span>
        }
      />

      {action.tone === 'error' ? (
        <InlineNotice tone="error">{action.message}</InlineNotice>
      ) : action.message ? (
        // Confirmations ("Pairing link copied.") need somewhere to land, or the
        // control that produced them looks like it did nothing. aria-live so the
        // acknowledgement reaches a screen reader too.
        <p aria-live="polite" className="text-body leading-5 text-[color:var(--text-muted)]">
          {action.message}
        </p>
      ) : null}

      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingToggle
          label="Remote control over your tailnet"
          description="Paired devices get the same tools a local agent has."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          // Turning it OFF stays available whatever the state; only turning it
          // ON is refused, and only when there is no tailnet to bind to.
          disabled={busy || (!enabled && !readiness.canTurnOn)}
          requirement={readiness.canTurnOn ? undefined : 'Needs Tailscale'}
        />
        <SettingToggle
          label="Pairing notifications"
          description="When a machine asks to pair, answers, or revokes."
          enabled={status?.notifications ?? true}
          onChange={(next) => void toggleNotifications(next)}
          disabled={busy || !status}
        />
      </div>

      <section>
        <SettingsSectionTitle className="mb-1.5">This machine</SettingsSectionTitle>
        <div className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-2">
          <MetaCell
            label="Tailnet address"
            value={status?.tailnetAddress ?? 'Not on a tailnet'}
            tone={status?.tailnetAddress ? undefined : 'muted'}
          />
          <MetaCell
            label="Listening on"
            value={status?.endpoint ?? 'Not listening'}
            tone={status?.endpoint ? 'positive' : 'muted'}
          />
          <MetaCell label="Port" value={String(status?.port ?? '—')} />
        </div>
      </section>

      <section>
        <SettingsSectionTitle
          className="mb-1.5"
          action={
            <div className="flex items-center gap-2">
              {offer || outstandingPairing ? (
                <OutlineButton size="xs" onClick={() => void cancelPairing()} disabled={busy}>
                  Cancel
                </OutlineButton>
              ) : null}
              <PrimaryButton size="xs" onClick={() => void offerPairing()} disabled={busy || !readiness.canPair}>
                {offer || outstandingPairing ? 'New code' : 'Pair a device'}
              </PrimaryButton>
            </div>
          }
        >
          Pairing
        </SettingsSectionTitle>
        {offer ? (
          <PairingOffer offer={offer} now={now} onCopy={(value, label) => void copy(value, label)} />
        ) : outstandingPairing ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {outstandingPairingNote(outstandingPairing, now)}
          </p>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {readiness.canPair ? 'Scan the code from the other machine. It works once.' : 'Start the listener first.'}
          </p>
        )}
      </section>

      {pairRequests.length > 0 ? (
        <section>
          <SettingsSectionTitle className="mb-1.5" count={pairRequests.length}>
            Waiting to be answered
          </SettingsSectionTitle>
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {pairRequests.map((request) => (
              <PairRequestCard key={request.id} request={request} now={now} variant="flush" />
            ))}
          </div>
        </section>
      ) : null}

      {presence.fleetRequests.length > 0 ? (
        <section>
          <SettingsSectionTitle className="mb-1.5" count={presence.fleetRequests.length}>
            Asking
          </SettingsSectionTitle>
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {presence.fleetRequests.map((request) => (
              <OutboundPairRequestCard key={request.requestId} request={request} now={now} variant="flush" />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SettingsSectionTitle className="mb-1.5" count={devices.length}>
          Paired devices
        </SettingsSectionTitle>
        {devices.length > 0 ? (
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {devices.map((device) => (
              <div
                key={device.id}
                className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-body font-medium text-[color:var(--text-strong)]">{device.name}</span>
                    {device.origin.kind === 'agent' ? (
                      <span className="shrink-0 rounded-[3px] border border-[color:var(--border-default)] px-1 text-micro text-[color:var(--text-muted)]">
                        agent-minted
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 text-meta text-[color:var(--text-muted)]">
                    {deviceSummary(device, formatDate)}
                  </div>
                </div>
                <OutlineButton
                  size="xs"
                  tone="danger"
                  onClick={() => void revokeDevice(device)}
                  disabled={revokingDeviceId === device.id}
                  className="justify-self-start sm:justify-self-end"
                >
                  {revokingDeviceId === device.id ? 'Revoking' : 'Revoke'}
                </OutlineButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">No devices paired.</p>
        )}
      </section>

      <section>
        <SettingsSectionTitle className="mb-1.5">Machines on your tailnet</SettingsSectionTitle>
        <PeerPicker
          intro="Connect to another Studio."
          scan={scan}
          scanning={scanning}
          connections={presence.fleet}
          reachability={presence.fleetReachability}
          devices={status?.devices ?? []}
          now={now}
          onScan={() => void scanPeers()}
          onConnect={(endpoint, reverseScopes) => void connect(endpoint, reverseScopes)}
          canOfferReverse={readiness.state === 'listening'}
          busy={busy}
          waitingOn={presence.fleetRequests[0]?.machineName ?? null}
        />
        {/* The carried code stays: a machine with nobody in front of it
            cannot approve anything, which is the normal case for a server. */}
        <details className="mt-3 border-t border-[color:var(--border-subtle)] pt-2">
          <summary className={`cursor-pointer text-meta text-[color:var(--text-muted)] ${FOCUS_RING_CLASS}`}>
            Paste a pairing link instead
          </summary>
          <div className="mt-2 flex items-center gap-2">
            <Input
              value={pairingLink}
              onChange={(event) => setPairingLink(event.target.value)}
              placeholder="multicode-tailnet://pair?…"
              aria-label="Pairing link"
              onKeyDown={(event) => {
                if (event.key === 'Enter') void pairByLink()
              }}
            />
            <PrimaryButton size="md" onClick={() => void pairByLink()} disabled={!pairingLink.trim() || busy}>
              Pair
            </PrimaryButton>
          </div>
        </details>
      </section>
    </div>
  )
}

/**
 * One pairing code, as a square and as text.
 *
 * Both forms carry the same string. The square is for the common case — point
 * the other machine's camera at it — and the text is for every case the camera
 * cannot cover: a headless box, a remote session, a screen reader.
 */
function PairingOffer({
  offer,
  now,
  onCopy,
}: {
  offer: TailnetPairingOfferView
  now: number
  onCopy: (value: string, label: string) => void
}) {
  const url = offer.pairingUrl
  const matrix = useMemo(() => (url ? encodeQrCode(url) : null), [url])

  return (
    <div className="mt-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-4 py-3">
      <div className="flex flex-wrap items-start gap-4">
        {matrix ? (
          <QrSquare matrix={matrix} label="Pairing code" />
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            {/* Explicit rather than a blank space where a square should be. */}
            {url ? 'Too long to draw. Copy the link instead.' : 'The listener is not running.'}
          </p>
        )}
        <div className="min-w-0 flex-1 space-y-2">
          {url ? (
            <button
              type="button"
              onClick={() => onCopy(url, 'Pairing link')}
              className={`block w-full break-all text-left font-mono text-meta text-[color:var(--text-default)] transition-colors hover:text-[color:var(--accent-primary)] ${FOCUS_RING_CLASS}`}
              aria-label="Copy the pairing link"
            >
              {url}
            </button>
          ) : null}
          <div className="text-meta text-[color:var(--text-muted)]">
            {pairingExpiry(offer.expiresAt, now)} · works once · grants {offer.scopes.length} scopes
          </div>
          <div className="text-meta text-[color:var(--text-muted)]">{offer.scopes.join(', ')}</div>
        </div>
      </div>
    </div>
  )
}

/**
 * The symbol, drawn as one SVG path.
 *
 * The colours are literal black on white rather than theme tokens, and stay
 * that way in dark mode. A QR code is a machine-readable target before it is a
 * graphic: contrast and polarity are what make it scan, and a themed square on
 * a dark surface is a square a camera may refuse. The quiet zone is part of the
 * format, not padding we chose.
 */
function QrSquare({ matrix, label }: { matrix: { size: number; modules: boolean[][] }; label: string }) {
  const QUIET_ZONE = 4
  const extent = matrix.size + QUIET_ZONE * 2
  const path = useMemo(() => {
    const segments: string[] = []
    for (let y = 0; y < matrix.size; y++) {
      for (let x = 0; x < matrix.size; x++) {
        if (matrix.modules[y][x]) segments.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`)
      }
    }
    return segments.join('')
  }, [matrix])

  return (
    <svg
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label={label}
      className="h-40 w-40 shrink-0 rounded-sm"
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" /> {/* design-tokens-allow: QR polarity is functional — a camera reads dark-on-light, so this square must not follow the theme */}
      <path d={path} fill="#000000" /> {/* design-tokens-allow: see above — themed modules on a dark surface are a square a scanner may refuse */}
    </svg>
  )
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
