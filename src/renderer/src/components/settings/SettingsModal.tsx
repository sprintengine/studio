import React, { useCallback, useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../store/workspaceStore'
import type { AgentCli } from '../../types/workspace'

interface Props {
  onClose: () => void
}

type MobileBridgeRelayStatus =
  | 'disabled'
  | 'unconfigured'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'error'

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

export default function SettingsModal({ onClose }: Props) {
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={(event) => event.target === event.currentTarget && closeSettings()}
    >
      <div className="max-h-[92vh] w-[760px] max-w-[95vw] overflow-y-auto rounded-xl border border-[#303139] bg-[#0d0e11] p-6 shadow-2xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#ececee]">Settings</h2>
            <p className="mt-0.5 text-sm text-[#5a5a63]">Configure local CLIs, workspace paths, and usage telemetry.</p>
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

        <div className="mt-4 space-y-4 rounded-lg border border-[#24252b] bg-[#111216] p-4">
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

          <div className="space-y-3">
            <UsageTelemetryToggle
              label="Send usage data"
              description="Upload sanitized sprintengine usage records only after explicit consent. This stays off by default for production builds."
              enabled={usageTelemetry.sendUsageData}
              onChange={(enabled) => setUsageTelemetrySettings({ sendUsageData: enabled })}
            />
            <UsageTelemetryToggle
              label="Local dev export"
              description="Write sanitized JSONL records to the sibling admin portal during local development. This can default on only in development builds."
              enabled={usageTelemetry.localDevExportEnabled}
              onChange={(enabled) => setUsageTelemetrySettings({ localDevExportEnabled: enabled })}
            />
            <UsageTelemetryToggle
              label="Export diagnostics"
              description="Include privacy-safe exporter and upload diagnostics so missing, rejected, or duplicated records can be investigated."
              enabled={usageTelemetry.exportDiagnostics}
              onChange={(enabled) => setUsageTelemetrySettings({ exportDiagnostics: enabled })}
            />
          </div>

          <div className="rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-2 text-[12px] leading-5 text-[#9a9aa2]">
            Raw source, prompts, transcripts, artifact bodies, descriptions, notes, and file contents are not collected by default.
            Production upload is separate from local export and remains disabled until you turn on Send usage data.
          </div>

          <div className="grid gap-x-6 gap-y-3 border-t border-[#24252b] pt-4 text-sm sm:grid-cols-2">
            <MobileMeta label="Last local export" value={formatNullableMobileDate(usageTelemetry.lastExportAt)} />
            <MobileMeta
              label="Upload consent"
              value={usageTelemetry.sendUsageData ? 'Enabled' : 'Disabled'}
              tone={usageTelemetry.sendUsageData ? 'connected' : 'disabled'}
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

function UsageTelemetryToggle({
  label,
  description,
  enabled,
  onChange,
}: {
  label: string
  description: string
  enabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <div className="grid gap-3 rounded-md border border-[#24252b] bg-[#0d0e11] px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-[#ececee]">{label}</div>
        <div className="mt-1 text-[12px] leading-5 text-[#5a5a63]">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
        className={`flex w-fit items-center gap-3 rounded-md border px-2.5 py-1.5 text-sm font-semibold transition-colors ${
          enabled
            ? 'border-[#6ee7d8]/55 bg-[#6ee7d8]/14 text-[#d8fffb] hover:border-[#6ee7d8]/75 hover:bg-[#6ee7d8]/18'
            : 'border-[#303139] bg-[#0d0e11] text-[#9a9aa2] hover:bg-[#17181d] hover:text-[#ececee]'
        }`}
      >
        <span
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
            enabled ? 'bg-[#6ee7d8]' : 'bg-[#303139]'
          }`}
          aria-hidden="true"
        >
          <span
            className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[#08090b] transition-transform ${
              enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </span>
        <span>{enabled ? 'Enabled' : 'Disabled'}</span>
      </button>
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

function formatNullableMobileDate(value: string | null | undefined): string {
  return value ? formatMobileDate(value) : 'None'
}

function formatMobileDate(value: string): string {
  const time = Date.parse(value)
  if (Number.isNaN(time)) return value
  return new Date(time).toLocaleString()
}
