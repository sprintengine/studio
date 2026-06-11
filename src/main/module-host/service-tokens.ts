import type { AppServices } from '../app-services'
import { createServiceToken } from './main-host'

// Tokens for the shared services that capability modules consume across module
// boundaries (instead of importing the concrete instances). index.ts seeds the
// kernel with the live AppServices instances via loadMainModules' provideServices
// hook; modules call host.requireService(<token>).
export const TerminalRuntimeToken = createServiceToken<AppServices['terminalRuntime']>(
  'core.terminal-runtime'
)
export const GitHubTokenStoreToken = createServiceToken<AppServices['githubTokenStore']>(
  'core.github-token-store'
)
export const SprintEngineArtifactsToken = createServiceToken<AppServices['sprintEngineArtifacts']>(
  'core.sprintengine-artifacts'
)
export const MulticodeAuthToken = createServiceToken<AppServices['multicodeAuth']>(
  'core.multicode-auth'
)
export const SprintEngineMcpHubToken = createServiceToken<AppServices['sprintEngineMcpHub']>(
  'core.sprintengine-mcp-hub'
)
