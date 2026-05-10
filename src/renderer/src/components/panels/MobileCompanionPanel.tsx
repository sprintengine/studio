import React, { useEffect, useMemo, useState } from 'react'

type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'

type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'sprintengines.create'
  | 'tasks.start'
  | 'artifacts.review'
  | 'agents.followUp'
  | 'devices.revoke'

type MobileControlDevice = {
  protocolVersion: 1
  deviceId: string
  displayName: string
  platform: 'ios' | 'android' | 'web'
  appVersion: string
  pairedAt: string
  lastSeenAt?: string
  revokedAt?: string
  capabilities: MobileControlCapability[]
}

type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

type MobileBridgePresence = 'available' | 'busy' | 'idle' | 'offline'

type MobileBridgeDiagnosticEntry = {
  id: string
  timestamp: string
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  retryable: boolean
}

type MobileBridgeCommandEvent = {
  id: string
  commandId: string
  commandType: MobileControlCommandType
  deviceId: string | null
  deviceName: string | null
  receivedAt: string
  completedAt?: string
  status: 'received' | 'completed' | 'failed'
  resultCode?: string
}

type MobileBridgePairingChallenge = {
  pairingChallengeId: string
  pairingCode: string
  pairingUri: string
  expiresAt: string
  requestedScopes: MobileControlCapability[]
}

type MobileBridgeState = {
  enabled: boolean
  relayStatus: MobileBridgeRelayStatus
  relayUrl: string | null
  desktopInstanceId: string
  desktopRelaySessionId: string | null
  relayTokenExpiresAt: string | null
  nextReconnectAt: string | null
  presence: MobileBridgePresence
  lastPresenceAt: string | null
  pairingChallenge: Omit<MobileBridgePairingChallenge, 'pairingCode' | 'pairingUri'> | null
  pairedDevices: MobileControlDevice[]
  capabilities: {
    protocolVersion: 1
    deviceId: string
    commands: MobileControlCommandType[]
    capabilities: MobileControlCapability[]
    artifactPreviewModes: ('text' | 'markdown' | 'restrictedHtml')[]
    maxFollowUpCharacters: number
    snapshotTtlMs: number
  }
  diagnostics: MobileBridgeDiagnosticEntry[]
  recentCommands: MobileBridgeCommandEvent[]
}

type MobileBridgeApi = {
  mobileBridgeGetState: () => Promise<MobileBridgeState>
  mobileBridgeUpdateSettings: (input: { enabled?: boolean; relayUrl?: string | null }) => Promise<MobileBridgeState>
  mobileBridgeRequestPairingCode: () => Promise<MobileBridgePairingChallenge>
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
  mobileBridgeGetDiagnostics: () => Promise<MobileBridgeDiagnosticEntry[]>
  onMobileBridgeStateChanged: (cb: (state: MobileBridgeState) => void) => () => void
}

type ActionState = {
  status: 'loading' | 'idle' | 'busy' | 'error'
  message: string
}

const mobileBridgeApi = window.api as typeof window.api & MobileBridgeApi

