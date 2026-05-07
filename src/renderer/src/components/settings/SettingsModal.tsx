import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'

interface Props {
  onClose: () => void
  checkForUpdatesOnOpen?: boolean
}

type MetaTone = 'positive' | 'muted'

type UpdateAction = 'check' | 'download' | 'restart'

function parseSearchExcludeText(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((pattern) => pattern.trim())
    .filter(Boolean)
}

function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function normalizePathParts(value: string): { drive: string | null; parts: string[] } {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/u, '')
  const driveMatch = normalized.match(/^([A-Za-z]:)\/(.*)$/)
  if (driveMatch) {
    return {
      drive: driveMatch[1].toLowerCase(),
      parts: driveMatch[2].split('/').filter(Boolean),
    }
  }
  return {
    drive: null,
    parts: normalized.split('/').filter(Boolean),
  }
}

function relativePathBetween(fromPath: string, toPath: string): string | null {
  const from = normalizePathParts(fromPath)
  const to = normalizePathParts(toPath)
  if (from.drive !== to.drive) return null

  let common = 0
  while (
    common < from.parts.length
    && common < to.parts.length
    && from.parts[common].toLowerCase() === to.parts[common].toLowerCase()
  ) {
    common += 1
  }

  return [
    ...from.parts.slice(common).map(() => '..'),
    ...to.parts.slice(common),
  ].join('/') || '.'
}

