import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  FleetBrowse,
  FleetConnection,
  FleetPairRequestView,
  FleetRun,
  FleetWorkspace,
} from '../../../../shared/tailnet-fleet'
import type { TailnetPeerScan } from '../../../../shared/tailnet-peers'
import { addFleetTerminalTab } from '../../utils/modelRegistry'
import { EmptyState, GhostButton, InlineNotice, OutlineButton, PanelHeader, PrimaryButton, StatusDot, Input } from '../ui'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import {
  fleetBrowseView,
  fleetConnectionSummary,
  fleetPeerListView,
  pendingPairRequestNote,
  fleetTerminalStatus,
  fleetTerminalTabName,
  fleetTerminalTitle,
} from './fleet/fleetModel'

// The Fleet: another machine's Studio, browsed from this one (MC-2167).
//
// One machine at a time, opened deliberately. A tailnet of ten machines is not
// ten machines to poll — every browse is an authenticated round trip to a real
// computer that may be asleep, so this asks when a person asks and not before.
//
// The terminals here open as panes in THIS workspace's layout, which is the
// whole point: they drag, stack, and split like local ones, and they carry the
// machine's name so nobody types into the wrong computer.

interface Props {
  workspaceId: string
}

type ActionState = { tone: 'idle' | 'busy' | 'error'; message: string }

/**
 * How often a waiting request asks the other machine for an answer.
 *
 * Slow on purpose: the thing being waited on is a person walking to a computer,
 * and every poll is an authenticated round trip to a real machine.
 */
const PAIR_POLL_MS = 2000

