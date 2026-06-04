// Plugin manifest schema for the BYO-CLI system.
//
// See docs/2026-05-16-byo-cli-plugin-system.md for the design rationale and
// docs/2026-05-16-plugin-manifests-worked-examples.md for worked examples.
//
// The running app consumes the registry for terminal agent launches and the
// renderer agent CLI catalog. Provider-only conversation plugins are still
// future work and must not be mixed into the CLI catalog without a manifest
// discriminator.

export type PluginVariableType = 'string' | 'enum' | 'boolean' | 'number'

export type PluginVariableDecl = {
  type: PluginVariableType
  label: string
  description?: string
  default?: string | number | boolean
  required?: boolean
  options?: string[]
}

export type PluginPermissionPreset = {
  label: string
  args: string[]
}

export type PluginArgvToken =
  | string
  | { spread: string }
  | { spreadIf: string }
  | { valueIf: string; value: string }

export type PluginLaunchSpec = {
  argv: PluginArgvToken[]
  cwd?: string
  env?: Record<string, string>
}

export type PluginResumeSpec = {
  supported: boolean
  argv?: PluginArgvToken[]
}

export type PluginPromptInjectionMode =
  | 'positional-arg'
  | 'stdin-pipe'
  | 'send-after-ready'
  | 'file'

export type PluginReadinessSignal = {
  type: 'output-match'
  pattern: string
  timeoutMs: number
}

export type PluginPromptInjection = {
  mode: PluginPromptInjectionMode
  readiness?: PluginReadinessSignal
}

export type PluginCompletionMode =
  | 'process-exit'
  | 'output-sentinel'
  | 'mcp-signal'
  | 'idle-at-prompt'

export type PluginCompletionSpec = {
  mode: PluginCompletionMode
  sentinel?: string
  signalTool?: string
  idleMs?: number
  promptPattern?: string
  fallback?: PluginCompletionSpec
}

export type PluginMcpConfigFormat = 'claude-code' | 'codex' | 'opencode' | 'generic'

export type PluginMcpConfigSpec = {
  path: string
  userPath?: string
  format: PluginMcpConfigFormat
}

export type PluginCapabilities = {
  resumeSession: boolean
  sessionIdFromCaller: boolean
  toolUse: boolean
  mcpServers: boolean
  imageInput?: boolean
  chatHistoryFile?: string
}

export type PluginSoulsSpec = {
  directory: string
}

export type PluginManifest = {
  id: string
  displayName: string
  publisher?: string
  version: number
  binary: string
  variables?: Record<string, PluginVariableDecl>
  permissionPresets: Record<string, PluginPermissionPreset>
  launch: PluginLaunchSpec
  resume?: PluginResumeSpec
  promptInjection: PluginPromptInjection
  completion: PluginCompletionSpec
  mcpConfig?: PluginMcpConfigSpec
  capabilities: PluginCapabilities
  souls?: PluginSoulsSpec
}

export type PluginRenderContext = {
  binary?: string
  sessionId?: string
  prompt?: string
  cwd?: string
  workspaceRoot?: string
  permissionPreset?: string
  variables?: Record<string, string | number | boolean | string[] | undefined>
  files?: string[]
}

export type PluginRenderedCommand = {
  argv: string[]
  cwd?: string
  env: Record<string, string>
}

export type PluginManifestValidationIssue = {
  path: string
  message: string
}

export type PluginManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; issues: PluginManifestValidationIssue[] }

export type PluginSource = 'bundled' | 'user'

export type LoadedPlugin = {
  manifest: PluginManifest
  source: PluginSource
  manifestPath: string
  pluginRoot: string
}

export type PluginRegistryListEntry = {
  id: string
  displayName: string
  source: PluginSource
  version: number
  binary: string
}