export default function SettingsModal({ onClose, checkForUpdatesOnOpen = false }: Props) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  const activeWorkspace = useWorkspaceStore((s) =>
    s.workspaces.find((workspace) => workspace.id === s.activeWorkspaceId) ?? null
  )
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const searchExcludes = useWorkspaceStore((s) => s.appSettings.searchExcludes ?? [])
  const usageTelemetry = useWorkspaceStore((s) => s.appSettings.usageTelemetry)
  const setCliRuntime = useWorkspaceStore((s) => s.setCliRuntime)
  const setSearchExcludes = useWorkspaceStore((s) => s.setSearchExcludes)
  const setUsageTelemetrySettings = useWorkspaceStore((s) => s.setUsageTelemetrySettings)
  const setWorkspaceMemoryRelativeRoot = useWorkspaceStore((s) => s.setWorkspaceMemoryRelativeRoot)
  const isWindows = window.api.platform === 'win32'
  const [searchExcludesDraft, setSearchExcludesDraft] = useState(() => searchExcludes.join('\n'))
  const [memoryDraft, setMemoryDraft] = useState(() => activeWorkspace?.memory.relativeRoot ?? '')
  const [memoryStatus, setMemoryStatus] = useState<MemoryRootStatus | null>(null)
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null)
  const [updateActionPending, setUpdateActionPending] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const autoCheckStartedRef = useRef(false)

  const commitMemoryDraft = useCallback((value: string) => {
    if (!activeWorkspaceId) return
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/u, '')
    setWorkspaceMemoryRelativeRoot(activeWorkspaceId, trimmed || null)
  }, [activeWorkspaceId, setWorkspaceMemoryRelativeRoot])

  const closeSettings = useCallback(() => {
    setSearchExcludes(parseSearchExcludeText(searchExcludesDraft))
    commitMemoryDraft(memoryDraft)
    onClose()
  }, [commitMemoryDraft, memoryDraft, onClose, searchExcludesDraft, setSearchExcludes])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.focus()
    return () => previous?.focus()
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  useEffect(() => {
    setSearchExcludesDraft(searchExcludes.join('\n'))
  }, [searchExcludes])

  useEffect(() => {
    setMemoryDraft(activeWorkspace?.memory.relativeRoot ?? '')
  }, [activeWorkspace?.id, activeWorkspace?.memory.relativeRoot])

  useEffect(() => {
    let cancelled = false
    void window.api.updateGetState().then((state) => {
      if (!cancelled) setUpdateState(state)
    })
    const unsubscribe = window.api.onUpdateStateChanged((state) => setUpdateState(state))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const checkForUpdates = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateCheck()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [])

  useEffect(() => {
    if (!checkForUpdatesOnOpen || autoCheckStartedRef.current) return
    autoCheckStartedRef.current = true
    void checkForUpdates()
  }, [checkForUpdates, checkForUpdatesOnOpen])

  const downloadUpdate = useCallback(async () => {
    setUpdateActionPending(true)
    try {
      const result = await window.api.updateDownload()
      setUpdateState(result.state)
    } finally {
      setUpdateActionPending(false)
    }
  }, [])

  const restartToInstall = useCallback(async () => {
    const result = await window.api.updateQuitAndInstall()
    setUpdateState(result.state)
  }, [])

  useEffect(() => {
    let cancelled = false
    const relativeRoot = memoryDraft.trim()
    if (!activeWorkspaceId || !relativeRoot) {
      setMemoryStatus(null)
      return
    }
    if (isAbsolutePath(relativeRoot)) {
      setMemoryStatus({
        ok: false,
        status: 'invalid-relative-path',
        relativeRoot: null,
        message: 'Memory path must be relative to the workspace folder.',
      })
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.memoryResolveRoot({
        workspaceRoot: activeWorkspace?.folderPath ?? null,
        relativeRoot,
      }).then((status) => {
        if (!cancelled) setMemoryStatus(status)
      }).catch((error) => {
        if (!cancelled) {
          setMemoryStatus({
            ok: false,
            status: 'inaccessible',
            relativeRoot,
            message: error instanceof Error ? error.message : 'Unable to check memory path.',
          })
        }
      })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeWorkspace?.folderPath, activeWorkspaceId, memoryDraft])

  const chooseMemoryFolder = async () => {
    if (!activeWorkspace?.folderPath || !activeWorkspaceId) return
    const dir = await window.api.openDir()
    if (!dir) return
    const relativePath = relativePathBetween(activeWorkspace.folderPath, dir)
    if (!relativePath || relativePath === '.') {
      setMemoryStatus({
        ok: false,
        status: 'invalid-relative-path',
        relativeRoot: null,
        message: 'Choose a folder that can be expressed relative to the workspace folder.',
      })
      return
    }
    setMemoryDraft(relativePath)
    setWorkspaceMemoryRelativeRoot(activeWorkspaceId, relativePath)
  }

  const nextUpdateAction: UpdateAction = updateState?.downloaded
    ? 'restart'
    : updateState?.status === 'available'
      ? 'download'
      : 'check'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && closeSettings()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        tabIndex={-1}
        className="max-h-[92vh] w-[760px] max-w-[95vw] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] p-6 shadow-2xl outline-none"
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 id="settings-modal-title" className="text-base font-semibold text-[#ececee]">Settings</h2>
            <p className="mt-0.5 text-sm text-[#5a5a63]">Configure local CLIs, workspace paths, and usage telemetry.</p>
          </div>
          <button
            type="button"
            onClick={closeSettings}
            aria-label="Close settings"
            className="rounded text-xl leading-none text-[#5a5a63] transition-colors hover:text-[#d7d7dc] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7d8]/60"
          >
            ×
          </button>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Application Updates
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Multicode {updateState?.version ?? '...'}
              </div>
            </div>
            <div className={`rounded-md border px-2.5 py-1 text-[11px] font-semibold ${updateChannelClass(updateState?.channel)}`}>
              {formatUpdateChannel(updateState?.channel)}
            </div>
          </div>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${updateStatusClass(updateState?.status)}`}>
            {formatUpdateStatus(updateState)}
            {updateState?.progress ? (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#24252b]">
                <div
                  className="h-full rounded-full bg-[#6ee7d8]"
                  style={{ width: `${Math.max(0, Math.min(100, updateState.progress.percent))}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="button"
              onClick={() => void window.api.updateOpenReleaseNotes()}
              className="text-sm font-semibold text-[#bff7f1] transition-colors hover:text-[#e0fffb] focus:outline-none focus-visible:underline"
            >
              Release notes
            </button>
            <UpdateActionButton
              label="Check"
              primary={nextUpdateAction === 'check'}
              onClick={() => void checkForUpdates()}
              disabled={updateActionPending || updateState?.status === 'checking' || updateState?.status === 'downloading'}
            />
            <UpdateActionButton
              label="Download"
              primary={nextUpdateAction === 'download'}
              onClick={() => void downloadUpdate()}
              disabled={updateActionPending || updateState?.status !== 'available'}
            />
            <UpdateActionButton
              label="Restart"
              primary={nextUpdateAction === 'restart'}
              onClick={() => void restartToInstall()}
              disabled={!updateState?.downloaded}
            />
          </div>

          <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
            <MetaCell label="Update version" value={updateState?.updateVersion ?? 'None'} />
            <MetaCell label="Last checked" value={formatNullableDate(updateState?.lastCheckedAt)} />
          </div>
        </div>

        <div className="mt-6 space-y-4 border-t border-[#24252b] pt-6">
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
                <SettingToggle
                  label={`Run ${cli === 'codex' ? 'Codex' : 'Claude'} through WSL`}
                  enabled={cliRuntimes[cli].useWsl}
                  onChange={(enabled) => setCliRuntime(cli, { useWsl: enabled })}
                />
              )}
            </div>
          ))}
          <p className="text-[12px] leading-5 text-[#5a5a63]">
            Defaults are <span className="font-mono text-[#d7d7dc]">codex</span> native and{' '}
            <span className="font-mono text-[#d7d7dc]">claude</span>{isWindows ? ' through WSL' : ''}.
            Use a full executable path if your CLI is not on PATH.
          </p>
        </div>

        <div className="mt-6 space-y-4 border-t border-[#24252b] pt-6">
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
          <p className="text-[12px] leading-5 text-[#5a5a63]">
            Defaults still exclude heavy folders like <span className="font-mono text-[#d7d7dc]">.git</span>,{' '}
            <span className="font-mono text-[#d7d7dc]">node_modules</span>, and{' '}
            <span className="font-mono text-[#d7d7dc]">dist</span>. Add one pattern per line or separate entries with commas.
          </p>
        </div>

        <div className="mt-6 space-y-4 border-t border-[#24252b] pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Workspace Memory
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                Markdown knowledge graph
              </div>
            </div>
            {activeWorkspace ? (
              <div className="max-w-[260px] truncate rounded-md border border-[#24252b] bg-[#0d0e11] px-2.5 py-1 text-[11px] text-[#9a9aa2]">
                {activeWorkspace.name}
              </div>
            ) : null}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9a9aa2]">
              Memory folder
            </span>
            <div className="flex gap-2">
              <input
                value={memoryDraft}
                onChange={(event) => setMemoryDraft(event.target.value)}
                onBlur={(event) => commitMemoryDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur()
                  }
                }}
                placeholder="../ecosystem-memory"
                disabled={!activeWorkspace}
                className="h-9 min-w-0 flex-1 rounded-md border border-[#303139] bg-[#0d0e11] px-3 font-mono text-sm text-[#ececee] outline-none transition-colors placeholder:text-[#5a5a63] focus:border-[#6ee7d8]/70 disabled:opacity-45"
              />
              <button
                type="button"
                onClick={() => void chooseMemoryFolder()}
                disabled={!activeWorkspace?.folderPath}
                className="h-9 rounded-md border border-[#303139] bg-[#0d0e11] px-3 text-sm font-semibold text-[#d7d7dc] transition-colors hover:bg-[#17181d] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-[#0d0e11]"
              >
                Choose
              </button>
            </div>
          </label>

          <div className={`border-l-2 pl-3 text-[12px] leading-5 ${
            memoryStatus?.ok
              ? 'border-[#6ee7d8]/70 text-[#bff7f1]'
              : memoryStatus
                ? 'border-[#ffbf2f]/75 text-[#ffd58a]'
                : 'border-[#303139] text-[#9a9aa2]'
          }`}>
            {memoryStatus?.ok
              ? `Ready: ${memoryStatus.relativeRoot}`
              : memoryStatus
                ? `${memoryStatus.message} Do not guess another folder.`
                : activeWorkspace?.folderPath
                  ? 'Set a relative path from the workspace folder. Leave empty to disable memory for this workspace.'
                  : 'Open a workspace folder before configuring memory.'}
          </div>
        </div>

        <div className="mt-6 space-y-4 border-t border-[#24252b] pt-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#5a5a63]">
                Usage Telemetry
              </div>
              <div className="mt-1 text-sm font-semibold text-[#ececee]">
                SprintEngine usage data and diagnostics
              </div>
            </div>
            <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-2.5 py-1 text-[11px] font-semibold text-[#9a9aa2]">
              {import.meta.env.DEV ? 'Development build' : 'Production build'}
            </div>
          </div>

          <div className="divide-y divide-[#24252b]">
            <SettingToggle
              label="Send usage data"
              description="Upload sanitized SprintEngine usage records only after explicit consent. This stays off by default for production builds."
              enabled={usageTelemetry.sendUsageData}
              onChange={(enabled) => setUsageTelemetrySettings({ sendUsageData: enabled })}
            />
            <SettingToggle
              label="Local dev export"
              description="Write sanitized JSONL records to the sibling admin portal during local development. This can default on only in development builds."
              enabled={usageTelemetry.localDevExportEnabled}
              onChange={(enabled) => setUsageTelemetrySettings({ localDevExportEnabled: enabled })}
            />
            <SettingToggle
              label="Export diagnostics"
              description="Include privacy-safe exporter and upload diagnostics so missing, rejected, or duplicated records can be investigated."
              enabled={usageTelemetry.exportDiagnostics}
              onChange={(enabled) => setUsageTelemetrySettings({ exportDiagnostics: enabled })}
            />
          </div>

          <p className="text-[12px] leading-5 text-[#9a9aa2]">
            Raw source, prompts, transcripts, artifact bodies, descriptions, notes, and file contents are not collected by default.
            Production upload is separate from local export and remains disabled until you turn on Send usage data.
          </p>

          <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
            <MetaCell label="Last local export" value={formatNullableDate(usageTelemetry.lastExportAt)} />
            <MetaCell
              label="Upload consent"
              value={usageTelemetry.sendUsageData ? 'Enabled' : 'Disabled'}
              tone={usageTelemetry.sendUsageData ? 'positive' : undefined}
            />
          </div>
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

function UpdateActionButton({
  label,
  primary,
  onClick,
  disabled,
}: {
  label: string
  primary: boolean
  onClick: () => void
  disabled?: boolean
}) {
  const base = 'rounded-md px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-default disabled:opacity-45 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7d8]/60'
  const tone = primary
    ? 'bg-[#6ee7d8]/14 text-[#d8fffb] hover:bg-[#6ee7d8]/18 disabled:hover:bg-[#6ee7d8]/14'
    : 'border border-[#303139] bg-[#0d0e11] text-[#d7d7dc] hover:bg-[#17181d] disabled:hover:bg-[#0d0e11]'
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={`${base} ${tone}`}>
      {label}
    </button>
  )
}

