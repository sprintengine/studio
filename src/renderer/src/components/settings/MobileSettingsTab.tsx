import React, { useEffect, useMemo, useId, useState } from 'react'
import { Field, Section, StatusDot, type Tone } from '../ui'
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
  const relayUrlId = useId()
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
    ? 'border-[color:var(--tone-error)] text-[color:var(--tone-error)]'
    : enabled && state?.relayStatus === 'connected'
      ? 'border-[color:var(--tone-good)]/70 text-[color:var(--tone-good)]'
      : enabled && (state?.relayStatus === 'connecting' || state?.relayStatus === 'retrying')
        ? 'border-[color:var(--tone-warn)]/75 text-[color:var(--tone-warn)]'
        : 'border-[color:var(--border-default)] text-[color:var(--text-muted)]'

  return (
    <div
      role="tabpanel"
      id="settings-panel-mobile"
      aria-labelledby="settings-tab-mobile"
      className="space-y-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-[color:var(--text-muted)]">
            Mobile companion
          </div>
          <div className="mt-1 text-sm font-semibold text-[color:var(--text-strong)]">
            Pair phones to drive Sprint Engine remotely
          </div>
        </div>
        <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
          enabled
            ? state?.relayStatus === 'connected'
              ? 'border-[color:var(--tone-good)]/35 bg-[color:var(--tone-good-soft)] text-[color:var(--tone-good)]'
              : state?.relayStatus === 'connecting' || state?.relayStatus === 'retrying'
                ? 'border-[color:var(--tone-warn)]/35 bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn)]'
                : state?.relayStatus === 'error'
                  ? 'border-[color:var(--tone-error)]/35 bg-[color:var(--tone-error-soft)] text-[color:var(--tone-error)]'
                  : 'border-[color:var(--accent-primary)]/35 bg-[color:var(--accent-primary-soft)] text-[color:var(--accent-primary)]'
            : 'border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-muted)]'
        }`}>
          {enabled ? relayStatusLabel(state?.relayStatus) : 'Off'}
        </div>
      </div>

      <div className={`border-l-2 pl-3 text-[12px] leading-5 ${noteToneClass}`}>
        {action.message || statusMessage(state)}
      </div>

      <Section title="Companion" level={3} inset={false}>
        <SettingToggle
          label="Enable mobile companion"
          description="Connect this desktop to the relay so paired phones can request snapshots, send follow-ups, and control Sprint Engine."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          disabled={busy}
        />
      </Section>

      <Section title="Relay" level={3} inset={false}>
        <Field
          label="Relay URL"
          htmlFor={relayUrlId}
          help="Point this desktop at the relay your phone is configured to reach. Multicode keeps the connection open while the companion is enabled."
        >
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
              className="h-9 min-w-0 flex-1 rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-3 font-mono text-sm text-[color:var(--text-strong)] outline-none transition-colors placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)]/70"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveRelayUrl()}
                disabled={busy || !relayUrlDirty}
                className="h-9 rounded-md bg-[color:var(--accent-primary)] px-3 text-sm font-semibold text-[color:var(--text-on-accent)] transition-colors hover:bg-[color:var(--accent-primary-hover)] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[color:var(--accent-primary)]"
              >
                Save
              </button>
            </div>
          </div>
        </Field>
      </Section>

      <Section
        title="Pairing code"
        level={3}
        inset={false}
        action={
          <button
            type="button"
            onClick={() => void requestPairingCode()}
            disabled={!enabled || busy}
            className="h-9 rounded-md bg-[color:var(--accent-primary)] px-3 text-sm font-semibold text-[color:var(--text-on-accent)] transition-colors hover:bg-[color:var(--accent-primary-hover)] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[color:var(--accent-primary)]"
          >
            Generate code
          </button>
        }
      >
        <p className="text-[12px] leading-5 text-[color:var(--text-disabled)]">
          Generate a single-use code, then enter it on a phone running the Multicode mobile app.
        </p>
        {pairingChallenge ? (
          <div className="mt-4 rounded-md border border-[color:var(--accent-primary)]/30 bg-[color:var(--accent-primary-soft)] px-4 py-4">
            <div className="text-[12px] font-semibold text-[color:var(--text-muted)]">
              Pairing code
            </div>
            <button
              type="button"
              onClick={() => void copyPairingCode()}
              className="mt-1 block font-mono text-[36px] font-semibold tracking-[0.2em] text-[color:var(--text-strong)] transition-colors hover:text-[color:var(--accent-primary)] focus:outline-none focus-visible:text-[color:var(--accent-primary)]"
              aria-label={`Copy pairing code ${pairingChallenge.pairingCode}`}
            >
              {pairingChallenge.pairingCode}
            </button>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Expires {formatDate(pairingChallenge.expiresAt)}. Tap the code to copy.
            </div>
          </div>
        ) : null}
      </Section>

      <Section
        title="Paired phones"
        level={3}
        inset={false}
        count={activeDevices.length}
      >
        {activeDevices.length > 0 ? (
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {activeDevices.map((device) => (
              <div
                key={device.deviceId}
                className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-[color:var(--text-strong)]">
                    {device.displayName}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--text-muted)]">
                    <span className="capitalize">{device.platform}</span>
                    <span className="font-mono text-[color:var(--text-muted)]">v{device.appVersion}</span>
                    <span>Last seen {formatNullableDate(device.lastSeenAt)}</span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void revokeDevice(device)}
                  disabled={!enabled || revokingDeviceId === device.deviceId}
                  className="justify-self-start rounded-md border border-[color:var(--border-strong)] bg-[color:var(--bg-surface)] px-3 py-1.5 text-sm font-semibold text-[color:var(--text-default)] transition-colors hover:border-[color:var(--tone-error)]/45 hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--tone-error)] disabled:cursor-default disabled:opacity-45 disabled:hover:border-[color:var(--border-strong)] disabled:hover:bg-[color:var(--bg-surface)] disabled:hover:text-[color:var(--text-default)] sm:justify-self-end"
                >
                  {revokingDeviceId === device.deviceId ? 'Revoking.' : 'Revoke'}
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-[color:var(--text-disabled)]">
            No phones paired yet. Generate a pairing code, then enter it in the mobile app to link a device.
          </p>
        )}
      </Section>

      <Section title="Relay state" level={3} inset={false}>
        <div className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <MetaCell label="Relay status" value={relayStatusLabel(state?.relayStatus)} tone={relayStatusTone(state?.relayStatus)} />
          <MetaCell label="Session" value={state?.desktopRelaySessionId ? 'Ready' : 'Not ready'} tone={state?.desktopRelaySessionId ? 'positive' : 'muted'} />
          <MetaCell label="Last presence" value={formatNullableDate(state?.lastPresenceAt)} />
          <MetaCell label="Token expires" value={formatNullableDate(state?.relayTokenExpiresAt)} />
        </div>
      </Section>

      <Section
        title="Recent mobile messages"
        level={3}
        inset={false}
        count={recentCommands.length}
      >
        {recentCommands.length > 0 ? (
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {recentCommands.map((event) => (
              <div key={event.id} className="grid gap-1 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-sm text-[color:var(--text-strong)]">
                    {commandLabel(event.commandType)}
                  </div>
                  <span className={`text-[11px] font-semibold ${commandStatusClass(event.status)}`}>
                    {event.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--text-muted)]">
                  <span>{event.deviceName ?? event.deviceId ?? 'Mobile device'}</span>
                  <span>{formatDate(event.receivedAt)}</span>
                  {event.resultCode ? <span className="font-mono">{event.resultCode}</span> : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-[color:var(--text-disabled)]">
            No mobile messages yet.
          </p>
        )}
      </Section>

      <Section
        title="Diagnostics"
        level={3}
        inset={false}
        action={
          <button
            type="button"
            onClick={() => void refreshDiagnostics()}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
          >
            {showDiagnostics ? 'Refresh' : 'Show'}
          </button>
        }
      >
        {visibleDiagnostics.length > 0 ? (
          <div className="space-y-3">
            {visibleDiagnostics.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-[12px] leading-5">
                <StatusDot
                  tone={diagnosticDotTone(entry.level)}
                  label={entry.level}
                  className="mt-2"
                />
                <div className="min-w-0">
                  <div className="text-[color:var(--text-default)]">{entry.message}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[color:var(--text-disabled)]">
                    <span className="font-mono">{entry.code}</span>
                    <span>{formatDate(entry.timestamp)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-[color:var(--text-disabled)]">
            No diagnostics recorded.
          </p>
        )}
      </Section>
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

function diagnosticDotTone(level: MobileBridgeDiagnosticEntry['level']): Tone {
  switch (level) {
    case 'error':
      return 'error'
    case 'warning':
      return 'warn'
    default:
      return 'accent'
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
      return 'text-[color:var(--tone-good)]'
    case 'failed':
      return 'text-[color:var(--tone-error)]'
    case 'received':
      return 'text-[color:var(--tone-warn)]'
  }
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
