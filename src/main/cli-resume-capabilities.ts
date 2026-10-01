import { pluginIdForCli } from './agent-launch-render'
import { getPluginById } from './plugin-registry-instance'

// Reads a CLI's conversation-resume capabilities from the plugin registry (the
// authoritative manifest source; cli id == plugin id). The main process stamps
// these onto the agent-terminal sync payload so renderer stores never re-derive
// resume behavior from a hardcoded cli-id allowlist. Absent plugin → both false.
export function cliResumeCapabilities(cli: string | undefined): {
  resumeSession: boolean
  sessionIdFromCaller: boolean
} {
  const caps = cli ? getPluginById(pluginIdForCli(cli))?.manifest.capabilities : undefined
  return {
    resumeSession: caps?.resumeSession ?? false,
    sessionIdFromCaller: caps?.sessionIdFromCaller ?? false,
  }
}
