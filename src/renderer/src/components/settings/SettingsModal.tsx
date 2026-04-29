import React, { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'

interface Props {
  onClose: () => void
}

type MobileControlCommandType =
  | 'snapshot.request'
  | 'artifact.read'
  | 'swarm.create'
  | 'task.start'
  | 'artifact.approve'
  | 'artifact.requestChanges'
  | 'agent.followUp'
  | 'device.revoke'

type MobileControlCapability =
  | 'snapshots.read'
  | 'artifacts.read'
  | 'swarms.create'
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
}

type MobileBridgeApi = {
  mobileBridgeGetState: () => Promise<MobileBridgeState>
  mobileBridgeUpdateSettings: (input: { enabled?: boolean }) => Promise<MobileBridgeState>
  mobileBridgeRequestPairingCode: () => Promise<MobileBridgePairingChallenge>
  mobileBridgeRevokeDevice: (deviceId: string, reason?: string) => Promise<MobileControlDevice>
  mobileBridgePublishPresence: (presence: MobileBridgePresence) => Promise<MobileBridgeState>
  mobileBridgeGetDiagnostics: () => Promise<MobileBridgeDiagnosticEntry[]>
  onMobileBridgeStateChanged: (cb: (state: MobileBridgeState) => void) => () => void
}

type MobileBridgeActionState = {
  status: 'idle' | 'loading' | 'busy' | 'error'
  message: string
}

const mobileBridgeApi = window.api as typeof window.api & MobileBridgeApi
const presenceOptions: MobileBridgePresence[] = ['available', 'busy', 'idle', 'offline']