export default function MobileCompanionPanel() {
  const [state, setState] = useState<MobileBridgeState | null>(null)
  const [pairingChallenge, setPairingChallenge] = useState<MobileBridgePairingChallenge | null>(null)
  const [action, setAction] = useState<ActionState>({
    status: 'loading',
    message: 'Loading mobile companion...',
  })
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [relayUrlDraft, setRelayUrlDraft] = useState('')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const next = await mobileBridgeApi.mobileBridgeGetState()
        if (cancelled) return
        setState(next)
        setRelayUrlDraft(next.relayUrl ?? '')
        setAction({ status: 'idle', message: statusMessage(next) })
      } catch (error) {
        if (cancelled) return
        setAction({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to load mobile companion.',
        })
      }
    }

    void load()
    const dispose = mobileBridgeApi.onMobileBridgeStateChanged((next) => {
      if (cancelled) return
      setState(next)
      setRelayUrlDraft((current) => current || next.relayUrl || '')
      setAction((current) => ({
        status: current.status === 'busy' ? 'busy' : 'idle',
        message: statusMessage(next),
      }))
    })

    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  const activeDevices = useMemo(
    () => state?.pairedDevices.filter((device) => !device.revokedAt) ?? [],
    [state?.pairedDevices]
  )
  const latestDiagnostics = state?.diagnostics.slice(0, showDiagnostics ? 6 : 1) ?? []
  const enabled = state?.enabled ?? false
  const busy = action.status === 'loading' || action.status === 'busy'

  const toggleEnabled = async () => {
    if (busy) return
    const nextEnabled = !enabled
    setAction({
      status: 'busy',
      message: nextEnabled ? 'Enabling mobile companion...' : 'Disabling mobile companion...',
    })
    try {
      const next = await mobileBridgeApi.mobileBridgeUpdateSettings({ enabled: nextEnabled })
      setState(next)
      if (!next.enabled) setPairingChallenge(null)
      setAction({ status: 'idle', message: statusMessage(next) })
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to update mobile companion.',
      })
    }
  }

  const saveRelayUrl = async () => {
    if (busy) return
    setAction({ status: 'busy', message: 'Saving relay URL...' })
    try {
      const next = await mobileBridgeApi.mobileBridgeUpdateSettings({ relayUrl: relayUrlDraft.trim() || null })
      setState(next)
      setRelayUrlDraft(next.relayUrl ?? '')
      setAction({ status: 'idle', message: statusMessage(next) })
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to save relay URL.',
      })
    }
  }

  const requestPairingCode = async () => {
    if (!enabled || busy) return
    setAction({ status: 'busy', message: 'Creating pairing code...' })
    try {
      const challenge = await mobileBridgeApi.mobileBridgeRequestPairingCode()
      const next = await mobileBridgeApi.mobileBridgeGetState()
      setPairingChallenge(challenge)
      setState(next)
      setAction({ status: 'idle', message: `Pairing code expires ${formatDate(challenge.expiresAt)}.` })
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to create pairing code.',
      })
    }
  }

  const copyPairingCode = async () => {
    if (!pairingChallenge) return
    try {
      await navigator.clipboard.writeText(pairingChallenge.pairingCode)
      setAction({ status: 'idle', message: 'Pairing code copied.' })
    } catch {
      setAction({ status: 'error', message: 'Unable to copy pairing code.' })
    }
  }

  const revokeDevice = async (device: MobileControlDevice) => {
    if (revokingDeviceId || !enabled) return
    setRevokingDeviceId(device.deviceId)
    setAction({ status: 'busy', message: `Revoking ${device.displayName}...` })
    try {
      await mobileBridgeApi.mobileBridgeRevokeDevice(device.deviceId, 'Revoked from mobile companion panel.')
      const next = await mobileBridgeApi.mobileBridgeGetState()
      setState(next)
      setAction({ status: 'idle', message: `${device.displayName} revoked.` })
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to revoke mobile device.',
      })
    } finally {
      setRevokingDeviceId(null)
    }
  }

  const refreshDiagnostics = async () => {
    try {
      const diagnostics = await mobileBridgeApi.mobileBridgeGetDiagnostics()
      setState((current) => current ? { ...current, diagnostics } : current)
      setShowDiagnostics(true)
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to refresh mobile diagnostics.',
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#08090b] text-[#ececee]">
      <div className="border-b border-[#1f2025] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Mobile Companion</h2>
            <p className="mt-1 text-sm text-[#8b8c94]">Pair your phone and control Sprint Engine from mobile.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={toggleEnabled}
            disabled={busy}
            className={`inline-flex h-8 items-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-50 ${
              enabled
                ? 'border-[#30d158]/45 bg-[#30d158]/12 text-[#c9f8d5] hover:border-[#30d158]/65'
                : 'border-[#303139] bg-[#111216] text-[#b4b4bd] hover:bg-[#17181d] hover:text-[#ececee]'
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${enabled ? 'bg-[#30d158]' : 'bg-[#5a5a63]'}`} aria-hidden="true" />
            {enabled ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className={`mb-5 border-b px-1 pb-4 ${
          action.status === 'error'
            ? 'border-[#ff787c]/35 text-[#ffb3bf]'
            : enabled && state?.relayStatus === 'connected'
              ? 'border-[#30d158]/28 text-[#c9f8d5]'
              : 'border-[#303139] text-[#d7d7dc]'
        }`}>
          <div className="text-sm font-semibold">{headline(state, action)}</div>
          <div className="mt-1 text-[12px] leading-5 text-current opacity-80">{action.message}</div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
          <section className="min-w-0 space-y-4">
            <div className="rounded-md border border-[#24252b] bg-[#0d0e11] p-4">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  Relay URL
                </span>
                <div className="flex gap-2">
                  <input
                    value={relayUrlDraft}
                    onChange={(event) => setRelayUrlDraft(event.target.value)}
                    onBlur={() => void saveRelayUrl()}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                    placeholder="http://192.168.0.35:3000"
                    className="h-9 min-w-0 flex-1 rounded-md border border-[#303139] bg-[#111216] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#6ee7d8]/70"
                  />
                  <button
                    type="button"
                    onClick={() => void saveRelayUrl()}
                    disabled={busy}
                    className="h-9 rounded-md border border-[#303139] bg-[#111216] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#111216]"
                  >
                    Save
                  </button>
                </div>
              </label>
            </div>

            <div className="border-b border-[#24252b] pb-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[#ececee]">Pairing code</div>
                <button
                  type="button"
                  onClick={requestPairingCode}
                  disabled={!enabled || busy}
                  className="inline-flex h-9 items-center rounded-md bg-[#5c7cff]/16 px-3 text-sm font-semibold text-[#d4ddff] transition-colors hover:bg-[#5c7cff]/24 disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#5c7cff]/16"
                >
                  New Pairing Code
                </button>
              </div>

              {pairingChallenge ? (
                <div className="mt-5 text-center">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#8b8c94]">Pairing code</div>
                  <button
                    type="button"
                    onClick={() => void copyPairingCode()}
                    className="mt-2 font-mono text-5xl font-semibold tracking-[0.2em] text-[#f3f3f5] transition-colors hover:text-[#d8fffb]"
                  >
                    {pairingChallenge.pairingCode}
                  </button>
                  <div className="mt-2 text-[12px] text-[#8b8c94]">Expires {formatDate(pairingChallenge.expiresAt)}</div>
                </div>
              ) : null}
            </div>

            <div className="border-b border-[#24252b] pb-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[#ececee]">Mobile messages</div>
                <div className="text-[12px] text-[#8b8c94]">{state?.recentCommands.length ?? 0} recent</div>
              </div>
              {state?.recentCommands.length ? (
                <div className="divide-y divide-[#24252b]">
                  {state.recentCommands.map((event) => (
                    <div key={event.id} className="grid gap-1 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 truncate text-sm font-semibold text-[#ececee]">{commandLabel(event.commandType)}</div>
                        <span className={`text-[11px] font-semibold ${commandStatusClass(event.status)}`}>{event.status}</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8b8c94]">
                        <span>{event.deviceName ?? event.deviceId ?? 'Mobile device'}</span>
                        <span>{formatDate(event.receivedAt)}</span>
                        {event.resultCode ? <span>{event.resultCode}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-[#8b8c94]">No mobile messages received yet.</div>
              )}
            </div>

            <div className="rounded-md border border-[#24252b] bg-[#0d0e11] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[#ececee]">Paired phones</div>
                <div className="text-[12px] text-[#8b8c94]">{activeDevices.length} active</div>
              </div>
              {activeDevices.length > 0 ? (
                <div className="divide-y divide-[#24252b]">
                  {activeDevices.map((device) => (
                    <div key={device.deviceId} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-[#ececee]">{device.displayName}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8b8c94]">
                          <span>{device.platform}</span>
                          <span>{device.appVersion}</span>
                          <span>Last seen {formatNullableDate(device.lastSeenAt)}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void revokeDevice(device)}
                        disabled={!enabled || revokingDeviceId === device.deviceId}
                        className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#ff787c]/10 hover:text-[#ffb3bf] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                      >
                        {revokingDeviceId === device.deviceId ? 'Revoking...' : 'Revoke'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-md border border-[#24252b] bg-[#111216] px-3 py-3 text-[12px] text-[#8b8c94]">
                  No phones are paired yet.
                </div>
              )}
            </div>
          </section>

          <aside className="space-y-4">
            <div className="rounded-md border border-[#24252b] bg-[#0d0e11] p-4">
              <div className="mb-3 text-sm font-semibold text-[#ececee]">Connection</div>
              <div className="space-y-3 text-sm">
                <MobileFact label="Relay" value={state ? relayStatusLabel(state.relayStatus) : 'Loading'} tone={state?.relayStatus} />
                <MobileFact label="Relay URL" value={state?.relayUrl ?? 'Not configured'} />
                <MobileFact label="Session" value={state?.desktopRelaySessionId ? 'Ready' : 'Not ready'} />
              </div>
            </div>

            <div className="rounded-md border border-[#24252b] bg-[#0d0e11] p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[#ececee]">Diagnostics</div>
                <button
                  type="button"
                  onClick={() => void refreshDiagnostics()}
                  className="rounded-md px-2 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                >
                  {showDiagnostics ? 'Refresh' : 'Show'}
                </button>
              </div>
              {latestDiagnostics.length > 0 ? (
                <div className="space-y-3">
                  {latestDiagnostics.map((entry) => (
                    <div key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-[12px] leading-5">
                      <span className={`mt-2 h-1.5 w-1.5 rounded-full ${diagnosticDotClass(entry.level)}`} aria-hidden="true" />
                      <div className="min-w-0">
                        <div className="text-[#d7d7dc]">{entry.message}</div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#6f7078]">
                          <span>{entry.code}</span>
                          <span>{formatDate(entry.timestamp)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-[12px] text-[#8b8c94]">No diagnostics recorded.</div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function MobileFact({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: MobileBridgeRelayStatus
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#6f7078]">{label}</div>
      <div className={`mt-1 truncate font-medium ${factToneClass(tone)}`}>{value}</div>
    </div>
  )
}

function headline(state: MobileBridgeState | null, action: ActionState): string {
  if (action.status === 'loading') return 'Checking mobile companion'
  if (action.status === 'error') return 'Mobile companion needs attention'
  if (!state?.enabled) return 'Mobile companion is off'
  if (state.relayStatus === 'connected') return 'Ready for mobile control'
  if (latestDiagnosticMessage(state)?.toLowerCase().includes('access token has expired')) return 'Access token expired'
  if (state.relayStatus === 'connecting' || state.relayStatus === 'retrying') return 'Connecting to relay'
  return 'Relay is not ready'
}

function statusMessage(state: MobileBridgeState): string {
  if (!state.enabled) return 'Turn it on, then generate a pairing code for your phone.'
  if (state.relayStatus === 'connected') return 'Your desktop is connected to the relay and ready for paired phones.'
  if (state.relayStatus === 'unconfigured') return 'No relay URL is configured.'
  const diagnosticMessage = latestDiagnosticMessage(state)
  if (diagnosticMessage?.toLowerCase().includes('access token has expired')) {
    return 'Desktop access token has expired. Multicode will refresh it automatically; sign in again if this persists.'
  }
  return `Relay status: ${relayStatusLabel(state.relayStatus)}.`
}

function latestDiagnosticMessage(state: MobileBridgeState): string | null {
  return state.diagnostics[0]?.message ?? null
}

function relayStatusLabel(status: MobileBridgeRelayStatus): string {
  switch (status) {
    case 'unconfigured':
      return 'Not configured'
    case 'retrying':
      return 'Retrying'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1)
  }
}

function factToneClass(tone?: MobileBridgeRelayStatus): string {
  switch (tone) {
    case 'connected':
      return 'text-[#b9f7c8]'
    case 'connecting':
    case 'retrying':
      return 'text-[#ffd58a]'
    case 'error':
      return 'text-[#ffb3bf]'
    default:
      return 'text-[#ececee]'
  }
}

function diagnosticDotClass(level: MobileBridgeDiagnosticEntry['level']): string {
  switch (level) {
    case 'error':
      return 'bg-[#ff787c]'
    case 'warning':
      return 'bg-[#ffbf2f]'
    default:
      return 'bg-[#5c7cff]'
  }
}

function commandLabel(commandType: MobileControlCommandType): string {
  switch (commandType) {
    case 'snapshot.request':
      return 'Snapshot requested'
    case 'artifact.read':
      return 'Artifact opened'
    case 'artifact.approve':
      return 'Artifact approved'
    case 'artifact.requestChanges':
      return 'Changes requested'
    case 'agent.followUp':
      return 'Follow-up sent'
    case 'task.start':
      return 'Task start requested'
    case 'sprintengine.create':
      return 'Sprint Engine create requested'
    case 'device.revoke':
      return 'Device revoke requested'
  }
}

function commandStatusClass(status: MobileBridgeCommandEvent['status']): string {
  switch (status) {
    case 'completed':
      return 'text-[#b9f7c8]'
    case 'failed':
      return 'text-[#ffb3bf]'
    case 'received':
      return 'text-[#ffd58a]'
  }
}

function formatNullableDate(value: string | null | undefined): string {
  return value ? formatDate(value) : 'Never'
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
