import { useCallback, useEffect, useMemo, useState } from 'react'

import { encodeQrCode } from '../../../../shared/qr-code'
import type { TailnetDevice, TailnetPairingOfferView, TailnetRemoteStatus } from '../../../../shared/tailnet'
import type { TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { FOCUS_RING_CLASS, InlineNotice, OutlineButton, PrimaryButton, StatusDot } from '../ui'
import { MetaCell, SettingsSectionTitle, SettingToggle, formatDate } from './SettingsAtoms'
import {
  deviceSummary,
  outstandingPairingNote,
  pairingExpiry,
  peerListView,
  peerStatus,
  tailnetReadiness,
} from './tailnetPanelModel'

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
// Everything here is IPC-only (`tailnet:*`). No MCP tool reaches these routes,
// so neither a local agent nor a paired remote device can pair another device
// or widen its own reach; that is a decision of the epic, not an accident of
// this panel.

/** The pairing code's countdown; a code with a minute left should look like it. */
const EXPIRY_TICK_MS = 1000

type ActionState = { tone: 'idle' | 'busy' | 'error'; message: string }

export function RemoteTailnetSettingsTab() {
  const [status, setStatus] = useState<TailnetRemoteStatus | null>(null)
  const [offer, setOffer] = useState<TailnetPairingOfferView | null>(null)
  const [scan, setScan] = useState<TailnetPeerScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [action, setAction] = useState<ActionState>({ tone: 'idle', message: '' })
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async () => {
    setStatus(await window.api.tailnetGetStatus())
  }, [])

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setAction({ tone: 'error', message: describe(error, 'Could not read tailnet remote control.') })
    })
  }, [refresh])

  const outstandingPairing = status?.pairing ?? null

  // Only ticks while a countdown is on screen: an idle panel should not wake
  // once a second for a number nobody is looking at.
  useEffect(() => {
    if (!offer && !outstandingPairing) return undefined
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS)
    return () => clearInterval(timer)
  }, [offer, outstandingPairing])

  const readiness = tailnetReadiness(status)
  const enabled = status?.enabled ?? false
  const busy = action.tone === 'busy'
  const devices = status?.devices ?? []
  const peers = useMemo(() => peerListView(scan, scanning), [scan, scanning])

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
      <div className="space-y-1 border-b border-[color:var(--border-subtle)] pb-3.5">
        <div className="flex items-center gap-1.5">
          {/* No `label`: the dot sits beside text saying the same thing, which
              is exactly when the primitive asks to stay decorative. */}
          <StatusDot tone={readiness.tone} />
          <span className="text-body font-medium text-[color:var(--text-strong)]">{readiness.label}</span>
        </div>
        <p className="text-body leading-5 text-[color:var(--text-muted)]">{readiness.detail}</p>
      </div>

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
          label="Allow this Studio to be driven over your tailnet"
          description="Paired devices on your Tailscale network get the same tools a local agent has. The listener binds to your tailnet address only — never to a local network or the internet."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          // Turning it OFF stays available whatever the state; only turning it
          // ON is refused, and only when there is no tailnet to bind to.
          disabled={busy || (!enabled && !readiness.canTurnOn)}
          requirement={readiness.canTurnOn ? undefined : 'Needs Tailscale'}
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
                <OutlineButton size="md" onClick={() => void cancelPairing()} disabled={busy}>
                  Cancel
                </OutlineButton>
              ) : null}
              <PrimaryButton size="md" onClick={() => void offerPairing()} disabled={busy || !readiness.canPair}>
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
            {readiness.canPair
              ? 'Create a code, then scan it from the other machine. The code works once and lapses in 30 days, or when this app restarts.'
              : 'A pairing code points at this listener, so it can only be created while the listener is running.'}
          </p>
        )}
      </section>

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
                  <div className="truncate text-body font-medium text-[color:var(--text-strong)]">{device.name}</div>
                  <div className="mt-0.5 text-meta text-[color:var(--text-muted)]">
                    {deviceSummary(device, formatDate)}
                  </div>
                </div>
                <OutlineButton
                  size="md"
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
          <p className="text-body leading-5 text-[color:var(--text-muted)]">
            No devices are paired. Nothing can drive this Studio remotely.
          </p>
        )}
      </section>

      <section>
        <SettingsSectionTitle
          className="mb-1.5"
          count={peers.peers.length > 0 ? peers.peers.length : undefined}
          action={
            <OutlineButton size="md" onClick={() => void scanPeers()} disabled={scanning}>
              {scanning ? 'Scanning' : 'Scan'}
            </OutlineButton>
          }
        >
          Machines on your tailnet
        </SettingsSectionTitle>
        {peers.emptyMessage ? (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">{peers.emptyMessage}</p>
        ) : (
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {peers.peers.map((peer) => {
              const state = peerStatus(peer, scan?.probedPort ?? 0)
              return (
                <div key={peer.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-center gap-1.5">
                    <StatusDot tone={state.tone} />
                    <span className="truncate text-body font-medium text-[color:var(--text-strong)]">
                      {peer.hostName}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]">
                    <span>{state.label}</span>
                    <span className="font-mono">{peer.address}</span>
                    {peer.os ? <span>{peer.os}</span> : null}
                  </div>
                </div>
              )
            })}
          </div>
        )}
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
            {url
              ? 'This pairing code is too long to draw as a square. Copy the link instead.'
              : 'The listener is not running, so there is nothing for a code to point at.'}
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