function parseSearchExcludeText(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

export default function SettingsModal({ onClose }: Props) {
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? [])
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const setSearchExcludes = useWorkspaceStore((s) => s.setSearchExcludes)
  const isWindows = window.api.platform === 'win32'
  const [mobileState, setMobileState] = useState<MobileBridgeState | null>(null)
  const [pairingChallenge, setPairingChallenge] = useState<MobileBridgePairingChallenge | null>(null)
  const [mobileAction, setMobileAction] = useState<MobileBridgeActionState>({
    status: 'loading',
    message: 'Loading mobile companion status...',
  })
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [showMobileDiagnostics, setShowMobileDiagnostics] = useState(false)
  const [searchExcludesDraft, setSearchExcludesDraft] = useState(() => searchExcludes.join('\n'))

  const closeSettings = useCallback(() => {
    setSearchExcludes(parseSearchExcludeText(searchExcludesDraft))
    onClose()
  }, [onClose, searchExcludesDraft, setSearchExcludes])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSettings()
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  useEffect(() => {
    let cancelled = false

    const loadMobileState = async () => {
      try {
        const state = await mobileBridgeApi.mobileBridgeGetState()
        if (cancelled) return
        setMobileState(state)
        setMobileAction({ status: 'idle', message: mobileStatusMessage(state) })
      } catch (error) {
        if (cancelled) return
        setMobileAction({
          status: 'error',
          message: error instanceof Error ? error.message : 'Failed to load mobile companion status.',
        })
      }
    }

    void loadMobileState()
    const dispose = mobileBridgeApi.onMobileBridgeStateChanged((state) => {
      if (cancelled) return
      setMobileState(state)
      setMobileAction((current) => ({
        status: current.status === 'busy' ? 'busy' : 'idle',
        message: mobileStatusMessage(state),
      }))
    })

    return () => {
      cancelled = true
      dispose()
    }
  }, [])

  useEffect(() => {
    setSearchExcludesDraft(searchExcludes.join('\n'))
  }, [searchExcludes])

  const toggleMobileControl = async () => {
    if (mobileAction.status === 'busy') return

    const enabled = !(mobileState?.enabled ?? false)
    setMobileAction({
      status: 'busy',
      message: enabled ? 'Enabling mobile companion control...' : 'Disabling mobile companion control...',
    })
    try {
      const state = await mobileBridgeApi.mobileBridgeUpdateSettings({ enabled })
      setMobileState(state)
      if (!state.enabled) setPairingChallenge(null)
      setMobileAction({ status: 'idle', message: mobileStatusMessage(state) })
    } catch (error) {
      setMobileAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to update mobile companion control.',
      })
    }
  }

  const requestPairingCode = async () => {
    if (!mobileState?.enabled || mobileAction.status === 'busy') return

    setMobileAction({ status: 'busy', message: 'Creating mobile pairing code...' })
    try {
      const challenge = await mobileBridgeApi.mobileBridgeRequestPairingCode()
      setPairingChallenge(challenge)
      const state = await mobileBridgeApi.mobileBridgeGetState()
      setMobileState(state)
      setMobileAction({ status: 'idle', message: `Pairing code expires ${formatMobileDate(challenge.expiresAt)}.` })
    } catch (error) {
      setMobileAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to create mobile pairing code.',
      })
    }
  }

  const revokeDevice = async (device: MobileControlDevice) => {
    if (revokingDeviceId) return

    setRevokingDeviceId(device.deviceId)
    setMobileAction({ status: 'busy', message: `Revoking ${device.displayName}...` })
    try {
      await mobileBridgeApi.mobileBridgeRevokeDevice(device.deviceId, 'Revoked from desktop settings.')
      const state = await mobileBridgeApi.mobileBridgeGetState()
      setMobileState(state)
      setMobileAction({ status: 'idle', message: `${device.displayName} revoked.` })
    } catch (error) {
      setMobileAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to revoke mobile device.',
      })
    } finally {
      setRevokingDeviceId(null)
    }
  }

  const publishPresence = async (presence: MobileBridgePresence) => {
    if (!mobileState?.enabled || mobileAction.status === 'busy') return

    setMobileAction({ status: 'busy', message: `Setting mobile presence to ${presence}...` })
    try {
      const state = await mobileBridgeApi.mobileBridgePublishPresence(presence)
      setMobileState(state)
      setMobileAction({ status: 'idle', message: mobileStatusMessage(state) })
    } catch (error) {
      setMobileAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to update mobile presence.',
      })
    }
  }

  const refreshMobileDiagnostics = async () => {
    try {
      const diagnostics = await mobileBridgeApi.mobileBridgeGetDiagnostics()
      setMobileState((current) => current ? { ...current, diagnostics } : current)
      setShowMobileDiagnostics(true)
    } catch (error) {
      setMobileAction({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to refresh mobile diagnostics.',
      })
    }
  }

  const activeDevices = mobileState?.pairedDevices.filter((device) => !device.revokedAt) ?? []
  const revokedDevices = mobileState?.pairedDevices.filter((device) => device.revokedAt) ?? []
  const mobileEnabled = mobileState?.enabled ?? false
  const latestDiagnostics = mobileState?.diagnostics.slice(0, showMobileDiagnostics ? 6 : 2) ?? []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && closeSettings()}
    >
      <div className="max-h-[92vh] w-[760px] max-w-[95vw] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#ececee]">Settings</h2>
            <p className="mt-0.5 text-sm text-[#5a5a63]">Configure local CLIs and desktop-authorized mobile access.</p>
          </div>
          <button onClick={closeSettings} className="text-xl leading-none text-[#5a5a63] hover:text-[#d7d7dc]">
            x
          </button>
        </div>

        <div className="space-y-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
            Agent CLIs
          </div>
          {([
            ['codex', 'Codex command'],
            ['claude', 'Claude command'],
          ] as Array<[AgentCli, string]>).map(([cli, label]) => (
            <div key={cli} className="space-y-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
                  {label}
                </span>
                <input
                  value={cliRuntimes[cli].command}
                  onChange={(event) => setCliRuntime(cli, { command: event.target.value })}
                  placeholder={cli}
                  className="w-full rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#6ee7d8]/70"
                />
              </label>

              {isWindows && (
                <label className="flex items-center justify-between rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2">
                  <span className="text-sm text-[#d7d7dc]">
                    Run {cli === 'codex' ? 'Codex' : 'Claude'} through WSL
                  </span>
                  <input
                    type="checkbox"
                    checked={cliRuntimes[cli].useWsl}
                    onChange={(event) => setCliRuntime(cli, { useWsl: event.target.checked })}
                    className="peer sr-only"
                  />
                  <span className="relative h-5 w-9 rounded-full bg-[#303139] transition-colors peer-checked:bg-[#6ee7d8] peer-checked:[&>span]:translate-x-4 peer-checked:[&>span]:bg-[#061210]">
                    <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#d7d7dc] transition-transform" />
                  </span>
                </label>
              )}
            </div>
          ))}
          <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2 text-[12px] leading-5 text-[#5a5a63]">
            Defaults are <span className="font-mono text-[#d7d7dc]">codex</span> native and{' '}
            <span className="font-mono text-[#d7d7dc]">claude</span>{isWindows ? ' through WSL' : ''}.
            Use a full executable path if your CLI is not on PATH.
          </div>
        </div>

        <div className="mt-4 space-y-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
              File Search
            </div>
            <div className="mt-1 text-sm font-semibold text-[#ececee]">
              Additional exclude patterns
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Excludes
            </span>
            <textarea
              value={searchExcludesDraft}
              onChange={(event) => setSearchExcludesDraft(event.target.value)}
              onBlur={(event) => setSearchExcludes(parseSearchExcludeText(event.target.value))}
              rows={4}
              placeholder={'generated\n*.snap\nfixtures/large/**'}
              className="min-h-[96px] w-full resize-y rounded-md border border-[#303139] bg-[#0d0e11] px-3 py-2 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#6ee7d8]/70"
            />
          </label>
          <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2 text-[12px] leading-5 text-[#5a5a63]">
            Defaults still exclude heavy folders like <span className="font-mono text-[#d7d7dc]">.git</span>,{' '}
            <span className="font-mono text-[#d7d7dc]">node_modules</span>, and{' '}
            <span className="font-mono text-[#d7d7dc]">dist</span>. Add one pattern per line or separate entries with commas.
          </div>
        </div>

        <div className="mt-4 space-y-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Mobile Companion
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Desktop-authorized swarm control
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={mobileEnabled}
              onClick={toggleMobileControl}
              disabled={mobileAction.status === 'loading' || mobileAction.status === 'busy'}
              className={`flex items-center gap-3 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-45 ${
                mobileEnabled
                  ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/14 text-[#d8fffb] hover:border-[#6ee7d8]/75 hover:bg-[#6ee7d8]/18'
                  : 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
              }`}
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  mobileEnabled ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
                }`}
                aria-hidden="true"
              >
                <span
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
                    mobileEnabled ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </span>
              <span>{mobileEnabled ? 'Enabled' : 'Disabled'}</span>
            </button>
          </div>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${
            mobileAction.status === 'error'
              ? 'border-[#ff1a3d]/70 text-[#ffb3bf]'
              : mobileEnabled
                ? 'border-[#6ee7d8]/70 text-[#bff7f1]'
                : 'border-[#303139] text-[#9a9aa2]'
          }`}>
            {mobileAction.message}
          </div>

          {mobileState ? (
            <>
              <div className="grid gap-x-6 gap-y-3 border-y border-[#24252b] py-4 text-sm sm:grid-cols-3">
                <MobileMeta label="Relay" value={relayStatusLabel(mobileState.relayStatus)} tone={mobileState.relayStatus} />
                <MobileMeta label="Devices" value={`${activeDevices.length} active`} />
                <MobileMeta label="Session" value={mobileState.desktopRelaySessionId ? 'Relay session ready' : 'No relay session'} />
                <MobileMeta label="Relay URL" value={mobileState.relayUrl ?? 'Not configured'} />
                <MobileMeta label="Token TTL" value={formatNullableMobileDate(mobileState.relayTokenExpiresAt)} />
                <MobileMeta label="Reconnect" value={formatNullableMobileDate(mobileState.nextReconnectAt)} />
              </div>

              <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                      Pairing
                    </div>
                    <button
                      type="button"
                      onClick={requestPairingCode}
                      disabled={!mobileEnabled || mobileAction.status === 'busy'}
                      className="rounded-md bg-[#6ee7d8]/14 px-3 py-1.5 text-sm font-semibold text-[#d8fffb] transition-colors hover:bg-[#6ee7d8]/20 disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#6ee7d8]/14"
                    >
                      New Code
                    </button>
                  </div>
                  {pairingChallenge ? (
                    <div className="rounded-md border border-[#303139] bg-[#0d0e11] p-3">
                      <div className="font-mono text-2xl font-semibold tracking-[0.12em] text-[#ececee]">
                        {pairingChallenge.pairingCode}
                      </div>
                      <div className="mt-2 text-[12px] leading-5 text-[#9a9aa2] [overflow-wrap:anywhere]">
                        {pairingChallenge.pairingUri}
                      </div>
                      <div className="mt-2 text-[11px] text-[#5a5a63]">
                        Expires {formatMobileDate(pairingChallenge.expiresAt)}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-3 text-[12px] leading-5 text-[#5a5a63]">
                      Mobile control is disabled by default. Enable it before creating a short-lived pairing code.
                    </div>
                  )}
                </div>

                <div>
                  <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                    Presence
                  </div>
                  <div className="grid grid-cols-2 gap-1">
                    {presenceOptions.map((presence) => (
                      <button
                        key={presence}
                        type="button"
                        onClick={() => void publishPresence(presence)}
                        disabled={!mobileEnabled || mobileAction.status === 'busy'}
                        className={`rounded-md px-2.5 py-1.5 text-sm font-semibold capitalize transition-colors disabled:cursor-default disabled:opacity-45 ${
                          mobileState.presence === presence
                            ? 'bg-[#6ee7d8]/14 text-[#d8fffb]'
                            : 'bg-[#0d0e11] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
                        }`}
                      >
                        {presence}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 text-[11px] text-[#5a5a63]">
                    Last changed {formatNullableMobileDate(mobileState.lastPresenceAt)}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                    Paired Devices
                  </div>
                  {revokedDevices.length > 0 ? (
                    <span className="text-[11px] text-[#5a5a63]">{revokedDevices.length} revoked</span>
                  ) : null}
                </div>
                {activeDevices.length > 0 ? (
                  <div className="divide-y divide-[#24252b] border-y border-[#24252b]">
                    {activeDevices.map((device) => (
                      <div key={device.deviceId} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-[#ececee]">{device.displayName}</div>
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#5a5a63]">
                            <span>{device.platform}</span>
                            <span>{device.appVersion}</span>
                            <span>Paired {formatMobileDate(device.pairedAt)}</span>
                            <span>Last seen {formatNullableMobileDate(device.lastSeenAt)}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void revokeDevice(device)}
                          disabled={!mobileEnabled || revokingDeviceId === device.deviceId}
                          className="rounded-md px-3 py-1.5 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#ff1a3d]/10 hover:text-[#ffb3bf] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-[#d7d7dc]"
                        >
                          {revokingDeviceId === device.deviceId ? 'Revoking...' : 'Revoke'}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-3 text-[12px] text-[#5a5a63]">
                    No active paired devices.
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                    Diagnostics
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshMobileDiagnostics()}
                    className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[#9a9aa2] transition-colors hover:bg-[#17181d] hover:text-[#ececee]"
                  >
                    {showMobileDiagnostics ? 'Refresh' : 'Show'}
                  </button>
                </div>
                {latestDiagnostics.length > 0 ? (
                  <div className="space-y-2">
                    {latestDiagnostics.map((entry) => (
                      <div key={entry.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 text-[12px] leading-5">
                        <span className={`mt-2 h-1.5 w-1.5 rounded-full ${diagnosticDotClass(entry.level)}`} aria-hidden="true" />
                        <div className="min-w-0">
                          <div className="text-[#d7d7dc]">{entry.message}</div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#5a5a63]">
                            <span>{entry.code}</span>
                            <span>{formatMobileDate(entry.timestamp)}</span>
                            {entry.retryable ? <span>Retryable</span> : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-[#5a5a63]">No mobile diagnostics recorded.</div>
                )}
              </div>
            </>
          ) : null}
        </div>

        <div className="mt-6 flex justify-end">
          <button
            onClick={closeSettings}
            className="rounded border border-[#303139] bg-[#111216] px-4 py-1.5 text-sm font-medium text-[#ececee] transition-colors hover:bg-[#17181d]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function MobileMeta({
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
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className={`mt-1 truncate font-medium ${mobileMetaToneClass(tone)}`}>{value}</div>
    </div>
  )
}

function mobileStatusMessage(state: MobileBridgeState): string {
  if (!state.enabled) return 'Mobile companion control is off. Desktop swarm behavior remains local-only.'
  if (state.relayStatus === 'connected') return 'Mobile companion control is enabled and connected to the relay.'
  if (state.relayStatus === 'unconfigured') return 'Mobile control is enabled, but no relay URL is configured.'
  return `Mobile companion control is enabled. Relay status: ${relayStatusLabel(state.relayStatus)}.`
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

function mobileMetaToneClass(tone?: MobileBridgeRelayStatus): string {
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
      return 'bg-[#6ee7d8]'
  }
}

function formatNullableMobileDate(value: string | null | undefined): string {
  return value ? formatMobileDate(value) : 'None'
}

function formatMobileDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
