import React, { useEffect, useMemo, useState } from 'react'
import { MetaCell, SettingToggle, formatNullableDate } from './SettingsAtoms'

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

type ActionStatus = 'loading' | 'idle' | 'busy' | 'error'

type ActionState = {
  status: ActionStatus
  message: string
}

const mobileBridgeApi = window.api as typeof window.api & MobileBridgeApi

export default function MobileSettingsTab() {
  const [state, setState] = useState<MobileBridgeState | null>(null)
  const [pairingChallenge, setPairingChallenge] = useState<MobileBridgePairingChallenge | null>(null)
  const [action, setAction] = useState<ActionState>({
    status: 'loading',
    message: 'Loading mobile companion.',
  })
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [relayUrlDraft, setRelayUrlDraft] = useState('')
  const [relayUrlPersisted, setRelayUrlPersisted] = useState('')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const next = await mobileBridgeApi.mobileBridgeGetState()
        if (cancelled) return
        setState(next)
        setRelayUrlPersisted(next.relayUrl ?? '')
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
      setRelayUrlPersisted(next.relayUrl ?? '')
      setRelayUrlDraft((current) => (current === '' ? next.relayUrl ?? '' : current))
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
  const enabled = state?.enabled ?? false
  const busy = action.status === 'loading' || action.status === 'busy'
  const recentCommands = state?.recentCommands ?? []
  const visibleDiagnostics = state?.diagnostics.slice(0, showDiagnostics ? 6 : 1) ?? []
  const relayUrlDirty = relayUrlDraft.trim() !== relayUrlPersisted.trim()

  const toggleEnabled = async (next: boolean) => {
    if (busy || enabled === next) return
    setAction({
      status: 'busy',
      message: next ? 'Enabling mobile companion.' : 'Disabling mobile companion.',
    })
    try {
      const result = await mobileBridgeApi.mobileBridgeUpdateSettings({ enabled: next })
      setState(result)
      if (!result.enabled) setPairingChallenge(null)
      setAction({ status: 'idle', message: statusMessage(result) })
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to update mobile companion.',
      })
    }
  }

  const saveRelayUrl = async () => {
    if (busy || !relayUrlDirty) return
    setAction({ status: 'busy', message: 'Saving relay URL.' })
    try {
      const next = await mobileBridgeApi.mobileBridgeUpdateSettings({
        relayUrl: relayUrlDraft.trim() || null,
      })
      setState(next)
      setRelayUrlPersisted(next.relayUrl ?? '')
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
    setAction({ status: 'busy', message: 'Creating pairing code.' })
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
      setAction({ status: 'idle', message: 'Pairing code copied to clipboard.' })
    } catch {
      setAction({ status: 'error', message: 'Could not copy pairing code.' })
    }
  }

  const revokeDevice = async (device: MobileControlDevice) => {
    if (revokingDeviceId || !enabled) return
    setRevokingDeviceId(device.deviceId)
    setAction({ status: 'busy', message: `Revoking ${device.displayName}.` })
    try {
      await mobileBridgeApi.mobileBridgeRevokeDevice(
        device.deviceId,
        'Revoked from settings.'
      )
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
      setState((current) => (current ? { ...current, diagnostics } : current))
      setShowDiagnostics(true)
    } catch (error) {
      setAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to refresh diagnostics.',
      })
    }
  }

  const noteToneClass = action.status === 'error'
    ? 'border-[#ff787c] text-[#ffb3b5]'
    : enabled && state?.relayStatus === 'connected'
      ? 'border-[#30d158]/70 text-[#b9f7c8]'
      : enabled && (state?.relayStatus === 'connecting' || state?.relayStatus === 'retrying')
        ? 'border-[#ffbf2f]/75 text-[#ffd58a]'
        : 'border-[rgba(255,255,255,0.10)] text-[#9a9aa2]'

  return (
    <div
      role="tabpanel"
      id="settings-panel-mobile"
      aria-labelledby="settings-tab-mobile"
      className="space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
            Mobile Companion
          </div>
          <div className="mt-1 text-sm font-semibold text-[#ececee]">
            Pair phones to drive Sprint Engine remotely
          </div>
        </div>
        <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
          enabled
            ? state?.relayStatus === 'connected'
              ? 'border-[#30d158]/35 bg-[#30d158]/10 text-[#b9f7c8]'
              : state?.relayStatus === 'connecting' || state?.relayStatus === 'retrying'
                ? 'border-[#ffbf2f]/35 bg-[#ffbf2f]/10 text-[#ffe0a3]'
                : state?.relayStatus === 'error'
                  ? 'border-[#ff787c]/35 bg-[#ff787c]/10 text-[#ffb3b5]'
                  : 'border-[#5c7cff]/35 bg-[#5c7cff]/10 text-[#b8ccff]'
            : 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2]'
        }`}>
          {enabled ? relayStatusLabel(state?.relayStatus) : 'Off'}
        </div>
      </div>

      <div className={`border-l-2 pl-3 text-[12px] leading-5 ${noteToneClass}`}>
        {action.message || statusMessage(state)}
      </div>

      <div className="divide-y divide-[#24252b]">
        <SettingToggle
          label="Enable mobile companion"
          description="Connect this desktop to the relay so paired phones can request snapshots, send follow-ups, and control Sprint Engine."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          disabled={busy}
        />
      </div>

      <div className="border-t border-[#24252b] pt-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
            Relay URL
          </span>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={relayUrlDraft}
              onChange={(event) => setRelayUrlDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void saveRelayUrl()
                }
              }}
              placeholder="https://relay.example.com"
              autoComplete="off"
              spellCheck={false}
              className="h-9 min-w-0 flex-1 rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#5c7cff]/70"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveRelayUrl()}
                disabled={busy || !relayUrlDirty}
                className="h-9 rounded-md bg-[#5c7cff] px-3 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#5c7cff]"
              >
                Save
              </button>
            </div>
          </div>
        </label>
        <p className="mt-2 text-[12px] leading-5 text-[#5a5a63]">
          Point this desktop at the relay your phone is configured to reach. Multicode keeps the connection open while the companion is enabled.
        </p>
      </div>

      <div className="border-t border-[#24252b] pt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[#ececee]">Pairing code</div>
            <p className="mt-1 text-[12px] leading-5 text-[#5a5a63]">
              Generate a single-use code, then enter it on a phone running the Multicode mobile app.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void requestPairingCode()}
            disabled={!enabled || busy}
            className="h-9 rounded-md bg-[#5c7cff] px-3 text-sm font-semibold text-[#08090b] transition-colors hover:bg-[#6e8eff] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#5c7cff]"
          >
            Generate code
          </button>
        </div>

        {pairingChallenge ? (
          <div className="mt-4 rounded-md border border-[#5c7cff]/30 bg-[#100f1c] px-4 py-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#8a93b8]">
              Pairing code
            </div>
            <button
              type="button"
              onClick={() => void copyPairingCode()}
              className="mt-1 block font-mono text-[36px] font-semibold tracking-[0.2em] text-[#ececee] transition-colors hover:text-[#d4ddff] focus:outline-none focus-visible:text-[#d4ddff]"
              aria-label={`Copy pairing code ${pairingChallenge.pairingCode}`}
            >
              {pairingChallenge.pairingCode}
            </button>
            <div className="mt-1 text-[12px] leading-5 text-[#9a9aa2]">
              Expires {formatDate(pairingChallenge.expiresAt)}. Tap the code to copy.
            </div>
          </div>
        ) : null}
      </div>

      <div className="border-t border-[#24252b] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-[#ececee]">Paired phones</div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">
            {activeDevices.length} active
          </div>
        </div>
        {activeDevices.length > 0 ? (
          <div className="mt-3 divide-y divide-[#24252b]">
            {activeDevices.map((device) => (
              <div
                key={device.deviceId}
                className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[#ececee]">
                    {device.displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8a8a92]">
                    <span className="capitalize">{device.platform}</span>
                    <span className="font-mono text-[#9a9aa2]">v{device.appVersion}</span>
                    <span>Last seen {formatNullableDate(device.lastSeenAt)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeDevice(device)}
                  disabled={!enabled || revokingDeviceId === device.deviceId}
                  className="justify-self-start rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:border-[#ff787c]/45 hover:bg-[#17181d] hover:text-[#ffb3b5] disabled:cursor-default disabled:opacity-45 disabled:hover:border-[#303139] disabled:hover:bg-[#0d0e11] disabled:hover:text-[#d7d7dc] sm:justify-self-end"
                >
                  {revokingDeviceId === device.deviceId ? 'Revoking.' : 'Revoke'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] leading-5 text-[#5a5a63]">
            No phones paired yet. Generate a pairing code, then enter it in the mobile app to link a device.
          </p>
        )}
      </div>

      <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
        <MetaCell label="Relay status" value={relayStatusLabel(state?.relayStatus)} tone={relayStatusTone(state?.relayStatus)} />
        <MetaCell label="Session" value={state?.desktopRelaySessionId ? 'Ready' : 'Not ready'} tone={state?.desktopRelaySessionId ? 'positive' : 'muted'} />
        <MetaCell label="Last presence" value={formatNullableDate(state?.lastPresenceAt)} />
        <MetaCell label="Token expires" value={formatNullableDate(state?.relayTokenExpiresAt)} />
      </div>

      <div className="border-t border-[#24252b] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-[#ececee]">Recent mobile messages</div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#5a5a63]">
            {recentCommands.length} recent
          </div>
        </div>
        {recentCommands.length > 0 ? (
          <div className="mt-3 divide-y divide-[#24252b]">
            {recentCommands.map((event) => (
              <div key={event.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-sm text-[#ececee]">
                    {commandLabel(event.commandType)}
                  </div>
                  <span className={`text-[11px] font-semibold uppercase tracking-[0.08em] ${commandStatusClass(event.status)}`}>
                    {event.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#8a8a92]">
                  <span>{event.deviceName ?? event.deviceId ?? 'Mobile device'}</span>
                  <span>{formatDate(event.receivedAt)}</span>
                  {event.resultCode ? <span className="font-mono">{event.resultCode}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] leading-5 text-[#5a5a63]">
            No mobile messages yet.
          </p>
        )}
      </div>

      <div className="border-t border-[#24252b] pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-[#ececee]">Diagnostics</div>
          <button
            type="button"
            onClick={() => void refreshDiagnostics()}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5c7cff]/60"
          >
            {showDiagnostics ? 'Refresh' : 'Show'}
          </button>
        </div>
        {visibleDiagnostics.length > 0 ? (
          <div className="mt-3 space-y-3">
            {visibleDiagnostics.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-[12px] leading-5">
                <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${diagnosticDotClass(entry.level)}`} aria-hidden="true" />
                <div className="min-w-0">
                  <div className="text-[#d7d7dc]">{entry.message}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#5a5a63]">
                    <span className="font-mono uppercase tracking-[0.08em]">{entry.code}</span>
                    <span>{formatDate(entry.timestamp)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[12px] leading-5 text-[#5a5a63]">
            No diagnostics recorded.
          </p>
        )}
      </div>
    </div>
  )
}

