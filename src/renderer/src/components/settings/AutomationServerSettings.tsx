import { useCallback, useEffect, useState } from 'react'

import type { AutomationServerStatus } from '../../../../shared/automation'
import { STUDIO_MCP_SERVER_NAME } from '../../../../shared/product-identity'
import { InlineNotice } from '../ui'
import { SettingsSectionTitle } from './SettingsAtoms'

// Settings → MCPs: read-only diagnostics for the always-on SprintEngine Studio
// MCP gateway. Studio agents receive it automatically; the bridge command is
// retained for external local MCP clients.

export function AutomationServerSettings() {
  const [status, setStatus] = useState<AutomationServerStatus | null>(null)

  const refresh = useCallback(async () => {
    if (typeof window.api.automationGetStatus !== 'function') return
    try {
      setStatus(await window.api.automationGetStatus())
    } catch {
      // Status stays unknown; the diagnostics section does not render.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!status) return null

  return (
    <section className="space-y-2">
      <SettingsSectionTitle>Automation</SettingsSectionTitle>
      <div className="space-y-1 text-body leading-5 text-[color:var(--text-muted)]">
        <div className="font-medium text-[color:var(--text-default)]">{STUDIO_MCP_SERVER_NAME}</div>
        <div>
          Always enabled for Studio-launched agents. It exposes app tools through an owner-only local socket; Sprint Engine's Python runtime still starts only when its module is enabled and a run needs it.
        </div>
      </div>
      {status.running && status.socketPath ? (
        <div className="space-y-1 text-body leading-5 text-[color:var(--text-muted)]">
          <div>
            Listening on <span className="font-mono text-[color:var(--text-default)]">{status.socketPath}</span>
          </div>
          {status.bridgeScriptPath ? (
            <div>
              Connect a stdio MCP client (Claude Code, Codex) through the bridge script:{' '}
              <span className="break-all font-mono text-[color:var(--text-default)]">
                claude mcp add sprintengine-studio -- node &quot;{status.bridgeScriptPath}&quot;
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {status.lastError ? (
        <InlineNotice tone="error">{status.lastError}</InlineNotice>
      ) : null}
    </section>
  )
}
