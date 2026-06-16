// Plugin manifest schema for the BYO-CLI system.
//
// See docs/2026-05-16-byo-cli-plugin-system.md for the design rationale and
// docs/2026-05-16-plugin-manifests-worked-examples.md for worked examples.
//
// The running app consumes the registry for terminal agent launches, the
// renderer agent CLI catalog, and provider-only conversation manifests. Provider
// manifests must never be mixed into the terminal CLI catalog.

import type { ModuleSignature, ModuleTrustStatus } from './modules/manifest'

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

export type PluginSkillSupport = 'native' | 'prompt-shim' | 'unsupported'
export type PluginSkillInstallScope = 'workspace' | 'user'
export type PluginSkillFormat =
  | 'agent-skills-v1'
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'generic'

export type PluginSkillInstallTarget = {
  scope: PluginSkillInstallScope
  path: string
  format: PluginSkillFormat
  restartRequired?: boolean
}

export type PluginSkillInvocation = {
  fileDropTemplate?: string
  explicitTemplate?: string
  nativeSlashCommand?: boolean
  explicitMention?: boolean
  implicitInvocation?: boolean
}

export type PluginSkillIntegration = {
  support: PluginSkillSupport
  harnessId: string
  installTargets?: PluginSkillInstallTarget[]
  invocation?: PluginSkillInvocation
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

export type PluginModelOption = {
  id: string
  label?: string
}

// Declares that a CLI supports model selection and how the chosen model id is
// passed on its command line. `args` are substituted templates (e.g.
// ["--model", "{{model}}"]) exposed to launch/resume argv as the `modelArgs`
// spread; they are only rendered when a model is actually selected, so an
// unset model never overrides the CLI's own default. `options` is a seed list
// — terminal CLIs expose no live model catalog, so users can extend it from
// Settings. Named `modelSelection` (not `models`) because `models` is the
// provider-manifest model array with a different shape.
export type PluginModelSelectionSpec = {
  args: string[]
  options?: PluginModelOption[]
  allowCustomId?: boolean
}

// Declares that a CLI can be told the host's light/dark color scheme on launch,
// and how. `args` are substituted templates exposed to launch/resume argv as the
// `themeArgs` spread, with `{{colorScheme}}` resolving to 'light' or 'dark'
// (e.g. ["--settings", "{\"theme\":\"{{colorScheme}}\"}"] for Claude Code).
// Rendered only when the host has reported a scheme AND the manifest opts in, so
// CLIs without themeSelection keep their own configured theme. Mirrors the
// `modelSelection` → `modelArgs` pattern.
export type PluginThemeSelectionSpec = {
  args: string[]
}

export type PluginManifest = {
  kind?: 'cli'
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
  modelSelection?: PluginModelSelectionSpec
  themeSelection?: PluginThemeSelectionSpec
  skillIntegration?: PluginSkillIntegration
  detect?: PluginDetectSpec
  install?: PluginInstallSpec
}

// Platform keys for install metadata. `wsl` is a logical target used when the
// CLI runtime is configured to run through WSL on Windows; it is not a
// `process.platform` value.
export type PluginInstallPlatform = 'darwin' | 'linux' | 'win32' | 'wsl'

// How to confirm a CLI is installed and read its version. `versionArgs`
// defaults to `['--version']` when omitted.
export type PluginDetectSpec = {
  versionArgs?: string[]
}

// One installable path for a CLI on a given platform. `shell` is run in the
// platform's shell (POSIX `bash -lc` for darwin/linux/wsl, PowerShell for
// win32). `requires`, when set, names a binary that must be on PATH for the
// method to be offered (e.g. `npm`, `brew`).
export type PluginInstallMethod = {
  id: string
  label: string
  shell: string
  recommended?: boolean
  requires?: string
}

export type PluginInstallSpec = Partial<Record<PluginInstallPlatform, PluginInstallMethod[]>>


export type ConversationProviderType = 'model-provider' | 'agent-harness'

export type ConversationProviderModel = {
  id: string
  displayName?: string
  // Max context window in tokens, when the provider reports it (e.g. OpenRouter's
  // `context_length`). Drives the composer's context-usage meter.
  contextLength?: number
}

export type ConversationProviderAuth = {
  type: 'api-key'
  label: string
  env?: string
}

export type ConversationProviderAdapterKind = 'declarative' | 'trusted-executable'

export type ConversationProviderAdapterSpec =
  | { kind: 'declarative' }
  | { kind: 'trusted-executable'; entry: string; sha256: string }

export type OpenAiCompatibleProviderConfig = {
  baseUrl: string
  chatCompletionsPath?: string
  // Absolute path to an OpenAI-shaped models endpoint (`{ data: [{ id, name? }] }`).
  // When set, the provider supports a live model catalog (e.g. OpenRouter's
  // `/api/v1/models`) and the manifest `models` list is only a seed/fallback used
  // for the spawn default and connection test.
  modelsPath?: string
}

export type ConversationProviderAdapterExecution = 'declarative' | 'executable' | 'blocked'

export type ConversationProviderAdapterTrustStatus = ModuleTrustStatus | 'not_required'

export type ConversationProviderAdapterClassification = {
  kind: ConversationProviderAdapterKind
  execution: ConversationProviderAdapterExecution
  trust: ConversationProviderAdapterTrustStatus
  entry?: string
  fingerprint?: string
  trustError?: string
}

export type ConversationProviderManifest = {
  kind: 'provider'
  id: string
  displayName: string
  publisher?: string
  version: number
  providerType: ConversationProviderType
  models: ConversationProviderModel[]
  auth?: ConversationProviderAuth
  adapter?: ConversationProviderAdapterSpec
  openaiCompatible?: OpenAiCompatibleProviderConfig
  signature?: ModuleSignature
}

export type PluginManifestFamily = PluginManifest | ConversationProviderManifest

export type PluginRenderContext = {
  binary?: string
  sessionId?: string
  prompt?: string
  cwd?: string
  workspaceRoot?: string
  permissionPreset?: string
  model?: string
  // Host light/dark color scheme; consumed by manifests that declare
  // `themeSelection` to spread theme args (e.g. Claude Code's --settings theme).
  colorScheme?: string
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
  | { ok: true; manifest: PluginManifestFamily }
  | { ok: false; issues: PluginManifestValidationIssue[] }

export type PluginSource = 'bundled' | 'user'

export type LoadedPlugin = {
  manifest: PluginManifest
  source: PluginSource
  manifestPath: string
  pluginRoot: string
}

export type LoadedConversationProvider = {
  manifest: ConversationProviderManifest
  source: PluginSource
  manifestPath: string
  pluginRoot: string
  adapter: ConversationProviderAdapterClassification
}

// Renderer-facing model-selection metadata. `args` stays main-process-only;
// pickers need the choices and whether free-text ids are allowed.
export type PluginModelCatalog = {
  options: PluginModelOption[]
  allowCustomId: boolean
}

export type PluginSkillCatalog = {
  support: PluginSkillSupport
  harnessId: string
  restartRequired: boolean
  installTargetCount: number
  invocation?: PluginSkillInvocation
}

export type PluginRegistryListEntry = {
  id: string
  displayName: string
  source: PluginSource
  version: number
  binary: string
  modelSelection?: PluginModelCatalog
  skillIntegration?: PluginSkillCatalog
}

export type ConversationProviderListEntry = {
  id: string
  displayName: string
  source: PluginSource
  version: number
  providerType: ConversationProviderType
  models: ConversationProviderModel[]
  // True when the provider exposes a live models endpoint (`modelsPath`); the
  // renderer then treats `models` as a seed and trusts the live catalog instead
  // of blocking on static membership.
  supportsDynamicModels: boolean
  adapter: ConversationProviderAdapterClassification
}