function SettingToggle({
  label,
  description,
  enabled,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  enabled: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[#ececee]">{label}</div>
        {description ? (
          <div className="mt-1 text-[12px] leading-5 text-[#5a5a63]">{description}</div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#6ee7d8]/60 disabled:opacity-45 ${
          enabled ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
        }`}
      >
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full transition-transform ${
            enabled ? 'translate-x-4 bg-[#061210]' : 'translate-x-0 bg-[#d7d7dc]'
          }`}
        />
      </button>
    </div>
  )
}

function MetaCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: MetaTone
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.14em] text-[#5a5a63]">{label}</div>
      <div className={`mt-1 truncate font-medium ${metaToneClass(tone)}`}>{value}</div>
    </div>
  )
}

function metaToneClass(tone?: MetaTone): string {
  switch (tone) {
    case 'positive':
      return 'text-[#b9f7c8]'
    case 'muted':
      return 'text-[#9a9aa2]'
    default:
      return 'text-[#ececee]'
  }
}

function formatUpdateChannel(channel: AppUpdateState['channel'] | undefined): string {
  switch (channel) {
    case 'stable':
      return 'Stable'
    case 'preview':
      return 'Preview'
    case 'dev':
      return 'Development'
    default:
      return 'Unknown'
  }
}

function updateChannelClass(channel: AppUpdateState['channel'] | undefined): string {
  switch (channel) {
    case 'stable':
      return 'border-[#6ee7d8]/35 bg-[#6ee7d8]/10 text-[#bff7f1]'
    case 'preview':
      return 'border-[#ffbf2f]/35 bg-[#ffbf2f]/10 text-[#ffe0a3]'
    case 'dev':
      return 'border-[#7785ff]/35 bg-[#7785ff]/10 text-[#d7dcff]'
    default:
      return 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2]'
  }
}

