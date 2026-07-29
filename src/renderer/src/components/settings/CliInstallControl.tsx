import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  CliDetectResult,
  CliInstallMethodInfo,
  CliInstallResult,
} from '../../../../shared/electron-api'
import { GhostButton, LifecycleGlyph, PrimaryButton, Select, Spinner, type SelectItem } from '../ui'

export type CliInstallControlProps = {
  cli: string
  displayName: string
  binary: string
  command: string
  useWsl: boolean
  // Called after a successful install so the parent can persist the resolved
  // binary path (e.g. into cliRuntimes) and refresh any catalogs.
  onInstalled?: (result: CliInstallResult) => void
  // When false, the status text drops the CLI name (the surrounding row already
  // names it). Onboarding leaves it true since the control is the only label.
  showName?: boolean
  // When false, the control renders no status glyph, status text, or resolved
  // path — only its actions and the install flow. Hosts that wrap it in a
  // `ProviderRow` pass false: the row's health dot, mono version, and state line
  // already carry all three, and repeating them under the row is the same fact
  // twice in two vocabularies.
  showStatus?: boolean
  // When true (and the CLI is not installed), open the install method picker on
  // mount. Lets a parent's "Install" affordance jump straight into the flow.
  autoOpenInstall?: boolean
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
  showName = true,
  showStatus = true,
  autoOpenInstall = false,
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

  // Honor a parent's request to jump straight into the install flow once the
  // probe confirms the CLI is missing. Runs once per arming.
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (!autoOpenInstall) {
      autoOpenedRef.current = false
      return
    }
    if (autoOpenedRef.current || detecting || detect?.installed) return
    autoOpenedRef.current = true
    void openInstall()
  }, [autoOpenInstall, detecting, detect, openInstall])

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
  const versionSuffix = detect?.version ? ` · ${detect.version}` : ''
  // The surrounding row names the CLI when showName is false, so the status
  // text stays terse ("Detected · 1.2.3") instead of repeating the name.
  const statusText = detecting
    ? showName
      ? `Checking for ${binary}…`
      : 'Detecting…'
    : installed
      ? showName
        ? `${displayName} detected${versionSuffix}`
        : `Detected${versionSuffix}`
      : showName
        ? `${displayName} not found`
        : 'Not found'
  const methodItems: SelectItem[] = (methods ?? []).map((method) => ({
    value: method.id,
    label: method.available ? method.label : `${method.label} — ${method.unavailableReason ?? 'unavailable'}`,
    disabled: !method.available,
  }))
  const selectedMethod = (methods ?? []).find((method) => method.id === selectedMethodId) ?? null

  return (
    <div className={showStatus ? 'py-2.5' : ''}>
      <div className="flex items-center justify-between gap-3">
        {showStatus ? (
          <div className="flex min-w-0 items-center gap-2">
            {detecting ? (
              <Spinner className="icon-sm shrink-0 text-[color:var(--text-muted)]" />
            ) : (
              // Status reads by shape, not a bare dot: a quiet check when the CLI
              // is present, the warn "!" when it is missing. The adjacent text
              // names the state, so the glyph never carries meaning by colour alone.
              <LifecycleGlyph
                state={installed ? 'done' : 'needs_input'}
                label={installed ? `${displayName} detected` : `${displayName} not found`}
              />
            )}
            <span className="truncate text-body text-[color:var(--text-default)]">
              {statusText}
            </span>
          </div>
        ) : null}
        {!detecting && (
          <div className="flex shrink-0 items-center gap-2">
            <GhostButton
              size="sm"
              onClick={() => void runDetect()}
              className="h-control-sm border border-[color:var(--border-default)] text-[color:var(--text-default)]"
            >
              Re-check
            </GhostButton>
            {!installed && !expanded && (
              <PrimaryButton size="sm" onClick={() => void openInstall()} className="h-control-sm">
                Install
              </PrimaryButton>
            )}
          </div>
        )}
      </div>

      {showStatus && installed && detect?.resolvedPath && (
        <div className="mt-1 pl-6 font-mono text-meta text-[color:var(--text-subtle)] truncate">
          {detect.resolvedPath}
        </div>
      )}

      {expanded && !installed && (
        <div className="mt-2.5 rounded-[var(--radius-md)] border border-[color:var(--border-subtle)] p-3">
          {methods === null ? (
            <div className="flex items-center gap-2 text-body text-[color:var(--text-muted)]">
              <Spinner className="icon-sm" /> Loading install options…
            </div>
          ) : methods.length === 0 ? (
            <p className="text-body leading-5 text-[color:var(--text-muted)]">
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
                  className="h-control-md"
                >
                  {installing ? 'Installing…' : 'Run install'}
                </PrimaryButton>
                {!installing && (
                  <GhostButton
                    size="sm"
                    onClick={() => setExpanded(false)}
                    className="h-control-md text-[color:var(--text-muted)]"
                  >
                    Cancel
                  </GhostButton>
                )}
              </div>

              {selectedMethod && (
                <div className="mt-2">
                  <div className="mb-1 text-meta text-[color:var(--text-subtle)]">
                    Will run:
                  </div>
                  <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-meta text-[color:var(--text-default)]">
                    {selectedMethod.commandPreview}
                  </pre>
                </div>
              )}

              {(installing || log) && (
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[color:var(--bg-app)] px-2.5 py-1.5 font-mono text-meta leading-[1.5] text-[color:var(--text-muted)]">
                  {log || 'Starting…'}
                </pre>
              )}

              {installError && (
                <p className="mt-2 text-meta leading-5 text-[color:var(--tone-error)]">{installError}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
