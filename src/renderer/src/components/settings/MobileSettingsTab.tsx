import React, { useEffect, useMemo, useId, useState } from 'react'
import { EmptyState, GhostButton, InlineNotice, Input, LinkButton, OutlineButton, PrimaryButton, StatusDot, type Tone } from '../ui'
import {
  MetaCell,
  SettingCard,
  SettingsPageHeader,
  SettingsRow,
  SettingsSectionTitle,
  SettingToggle,
  formatNullableDate,
} from './SettingsAtoms'
import type { MobileControlProtocolVersion } from '../../../../../packages/mobile-control-protocol/src/index'

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
  | 'sprintengine.openPullRequest'
  | 'sprintengine.setAutomationMode'
  | 'automations.control'

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
  | 'sprintengines.pr'
  | 'sprintengines.automation'
  | 'automations.control'

type MobileControlDevice = {
  /** A device paired before a protocol bump keeps its stamp, so this is the window, not the current version. */
  protocolVersion: MobileControlProtocolVersion
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
  // Enabled and configured, but not connected because no active paired device can be
  // listening; zero relay traffic until a device pairs. Mirrors src/shared/electron-api.ts.
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

// Current effective command-poll cadence, surfaced by the bridge so we can explain
// first-command latency. `paused` = not polling; `fast` = base interval; `decayed` =
// backed off toward the idle ceiling. Mirrors src/shared/electron-api.ts.
type MobileBridgeCommandPollCadence = {
  intervalMs: number
  state: 'paused' | 'fast' | 'decayed'
}

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
  commandPollCadence: MobileBridgeCommandPollCadence
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
    message: '',
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
          message: error instanceof Error ? error.message : 'Could not load the mobile companion.',
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
    setAction({ status: 'busy', message: next ? 'Turning on…' : 'Turning off…' })
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
    setAction({ status: 'busy', message: 'Saving…' })
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
    setAction({ status: 'busy', message: 'Creating a code…' })
    try {
      const challenge = await mobileBridgeApi.mobileBridgeRequestPairingCode()
      const next = await mobileBridgeApi.mobileBridgeGetState()
      setPairingChallenge(challenge)
      setState(next)
      setAction({ status: 'idle', message: '' })
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
      setAction({ status: 'idle', message: 'Copied.' })
    } catch {
      setAction({ status: 'error', message: 'Could not copy the code.' })
    }
  }

  const revokeDevice = async (device: MobileControlDevice) => {
    if (revokingDeviceId || !enabled) return
    setRevokingDeviceId(device.deviceId)
    setAction({ status: 'busy', message: `Revoking ${device.displayName}…` })
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
      {/* The relay's state rides the page header as its fact: dot + word, not
          a tinted pill. The dot is earned — it only renders while the
          companion is on (live link, working, or failing). What the state
          means is one line under the header, and an error is a notice. */}
      <SettingsPageHeader
        title="Mobile"
        meta={
          <span className="inline-flex items-center gap-1.5">
            {enabled ? (
              <StatusDot
                tone={relayStatusDotTone(state?.relayStatus)}
                label={relayStatusLabel(state?.relayStatus)}
              />
            ) : null}
            {enabled ? relayStatusLabel(state?.relayStatus) : 'Off'}
          </span>
        }
      />
      {action.status === 'error' ? (
        <InlineNotice tone="error">{action.message || statusMessage(state)}</InlineNotice>
      ) : action.message || statusMessage(state) ? (
        <p className="text-body leading-5 text-[color:var(--text-muted)]">{action.message || statusMessage(state)}</p>
      ) : null}

      <SettingCard>
        <SettingToggle
          label="Mobile companion"
          description="Paired phones can watch runs and send follow-ups."
          enabled={enabled}
          onChange={(next) => void toggleEnabled(next)}
          disabled={busy}
        />

        <SettingsRow label="Relay URL" htmlFor={relayUrlId}>
          <Input
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
            size="md"
            variant="well"
            fullWidth={false}
            className="w-60 max-w-full font-mono"
          />
          <PrimaryButton size="md" onClick={() => void saveRelayUrl()} disabled={busy || !relayUrlDirty}>
            Save
          </PrimaryButton>
        </SettingsRow>
      </SettingCard>

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
        {pairingChallenge ? (
          <div className="mt-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-4 py-3">
            {/* The code IS the control: no box at all, the caller's own type, and
                no underline — one under a tracked mono code collides with it. */}
            <LinkButton
              size="inherit"
              underline="never"
              onClick={() => void copyPairingCode()}
              aria-label={`Copy pairing code ${pairingChallenge.pairingCode}`}
            >
              <span className="font-mono text-[32px] font-semibold tracking-[0.2em]">
                {pairingChallenge.pairingCode}
              </span>
            </LinkButton>
            <div className="mt-1 text-body leading-5 text-[color:var(--text-muted)]">
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
          <SettingCard>
            {activeDevices.map((device) => (
              <div
                key={device.deviceId}
                className="grid gap-3 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <div className="truncate text-body font-medium text-[color:var(--text-strong)]">
                    {device.displayName}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]">
                    <span className="capitalize">{device.platform}</span>
                    <span className="font-mono text-[color:var(--text-muted)]">v{device.appVersion}</span>
                    <span>Last seen {formatNullableDate(device.lastSeenAt)}</span>
                  </div>
                </div>
                <OutlineButton
                  size="md"
                  tone="danger"
                  onClick={() => void revokeDevice(device)}
                  disabled={!enabled || revokingDeviceId === device.deviceId}
                  className="justify-self-start sm:justify-self-end"
                >
                  {revokingDeviceId === device.deviceId ? 'Revoking' : 'Revoke'}
                </OutlineButton>
              </div>
            ))}
          </SettingCard>
        ) : (
          <p className="text-body leading-5 text-[color:var(--text-muted)]">No phones paired.</p>
        )}
      </section>

      {/* The relay's internals are diagnostics: shown once someone has asked
          for the diagnostics below, not on every visit. */}
      {showDiagnostics ? (
      <section>
        <SettingsSectionTitle className="mb-1.5">Relay state</SettingsSectionTitle>
        <div className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-2">
          <MetaCell label="Relay status" value={relayStatusLabel(state?.relayStatus)} tone={relayStatusTone(state?.relayStatus)} />
          <MetaCell
            label="Relay polling"
            value={pollCadenceLabel(enabled, state?.commandPollCadence, activeDevices.length)}
            tone={pollCadenceTone(enabled, state?.commandPollCadence)}
          />
          <MetaCell label="Session" value={state?.desktopRelaySessionId ? 'Ready' : 'Not ready'} tone={state?.desktopRelaySessionId ? 'positive' : 'muted'} />
          <MetaCell label="Last presence" value={formatNullableDate(state?.lastPresenceAt)} />
          <MetaCell label="Token expires" value={formatNullableDate(state?.relayTokenExpiresAt)} />
        </div>
      </section>
      ) : null}

      <section>
        <SettingsSectionTitle className="mb-1.5" count={recentCommands.length}>
          Recent messages
        </SettingsSectionTitle>
        {recentCommands.length > 0 ? (
          <SettingCard>
            {recentCommands.map((event) => (
              <div key={event.id} className="grid gap-1 px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-body text-[color:var(--text-strong)]">
                    {commandLabel(event.commandType)}
                  </div>
                  <span className={`text-meta font-semibold ${commandStatusClass(event.status)}`}>
                    {event.status}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]">
                  <span>{event.deviceName ?? event.deviceId ?? 'Mobile device'}</span>
                  <span>{formatDate(event.receivedAt)}</span>
                  {event.resultCode ? <span className="font-mono">{event.resultCode}</span> : null}
                </div>
              </div>
            ))}
          </SettingCard>
        ) : (
          <EmptyState density="list" title="No messages yet." />
        )}
      </section>

      <section>
        <SettingsSectionTitle
          className="mb-1.5"
          action={
            <GhostButton size="xs" onClick={() => void refreshDiagnostics()}>
              {showDiagnostics ? 'Refresh' : 'Show'}
            </GhostButton>
          }
        >
          Diagnostics
        </SettingsSectionTitle>
        {visibleDiagnostics.length > 0 ? (
          <div className="space-y-3">
            {visibleDiagnostics.map((entry) => (
              <div key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-body leading-5">
                <StatusDot
                  tone={diagnosticDotTone(entry.level)}
                  label={entry.level}
                  className="mt-2"
                />
                <div className="min-w-0">
                  <div className="text-[color:var(--text-default)]">{entry.message}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-meta text-[color:var(--text-muted)]">
                    <span className="font-mono">{entry.code}</span>
                    <span>{formatDate(entry.timestamp)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState density="list" title="No diagnostics recorded." />
        )}
      </section>
    </div>
  )
}

// One line under the header, and only when the state needs a word beyond its
// name: nothing while connected or off, a reason while it is not.
function statusMessage(state: MobileBridgeState | null): string {
  if (!state) return 'Loading…'
  if (!state.enabled) return ''
  if (state.relayStatus === 'connected') return ''
  if (state.relayStatus === 'unconfigured') return 'No relay URL set.'
  if (state.relayStatus === 'idle') return 'Idle until a phone is paired.'
  const diagnosticMessage = latestDiagnosticMessage(state)
  if (diagnosticMessage?.toLowerCase().includes('access token has expired')) {
    return 'Access token expired. Sign in again if this persists.'
  }
  if (state.relayStatus === 'connecting' || state.relayStatus === 'retrying') {
    return 'Connecting…'
  }
  if (state.relayStatus === 'error') {
    return diagnosticMessage ?? 'The relay reported an error.'
  }
  return ''
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
    case 'idle':
      return 'Idle'
    case 'disabled':
      return 'Disabled'
    default:
      return 'Unknown'
  }
}

// Plain-language cadence line for the diagnostics grid. The cadence value (interval +
// state) comes straight from the bridge; we only pick the copy — pairing `paused` with
// `enabled`/paired-device count to tell "companion off", "no phone listening", and a
// live poll interval apart, since the payload's state enum does not encode those.
function pollCadenceLabel(
  enabled: boolean,
  cadence: MobileBridgeCommandPollCadence | undefined,
  activeDeviceCount: number
): string {
  if (!enabled) return 'Off'
  if (!cadence || cadence.state === 'paused') {
    return activeDeviceCount === 0 ? 'Paused — no paired phones' : 'Paused'
  }
  const every = formatCadenceInterval(cadence.intervalMs)
  return cadence.state === 'decayed' ? `Every ${every} (idle backoff)` : `Every ${every} (active)`
}

function pollCadenceTone(
  enabled: boolean,
  cadence: MobileBridgeCommandPollCadence | undefined
): 'positive' | 'muted' | undefined {
  if (!enabled || !cadence || cadence.state === 'paused') return 'muted'
  return cadence.state === 'fast' ? 'positive' : undefined
}

function formatCadenceInterval(intervalMs: number): string {
  if (intervalMs >= 1000) return `${Math.round(intervalMs / 1000)}s`
  return `${Math.max(intervalMs, 0)}ms`
}

function relayStatusTone(status: MobileBridgeRelayStatus | undefined): 'positive' | 'muted' | undefined {
  if (status === 'connected') return 'positive'
  if (!status || status === 'disabled' || status === 'unconfigured' || status === 'idle') return 'muted'
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
    case 'sprintengine.openPullRequest':
      return 'Pull request opened'
    case 'sprintengine.setAutomationMode':
      return 'Automation mode changed'
    case 'automations.control':
      return 'Automation controlled'
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