function updateStatusClass(status: AppUpdateState['status'] | undefined): string {
  switch (status) {
    case 'available':
    case 'downloaded':
      return 'border-[#6ee7d8]/70 text-[#bff7f1]'
    case 'checking':
    case 'downloading':
      return 'border-[#ffbf2f]/75 text-[#ffd58a]'
    case 'error':
      return 'border-[#ff787c] text-[#ffb3b5]'
    default:
      return 'border-[#303139] text-[#9a9aa2]'
  }
}

function formatUpdateStatus(state: AppUpdateState | null): string {
  if (!state) return 'Loading update status.'
  if (!state.packaged) return 'Update checks are available after installing a packaged build.'
  switch (state.status) {
    case 'checking':
      return 'Checking for updates.'
    case 'available':
      return state.updateVersion ? `Multicode ${state.updateVersion} is available.` : 'An update is available.'
    case 'downloading':
      return state.progress ? `Downloading update (${Math.round(state.progress.percent)}%).` : 'Downloading update.'
    case 'downloaded':
      return 'Update downloaded. Restart Multicode to install it.'
    case 'not_available':
      return 'Multicode is up to date.'
    case 'error':
      return state.errorMessage ?? 'Update check failed.'
    default:
      return 'No update check is running.'
  }
}

function formatNullableDate(value: string | null | undefined): string {
  return value ? formatDate(value) : 'None'
}

function formatDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
