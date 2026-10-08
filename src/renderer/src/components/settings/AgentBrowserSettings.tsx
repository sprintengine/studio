import { useWorkspaceStore } from '../../store/workspaceStore'
import { SettingCard, SettingToggle, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Agents → Built-in browser: how the browser the agents drive shows
// itself to the person sitting beside them.

export function AgentBrowserSettings() {
  const autoFloat = useWorkspaceStore((s) => s.appSettings.browserAutoFloatAgentPreview)
  const setAutoFloat = useWorkspaceStore((s) => s.setBrowserAutoFloatAgentPreview)
  return (
    <section className="space-y-3 pt-2" aria-labelledby="agent-browser-settings-title">
      <SettingsSectionTitle id="agent-browser-settings-title">Built-in browser</SettingsSectionTitle>
      <SettingCard>
        <SettingToggle
          label="Show the page while an agent uses it"
          description="With the pane closed, a page an agent opens or drives floats in a corner over the chat. Close it to keep it out of the way while that agent works."
          enabled={autoFloat}
          onChange={setAutoFloat}
        />
      </SettingCard>
    </section>
  )
}