export default function FleetPanel({ workspaceId }: Props) {
  const [connections, setConnections] = useState<FleetConnection[]>([])
  const [openConnectionId, setOpenConnectionId] = useState<string | null>(null)
  const [browse, setBrowse] = useState<FleetBrowse | null>(null)
  const [browsing, setBrowsing] = useState(false)
  const [runsByWorkspace, setRunsByWorkspace] = useState<Record<string, FleetRun[] | { error: string }>>({})
  const [pairingLink, setPairingLink] = useState('')
  const [adding, setAdding] = useState(false)
  // The machine picker (MC-2233). Discovery is a read of the local Tailscale
  // daemon plus a health probe, so it is safe to run whenever a person asks —
  // but it is never run unasked, for the same reason a browse is not.
  const [scan, setScan] = useState<TailnetPeerScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [pendingRequest, setPendingRequest] = useState<FleetPairRequestView | null>(null)
  const [requestNow, setRequestNow] = useState(() => Date.now())
  const [action, setAction] = useState<ActionState>({ tone: 'idle', message: '' })

  // The newest fleet revision applied; an older broadcast (or one replayed
  // out of order) must not trigger a re-read that lands stale.
  const fleetRevision = useRef(0)
  const refreshConnections = useCallback(async () => {
    setConnections(await window.api.fleetListConnections())
  }, [])

  // Live updates (remote-sessions-ux): a machine paired or forgotten from any
  // other surface (another window, the Remote popover) re-reads the list here
  // without anyone pressing anything. Attachment link-state events are the
  // panes' own; the list they would change is re-read on browse.
  useEffect(() => {
    // Tolerant of a host without the push bridge (partial test harnesses,
    // narrower aux-window preloads): the panel then simply stays fetch-based.
    if (typeof window.api.onFleetEvent !== 'function') return
    return window.api.onFleetEvent((event) => {
      if (event.revision < fleetRevision.current) return
      fleetRevision.current = event.revision
      if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') {
        void refreshConnections().catch(() => {})
      }
    })
  }, [refreshConnections])

  useEffect(() => {
    void refreshConnections().catch((error: unknown) => {
      setAction({ tone: 'error', message: describe(error, 'Could not read your paired machines.') })
    })
  }, [refreshConnections])

  const loadBrowse = useCallback(async (connectionId: string) => {
    setBrowsing(true)
    setRunsByWorkspace({})
    try {
      setBrowse(await window.api.fleetBrowse(connectionId))
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Could not read that machine.') })
    } finally {
      setBrowsing(false)
    }
  }, [])

  const open = async (connection: FleetConnection): Promise<void> => {
    if (openConnectionId === connection.id) {
      setOpenConnectionId(null)
      setBrowse(null)
      return
    }
    setOpenConnectionId(connection.id)
    setBrowse(null)
    await loadBrowse(connection.id)
  }

  const pair = async (): Promise<void> => {
    const link = pairingLink.trim()
    if (!link) return
    setAction({ tone: 'busy', message: 'Pairing with that machine.' })
    try {
      const result = await window.api.fleetPair(link)
      if (!result.ok) {
        setAction({ tone: 'error', message: result.message })
        return
      }
      setPairingLink('')
      setAdding(false)
      setAction({ tone: 'idle', message: `Paired with ${result.connection.machineName}.` })
      await refreshConnections()
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Pairing did not work.') })
    }
  }

  const scanPeers = async (): Promise<void> => {
    setScanning(true)
    setAction({ tone: 'busy', message: 'Looking for machines on your tailnet.' })
    try {
      setScan(await window.api.tailnetListPeers())
      setAction({ tone: 'idle', message: '' })
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Could not read your tailnet.') })
    } finally {
      setScanning(false)
    }
  }

  const requestPairing = async (endpoint: string): Promise<void> => {
    setAction({ tone: 'busy', message: 'Asking that machine to pair.' })
    try {
      const result = await window.api.fleetRequestPairing(endpoint)
      if (!result.ok) {
        setAction({ tone: 'error', message: result.message })
        return
      }
      setPendingRequest(result.request)
      setRequestNow(Date.now())
      setAction({ tone: 'idle', message: '' })
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Could not ask that machine.') })
    }
  }

  const cancelRequest = async (): Promise<void> => {
    const request = pendingRequest
    setPendingRequest(null)
    if (request) await window.api.fleetCancelPairing(request.requestId).catch(() => {})
  }

  // Poll only while a request is actually waiting, and stop the moment it is
  // answered. A machine that has gone to sleep answers `ok: false`, which keeps
  // the wait alive rather than ending it — a closed lid is not a refusal.
  useEffect(() => {
    if (!pendingRequest) return
    let cancelled = false
    const timer = setInterval(() => {
      setRequestNow(Date.now())
      void (async () => {
        const result = await window.api.fleetCollectPairing(pendingRequest.requestId).catch(() => null)
        if (cancelled || !result || !result.ok) return
        if (result.status === 'pending') return
        setPendingRequest(null)
        if (result.status === 'approved') {
          setAction({ tone: 'idle', message: `Paired with ${result.connection.machineName}.` })
          await refreshConnections()
          setScan(null)
          return
        }
        setAction({
          tone: 'error',
          message:
            result.status === 'denied'
              ? 'That machine declined the request.'
              : 'The request lapsed before anyone answered it.',
        })
      })()
    }, PAIR_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pendingRequest, refreshConnections])

  const peerList = useMemo(
    () => fleetPeerListView(scan, connections, scanning),
    [scan, connections, scanning]
  )

  const forget = async (connection: FleetConnection): Promise<void> => {
    setAction({ tone: 'busy', message: `Removing ${connection.machineName}.` })
    try {
      setConnections(await window.api.fleetForget(connection.id))
      if (openConnectionId === connection.id) {
        setOpenConnectionId(null)
        setBrowse(null)
      }
      setAction({
        tone: 'idle',
        // Half the job is on the other machine, and only a person there can do
        // it. Saying so is the difference between "removed" and "revoked".
        message: `${connection.machineName} removed here. Revoke "${connection.deviceName}" in that machine's Remote settings to end the grant.`,
      })
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Could not remove that machine.') })
    }
  }

  const openTerminal = (connection: FleetConnection, sessionId: string, title: string): void => {
    const opened = addFleetTerminalTab(workspaceId, {
      connectionId: connection.id,
      machineName: connection.machineName,
      remoteSessionId: sessionId,
      name: fleetTerminalTabName(connection.machineName, title),
    })
    if (!opened) {
      setAction({ tone: 'error', message: 'This workspace has no layout to open the terminal in.' })
    }
  }

  const createTerminal = async (connection: FleetConnection, workspace: FleetWorkspace): Promise<void> => {
    setAction({ tone: 'busy', message: `Opening a terminal on ${connection.machineName}.` })
    try {
      const created = await window.api.fleetCreateTerminal({
        connectionId: connection.id,
        workspaceId: workspace.id,
      })
      if (!created.ok) {
        setAction({ tone: 'error', message: created.message })
        return
      }
      setAction({ tone: 'idle', message: '' })
      openTerminal(connection, created.sessionId, created.title)
      // The new session belongs in the list the person is looking at.
      await loadBrowse(connection.id)
    } catch (error) {
      setAction({ tone: 'error', message: describe(error, 'Could not open a terminal there.') })
    }
  }

  const loadRuns = async (connection: FleetConnection, workspace: FleetWorkspace): Promise<void> => {
    if (runsByWorkspace[workspace.id]) return
    const answer = await window.api.fleetListRuns(connection.id, workspace.id).catch(
      (error: unknown): { ok: false; code: string; message: string } => ({
        ok: false,
        code: 'failed',
        message: describe(error, 'Could not read that workspace\'s runs.'),
      })
    )
    setRunsByWorkspace((current) => ({
      ...current,
      [workspace.id]: answer.ok ? answer.runs : { error: answer.message },
    }))
  }

  const view = useMemo(() => fleetBrowseView(browse, browsing), [browse, browsing])

  return (
    <div className="flex h-full flex-col bg-[color:var(--bg-app)]">
      <PanelHeader
        title="Fleet"
        primaryAction={
          <GhostButton size="md" onClick={() => setAdding((current) => !current)}>
            {adding ? 'Cancel' : 'Add machine'}
          </GhostButton>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {action.tone === 'error' ? (
          <InlineNotice tone="error" className="mb-2">
            {action.message}
          </InlineNotice>
        ) : action.message ? (
          <p aria-live="polite" className="mb-2 text-meta text-[color:var(--text-muted)]">
            {action.message}
          </p>
        ) : null}

        {pendingRequest ? (
          <div className="mb-3 space-y-2 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-body font-medium text-[color:var(--text-strong)]">
                  {pendingRequest.machineName}
                </div>
                <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">
                  {pendingPairRequestNote(pendingRequest, requestNow)}
                </p>
              </div>
              {/* The same six digits are on the other machine. Comparing them is
                  what makes approving safe without a secret being carried. */}
              <div className="text-right">
                <div className="text-micro text-[color:var(--text-muted)]">Code</div>
                <div className="font-mono text-heading tracking-wide text-[color:var(--text-strong)]">
                  {pendingRequest.comparisonCode}
                </div>
              </div>
            </div>
            <OutlineButton size="xs" onClick={() => void cancelRequest()}>
              Stop waiting
            </OutlineButton>
          </div>
        ) : null}

        {adding && !pendingRequest ? (
          <div className="mb-3 space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] p-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-meta text-[color:var(--text-muted)]">
                  Pick a machine and ask. Someone at it allows the request and chooses what you may do.
                </p>
                <OutlineButton size="xs" onClick={() => void scanPeers()} disabled={scanning}>
                  {scanning ? 'Scanning' : 'Scan'}
                </OutlineButton>
              </div>
              {peerList.emptyMessage ? (
                <p className="text-meta text-[color:var(--text-muted)]">{peerList.emptyMessage}</p>
              ) : (
                <div className="divide-y divide-[color:var(--bg-selected)]">
                  {peerList.peers.map((peer) => (
                    <div key={peer.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <div className="truncate text-body text-[color:var(--text-strong)]">{peer.hostName}</div>
                        <div className="font-mono text-micro text-[color:var(--text-muted)]">{peer.address}</div>
                      </div>
                      <PrimaryButton
                        size="xs"
                        onClick={() => void requestPairing(`${peer.address}:${scan?.probedPort ?? 0}`)}
                        disabled={action.tone === 'busy'}
                      >
                        Ask to pair
                      </PrimaryButton>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* The carried code stays: a machine with nobody in front of it
                cannot approve anything, which is the normal case for a server. */}
            <details className="border-t border-[color:var(--border-subtle)] pt-2">
              <summary className={`cursor-pointer text-meta text-[color:var(--text-muted)] ${FOCUS_RING_CLASS}`}>
                Nobody at that machine? Paste a pairing link instead
              </summary>
              <div className="mt-2 space-y-2">
                <Input
                  value={pairingLink}
                  onChange={(event) => setPairingLink(event.target.value)}
                  placeholder="multicode-tailnet://pair?…"
                  aria-label="Pairing link"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void pair()
                  }}
                />
                <PrimaryButton
                  size="md"
                  onClick={() => void pair()}
                  disabled={!pairingLink.trim() || action.tone === 'busy'}
                >
                  Pair
                </PrimaryButton>
              </div>
            </details>
          </div>
        ) : null}

        {connections.length === 0 ? (
          <EmptyState
            title="No machines on this account"
            body="Sign in on another desktop and its workspaces and terminals appear here."
          />
        ) : (
          <div className="space-y-1">
            {connections.map((connection) => {
              const isOpen = connection.id === openConnectionId
              return (
                <div
                  key={connection.id}
                  className="rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => void open(connection)}
                      className={`min-w-0 flex-1 text-left ${FOCUS_RING_CLASS}`}
                      aria-expanded={isOpen}
                    >
                      <div className="truncate text-body font-medium text-[color:var(--text-strong)]">
                        {connection.machineName}
                      </div>
                      <div className="truncate text-meta text-[color:var(--text-muted)]">
                        {fleetConnectionSummary(connection, formatWhen)}
                      </div>
                    </button>
                    {isOpen ? (
                      <OutlineButton size="md" onClick={() => void loadBrowse(connection.id)} disabled={browsing}>
                        {browsing ? 'Reading' : 'Refresh'}
                      </OutlineButton>
                    ) : null}
                    <OutlineButton size="md" tone="danger" onClick={() => void forget(connection)}>
                      Remove
                    </OutlineButton>
                  </div>

                  {isOpen ? (
                    <div className="border-t border-[color:var(--border-subtle)] px-3 py-2">
                      {view.emptyMessage ? (
                        <div className="space-y-2">
                          <p className="text-meta leading-5 text-[color:var(--text-muted)]">{view.emptyMessage}</p>
                          {view.needsRepair ? (
                            <p className="text-meta leading-5 text-[color:var(--text-muted)]">
                              Remove it here and pair again with a fresh code from that machine.
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {view.gapMessages.map((gap) => (
                            <p key={gap} className="text-meta leading-5 text-[color:var(--text-muted)]">
                              {gap}
                            </p>
                          ))}

                          {view.terminals.length > 0 ? (
                            <section>
                              <h3 className="mb-1 text-meta font-medium text-[color:var(--text-strong)]">Terminals</h3>
                              <div className="divide-y divide-[color:var(--bg-selected)]">
                                {view.terminals.map((terminal) => {
                                  const status = fleetTerminalStatus(terminal)
                                  return (
                                    <div key={terminal.sessionId} className="flex items-center gap-2 py-1.5">
                                      <StatusDot tone={status.tone} />
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-meta text-[color:var(--text-default)]">
                                          {fleetTerminalTitle(terminal)}
                                        </div>
                                        <div className="truncate text-meta text-[color:var(--text-muted)]">
                                          {status.label}
                                          {terminal.cwd ? ` · ${terminal.cwd}` : ''}
                                        </div>
                                      </div>
                                      <GhostButton
                                        size="md"
                                        onClick={() =>
                                          openTerminal(connection, terminal.sessionId, fleetTerminalTitle(terminal))
                                        }
                                      >
                                        Open
                                      </GhostButton>
                                    </div>
                                  )
                                })}
                              </div>
                            </section>
                          ) : null}

                          {view.workspaces.length > 0 ? (
                            <section>
                              <h3 className="mb-1 text-meta font-medium text-[color:var(--text-strong)]">Workspaces</h3>
                              <div className="divide-y divide-[color:var(--bg-selected)]">
                                {view.workspaces.map((workspace) => (
                                  <RemoteWorkspaceRow
                                    key={workspace.id}
                                    workspace={workspace}
                                    runs={runsByWorkspace[workspace.id]}
                                    canOpenTerminal={browse?.terminalAccess === 'control'}
                                    onLoadRuns={() => void loadRuns(connection, workspace)}
                                    onNewTerminal={() => void createTerminal(connection, workspace)}
                                  />
                                ))}
                              </div>
                            </section>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** One remote workspace: its runs on demand, and a terminal on it when the grant allows one. */
function RemoteWorkspaceRow({
  workspace,
  runs,
  canOpenTerminal,
  onLoadRuns,
  onNewTerminal,
}: {
  workspace: FleetWorkspace
  runs: FleetRun[] | { error: string } | undefined
  canOpenTerminal: boolean
  onLoadRuns: () => void
  onNewTerminal: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`min-w-0 flex-1 text-left ${FOCUS_RING_CLASS}`}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((current) => !current)
            if (!expanded) onLoadRuns()
          }}
        >
          <div className="truncate text-meta text-[color:var(--text-default)]">{workspace.name}</div>
          {workspace.folderPath ? (
            <div className="truncate text-meta text-[color:var(--text-muted)]">{workspace.folderPath}</div>
          ) : null}
        </button>
        {canOpenTerminal ? (
          <GhostButton size="md" onClick={onNewTerminal}>
            New terminal
          </GhostButton>
        ) : null}
      </div>
      {expanded ? (
        <div className="mt-1 pl-3">
          {runs === undefined ? (
            <p className="text-meta text-[color:var(--text-muted)]">Reading runs.</p>
          ) : Array.isArray(runs) ? (
            runs.length > 0 ? (
              <ul className="space-y-0.5">
                {runs.map((run) => (
                  <li key={run.statePath || run.slug} className="truncate text-meta text-[color:var(--text-muted)]">
                    {run.slug}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-meta text-[color:var(--text-muted)]">No sprint runs in this workspace.</p>
            )
          ) : (
            <p className="text-meta text-[color:var(--text-muted)]">{runs.error}</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

function formatWhen(value: string): string {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
