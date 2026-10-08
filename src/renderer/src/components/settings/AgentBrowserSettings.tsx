import { useEffect, useState } from 'react'

import { useWorkspaceStore } from '../../store/workspaceStore'
import { SettingCard, SettingToggle, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Agents → Built-in browser: whether the agents get the browser at
// all, and how it shows itself to the person sitting beside them.

/**
 * "Let agents use the built-in browser". Main owns the value — it puts the
 * tools together and offers them — so it is read from main when the page
 * opens and every write answers with what main now holds. A client with no
 * such switch of its own (a browser tab) leaves the row out.
 */
function useAgentBrowserTools(): [boolean | null, (next: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    if (typeof window.api?.getAgentBrowserTools !== 'function') return
    let cancelled = false
    void window.api
      .getAgentBrowserTools()
      .then((next) => {
        if (!cancelled) setEnabled(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const change = (next: boolean) => {
    setEnabled(next)
    void window.api
      .setAgentBrowserTools(next)
      .then((held) => {
        if (held !== null) setEnabled(held)
      })
      .catch(() => setEnabled(!next))
  }
  return [enabled, change]
}

export function AgentBrowserSettings() {
  const autoFloat = useWorkspaceStore((s) => s.appSettings.browserAutoFloatAgentPreview)
  const setAutoFloat = useWorkspaceStore((s) => s.setBrowserAutoFloatAgentPreview)
  const [toolsEnabled, setToolsEnabled] = useAgentBrowserTools()
  return (
    <section className="space-y-3 pt-2" aria-labelledby="agent-browser-settings-title">
      <SettingsSectionTitle id="agent-browser-settings-title">Built-in browser</SettingsSectionTitle>
      <SettingCard>
        {toolsEnabled !== null ? (
          <SettingToggle
            label="Let agents use the built-in browser"
            description="Agents can open, read and click through pages in the pane's browser. Off, they are given no browser tools; an agent already running picks the change up in its next session."
            enabled={toolsEnabled}
            onChange={setToolsEnabled}
          />
        ) : null}
        <SettingToggle
          label="Show the page while an agent uses it"
          description="With the pane closed, a page an agent opens or drives floats in a corner over the chat. Close it to keep it out of the way while that agent works."
          enabled={autoFloat}
          disabled={toolsEnabled === false}
          onChange={setAutoFloat}
        />
      </SettingCard>
    </section>
  )
}
