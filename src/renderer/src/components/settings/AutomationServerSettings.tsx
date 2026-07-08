import { useCallback, useEffect, useState } from 'react'

import type { AutomationServerStatus } from '../../../../shared/automation'
import { SettingToggle, SettingsSectionTitle } from './SettingsAtoms'

// Settings → MCPs: the app-automation MCP server toggle (T10 minimal wiring;
// migrates onto the module settings-section API when T6 lands). Off by
// default; the server listens on a local socket only, so the visible socket
// path doubles as the connection instruction for external MCP clients.

export function AutomationServerSettings() {
  const [status, setStatus] = useState<AutomationServerStatus | null>(null)
  const [pending, setPending] = useState(false)

  const refresh = useCallback(async () => {
    if (typeof window.api.automationGetStatus !== 'function') return
    try {
      setStatus(await window.api.automationGetStatus())
    } catch {
      // Status stays unknown; the toggle simply does not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setEnabled = useCallback(async (enabled: boolean) => {
    setPending(true)
    try {
      setStatus(await window.api.automationSetEnabled(enabled))
    } finally {
      setPending(false)
    }
  }, [])

  if (!status) return null

  return (
    <section className="space-y-2">
      <SettingsSectionTitle>Automation</SettingsSectionTitle>
      <SettingToggle
        label="Local automation server"
        description="Lets local MCP clients create workspaces, launch agents, and read status in this app. Local socket only, off by default."
        enabled={status.enabled}
        disabled={pending}
        onChange={(next) => void setEnabled(next)}
      />
      {status.running && status.socketPath ? (
        <div className="space-y-1 text-[12px] leading-5 text-[color:var(--text-muted)]">
          <div>
            Listening on <span className="font-mono text-[color:var(--text-default)]">{status.socketPath}</span>
          </div>
          {status.bridgeScriptPath ? (
            <div>
              Connect a stdio MCP client (Claude Code, Codex) through the bridge script:{' '}
              <span className="font-mono text-[color:var(--text-default)]">
                claude mcp add multicode -- node {status.bridgeScriptPath}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {status.lastError ? (
        <div className="border-l-2 border-[color:var(--tone-error)] pl-3 text-[12px] leading-5 text-[color:var(--tone-error)]">
          {status.lastError}
        </div>
      ) : null}
    </section>
  )
}
