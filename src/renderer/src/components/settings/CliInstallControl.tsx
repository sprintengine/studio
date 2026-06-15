import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  CliDetectResult,
  CliInstallMethodInfo,
  CliInstallResult,
} from '../../../../shared/electron-api'
import { GhostButton, PrimaryButton, Select, Spinner, StatusDot, type SelectItem } from '../ui'

export type CliInstallControlProps = {
  cli: string
  displayName: string
  binary: string
  command: string
  useWsl: boolean
  // Called after a successful install so the parent can persist the resolved
  // binary path (e.g. into cliRuntimes) and refresh any catalogs.
  onInstalled?: (result: CliInstallResult) => void
}

// Detect-and-install control for a single agent CLI. Reused by the onboarding
// "Set up an agent CLI" step and the Settings → Agents per-CLI rows. Detection
// and install run in the main process against the same command/WSL mode the
// agent will launch with; install output streams live into the log.
export function CliInstallControl({
  cli,
  displayName,
  binary,
  command,
  useWsl,
  onInstalled,
}: CliInstallControlProps) {
  const [detect, setDetect] = useState<CliDetectResult | null>(null)
  const [detecting, setDetecting] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [methods, setMethods] = useState<CliInstallMethodInfo[] | null>(null)
  const [selectedMethodId, setSelectedMethodId] = useState<string>('')
  const [installing, setInstalling] = useState(false)
  const [log, setLog] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const runDetect = useCallback(async () => {
    setDetecting(true)
    try {
      const result = await window.api.cliDetect(cli, { command, useWsl })
      if (mountedRef.current) setDetect(result)
    } finally {
      if (mountedRef.current) setDetecting(false)
    }
  }, [cli, command, useWsl])

  // Re-detect whenever the CLI or its command/WSL override changes.
  useEffect(() => {
    void runDetect()
  }, [runDetect])

  const openInstall = useCallback(async () => {
    setExpanded(true)
    setInstallError(null)
    setMethods(null)
    const available = await window.api.cliInstallMethods(cli, { command, useWsl })
    if (!mountedRef.current) return
    setMethods(available)
    const preferred =
      available.find((method) => method.recommended && method.available) ??
      available.find((method) => method.available) ??
      available[0]
    setSelectedMethodId(preferred?.id ?? '')
  }, [cli, command, useWsl])

  const runInstall = useCallback(async () => {
    if (!selectedMethodId) return
    setInstalling(true)
    setInstallError(null)
    setLog('')
    const unsubscribe = window.api.onCliInstallOutput(cli, (chunk) => {
      if (mountedRef.current) setLog((prev) => prev + chunk)
    })
    try {
      const result = await window.api.cliInstall({ cli, methodId: selectedMethodId }, { command, useWsl })
      if (!mountedRef.current) return
      if (result.installed) {
        setDetect({
          cli,
          binary,
          installed: true,
          version: result.version,
          resolvedPath: result.resolvedPath,
          useWsl,
          error: null,
        })
        setExpanded(false)
        onInstalled?.(result)
      } else {
        setInstallError(result.error ?? 'Install did not complete. See the log above.')
      }
    } catch (error) {
      if (mountedRef.current) {
        setInstallError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      unsubscribe()
      if (mountedRef.current) setInstalling(false)
    }
  }, [cli, binary, command, useWsl, selectedMethodId, onInstalled])

  const installed = detect?.installed === true
  const methodItems: SelectItem[] = (methods ?? []).map((method) => ({
    value: method.id,
    label: method.available ? method.label : `${method.label} — ${method.unavailableReason ?? 'unavailable'}`,
    disabled: !method.available,
  }))
  const selectedMethod = (methods ?? []).find((method) => method.id === selectedMethodId) ?? null

  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {detecting ? (
            <Spinner className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
          ) : (
            <StatusDot tone={installed ? 'good' : 'warn'} />
          )}
          <span className="truncate text-[12px] text-[color:var(--text-default)]">
            {detecting
              ? `Checking for ${binary}…`
              : installed
                ? `${displayName} detected${detect?.version ? ` · ${detect.version}` : ''}`
                : `${displayName} not found`}
          </span>
        </div>
        {!detecting && (
          <div className="flex shrink-0 items-center gap-2">
            <GhostButton
              size="sm"
              onClick={() => void runDetect()}
              className="h-7 border border-[color:var(--border-default)] text-[color:var(--text-default)]"
            >
              Re-check
            </GhostButton>
            {!installed && !expanded && (
              <PrimaryButton size="sm" onClick={() => void openInstall()} className="h-7">
                Install
              </PrimaryButton>
            )}
          </div>
        )}
      </div>

      {installed && detect?.resolvedPath && (
        <div className="mt-1 pl-6 font-mono text-[11px] text-[color:var(--text-subtle)] truncate">
          {detect.resolvedPath}
        </div>
      )}

      {expanded && !installed && (
        <div className="mt-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-3">
          {methods === null ? (
            <div className="flex items-center gap-2 text-[12px] text-[color:var(--text-muted)]">
              <Spinner className="icon-sm" /> Loading install options…
            </div>
          ) : methods.length === 0 ? (
            <p className="text-[12px] leading-5 text-[color:var(--text-muted)]">
              No automatic installer is available for {displayName} on this platform. Install{' '}
              <span className="font-mono text-[color:var(--text-default)]">{binary}</span> manually, then
              set its path in the command field above.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  ariaLabel={`${displayName} install method`}
                  items={methodItems}
                  value={selectedMethodId || null}
                  onChange={setSelectedMethodId}
                  disabled={installing}
                  className="min-w-[220px]"
                />
                <PrimaryButton
                  size="sm"
                  onClick={() => void runInstall()}
                  disabled={installing || !selectedMethod?.available}
                  className="h-8"
                >
                  {installing ? 'Installing…' : 'Run install'}
                </PrimaryButton>
                {!installing && (
                  <GhostButton
                    size="sm"
                    onClick={() => setExpanded(false)}
                    className="h-8 text-[color:var(--text-muted)]"
                  >
                    Cancel
                  </GhostButton>
                )}
              </div>

              {selectedMethod && (
                <div className="mt-2">
                  <div className="mb-1 text-[11px] text-[color:var(--text-subtle)]">
                    Multicode will run this command:
                  </div>
                  <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-[11px] text-[color:var(--text-default)]">
                    {selectedMethod.commandPreview}
                  </pre>
                </div>
              )}

              {(installing || log) && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-[11px] leading-[1.5] text-[color:var(--text-muted)]">
                  {log || 'Starting…'}
                </pre>
              )}

              {installError && (
                <p className="mt-2 text-[11px] leading-5 text-[color:var(--tone-error)]">{installError}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
