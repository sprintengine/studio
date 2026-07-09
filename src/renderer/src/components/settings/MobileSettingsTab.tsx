import React, { useEffect, useMemo, useId, useState } from 'react'
import { GhostButton, PrimaryButton, StatusDot, type Tone } from '../ui'
import { MetaCell, SettingsRow, SettingsSectionTitle, SettingToggle, formatNullableDate } from './SettingsAtoms'

type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'sprintengine.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'
  | 'backlog.update'
  | 'backlog.startSprintEngine'
  | 'backlog.create'

type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'sprintengines.create'
  | 'tasks.start'
  | 'artifacts.review'
  | 'agents.followUp'
  | 'devices.revoke'
  | 'backlog.update'
  | 'backlog.start'
  | 'backlog.create'

type MobileControlDevice = {
  protocolVersion: 2
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
    protocolVersion: 2
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
      await window.api.clipboardWriteText(pairingChallenge.pairingCode)
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

  return (
    <div
      role="tabpanel"
      id="settings-panel-mobile"
      aria-labelledby="settings-tab-mobile"
      className="space-y-5"
    >
      {/* Relay status line: dot + text, not a tinted pill; the message below is
          plain status copy, not an alert block. The dot is earned — it only
          renders while the companion is on (live link, working, or failing). */}
      <div className="space-y-1 border-b border-[color:var(--border-subtle)] pb-3.5">
        <div className="flex items-center gap-1.5">
          {enabled ? (
            <StatusDot
              tone={relayStatusDotTone(state?.relayStatus)}
              label={relayStatusLabel(state?.relayStatus)}
            />
          ) : null}
          <span className="text-[13px] font-medium text-[color:var(--text-strong)]">
            {enabled ? relayStatusLabel(state?.relayStatus) : 'Off'}
          </span>
        </div>
        <p className={`text-[12px] leading-5 ${action.status === 'error' ? 'text-[color:var(--tone-error)]' : 'text-[color:var(--text-muted)]'}`}>
          {action.message || statusMessage(state)}
        </p>
      </div>

      <div className="divide-y divide-[color:var(--border-subtle)]">
        <SettingToggle
          label="Enable mobile companion"
          description="Let paired phones request snapshots, send follow-ups, and control sprints."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          disabled={busy}
        />

        <SettingsRow
          label="Relay URL"
          help="The relay your phone is configured to reach. The connection stays open while the companion is enabled."
          htmlFor={relayUrlId}
        >
          <input
            id={relayUrlId}
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
            className="h-8 w-60 max-w-full rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-app)] px-2.5 font-mono text-[12px] text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] focus:border-[color:var(--accent-primary)] disabled:opacity-45"
          />
          <PrimaryButton size="md" onClick={() => void saveRelayUrl()} disabled={busy || !relayUrlDirty}>
            Save
          </PrimaryButton>
        </SettingsRow>
      </div>

      <section>
        <SettingsSectionTitle
          className="mb-1.5"
          action={
            <PrimaryButton size="md" onClick={() => void requestPairingCode()} disabled={!enabled || busy}>
              Generate code
            </PrimaryButton>
          }
        >
          Pairing code
        </SettingsSectionTitle>
        <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
          Single-use; enter it in the Multicode mobile app.
        </p>
        {pairingChallenge ? (
          <div className="mt-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-4 py-3">
            <button
              type="button"
              onClick={() => void copyPairingCode()}
              className="block font-mono text-[32px] font-semibold tracking-[0.2em] text-[color:var(--text-strong)] transition-colors hover:text-[color:var(--accent-primary)] focus:outline-none focus-visible:text-[color:var(--accent-primary)]"
              aria-label={`Copy pairing code ${pairingChallenge.pairingCode}`}
            >
              {pairingChallenge.pairingCode}
            </button>
            <div className="mt-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
              Expires {formatDate(pairingChallenge.expiresAt)} · tap to copy
            </div>
          </div>
        ) : null}
      </section>

      <section>
        <SettingsSectionTitle className="mb-1.5" count={activeDevices.length}>
          Paired phones
        </SettingsSectionTitle>
        {activeDevices.length > 0 ? (
          <div className="divide-y divide-[color:var(--bg-selected)]">
            {activeDevices.map((device) => (
              <div
                key={device.deviceId}
                className="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-[color:var(--text-strong)]">
                    {device.displayName}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[color:var(--text-muted)]">
                    <span className="capitalize">{device.platform}</span>
                    <span className="font-mono text-[color:var(--text-muted)]">v{device.appVersion}</span>
                    <span>Last seen {formatNullableDate(device.lastSeenAt)}</span>
                  </div>
                </div>
                <GhostButton
                  size="md"
                  onClick={() => void revokeDevice(device)}
                  disabled={!enabled || revokingDeviceId === device.deviceId}
                  className="justify-self-start border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--text-default)] hover:text-[color:var(--tone-error)] sm:justify-self-end"
                >
                  {revokingDeviceId === device.deviceId ? 'Revoking' : 'Revoke'}
                </GhostButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
            No phones paired yet. Generate a pairing code to link one.
          </p>
        )}
      </section>

      <section>
        <SettingsSectionTitle className="mb-1.5">Relay state</SettingsSectionTitle>
        <div className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <MetaCell label="Relay status" value={relayStatusLabel(state?.relayStatus)} tone={relayStatusTone(state?.relayStatus)} />
          <MetaCell label="Session" value={state?.desktopRelaySessionId ? 'Ready' : 'Not ready'} tone={state?.desktopRelaySessionId ? 'positive' : 'muted'} />
          <MetaCell label="Last presence" value={formatNullableDate(state?.lastPresenceAt)} />
          <MetaCell label="Token expires" value={formatNullableDate(state?.relayTokenExpiresAt)} />
        </div>
      </section>

      <section>
        <SettingsSectionTitle className="mb-1.5" count={recentCommands.length}>
          Recent mobile messages
        </SettingsSectionTitle>
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
      </section>

      <section>
        <SettingsSectionTitle
          className="mb-1.5"
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
          Diagnostics
        </SettingsSectionTitle>
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
      </section>
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

function relayStatusDotTone(status: MobileBridgeRelayStatus | undefined): Tone {
  switch (status) {
    case 'connected':
      return 'good'
    case 'connecting':
    case 'retrying':
      return 'warn'
    case 'error':
      return 'error'
    default:
      return 'neutral'
  }
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
      return 'Sprint create requested'
    case 'device.revoke':
      return 'Device revoke requested'
    case 'backlog.update':
      return 'Backlog item updated'
    case 'backlog.startSprintEngine':
      return 'Sprint started from backlog'
    case 'backlog.create':
      return 'Backlog item created'
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