function statusMessage(state: MobileBridgeState | null): string {
  if (!state) return 'Loading mobile companion.'
  if (!state.enabled) return 'Turn the companion on, then generate a pairing code for a phone.'
  if (state.relayStatus === 'connected') return 'Connected to the relay and ready for paired phones.'
  if (state.relayStatus === 'unconfigured') return 'No relay URL is configured.'
  const diagnosticMessage = latestDiagnosticMessage(state)
  if (diagnosticMessage?.toLowerCase().includes('access token has expired')) {
    return 'Desktop access token has expired. Multicode will refresh it automatically; sign in again if this persists.'
  }
  if (state.relayStatus === 'connecting' || state.relayStatus === 'retrying') {
    return 'Connecting to the relay.'
  }
  if (state.relayStatus === 'error') {
    return diagnosticMessage ?? 'Relay reported an error.'
  }
  return `Relay status: ${relayStatusLabel(state.relayStatus)}.`
}

function latestDiagnosticMessage(state: MobileBridgeState): string | null {
  return state.diagnostics[0]?.message ?? null
}

function relayStatusLabel(status: MobileBridgeRelayStatus | undefined): string {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'retrying':
      return 'Retrying'
    case 'error':
      return 'Error'
    case 'unconfigured':
      return 'Not configured'
    case 'disabled':
      return 'Disabled'
    default:
      return 'Unknown'
  }
}

function relayStatusTone(status: MobileBridgeRelayStatus | undefined): 'positive' | 'muted' | undefined {
  if (status === 'connected') return 'positive'
  if (!status || status === 'disabled' || status === 'unconfigured') return 'muted'
  return undefined
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
      return 'text-[#ffb3b5]'
    case 'received':
      return 'text-[#ffd58a]'
  }
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
