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
  /**
   * The character a person types to name a skill mid-prompt — `/` for a CLI
   * with real slash commands, `$` for one whose skills are `$`-mentions. Absent
   * means the CLI has no in-prompt form at all (opencode says "Use the X
   * skill."), and surfaces that offer a type-ahead must fall back to a picker
   * rather than inventing a trigger.
   *
   * Declared rather than derived: reading the character before `{{skillId}}` in
   * `explicitTemplate` yields `/`, `$`, and — for the sentence form — `e`.
   * Right twice and silently wrong once.
   */
  mentionPrefix?: string
  /**
   * What a picked skill inserts at the caret. Defaults to
   * `{{mentionPrefix}}{{skillId}}`. Distinct from `explicitTemplate`, which is
   * the STANDALONE form used to seed a whole prompt (debug launch, connector
   * chat, backlog handoff) and may be a full sentence — inserting that
   * mid-sentence would write the user's sentence for them.
   */
  mentionTemplate?: string
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

// Declares that a CLI supports reasoning-effort selection and how the chosen
// level is passed on its command line. Mirrors the `modelSelection` →
// `modelArgs` pattern: `args` are substituted templates (e.g. ["-c",
// "model_reasoning_effort=\"{{reasoning}}\""]) exposed to launch argv as the
// `reasoningArgs` spread. They render only when a level is selected AND it
// differs from `default`, so an unset (or default) level passes no flag and the
// CLI's own default effort wins. `levels` is the closed set the CLI accepts —
// the picker never offers a level the CLI can't parse.
export type PluginReasoningOption = {
  id: string
  label?: string
}

export type PluginReasoningSelectionSpec = {
  args: string[]
  levels: PluginReasoningOption[]
  default?: string
}

// Declares that a CLI can be told the host's light/dark color scheme on launch,
// and how. `args` are substituted templates exposed to launch/resume argv as the
// `themeArgs` spread, with `{{colorScheme}}` resolving to 'light' or 'dark'
// (e.g. ["--settings", "{\"theme\":\"{{colorScheme}}\"}"] for Claude Code).
// Rendered only when the host has reported a scheme AND the manifest opts in, so
// CLIs without themeSelection keep their own configured theme. Mirrors the
// `modelSelection` → `modelArgs` pattern.
//
// `schemes` maps each scheme to a CLI-specific theme name for CLIs that have no
// literal light/dark value and instead take a named theme. When set, the active
// scheme resolves through it and is exposed to `args` as `{{themeName}}`
// (e.g. Codex: ["-c", "tui.theme=\"{{themeName}}\""] with
// { light: "catppuccin-latte", dark: "catppuccin-mocha" } — Codex's adaptive
// default light/dark syntax themes). A scheme missing from the map renders no
// theme args, so the CLI falls back to its own detection.
export type PluginThemeSelectionSpec = {
  args: string[]
  schemes?: { light: string; dark: string }
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
  reasoningSelection?: PluginReasoningSelectionSpec
  themeSelection?: PluginThemeSelectionSpec
  skillIntegration?: PluginSkillIntegration
  // Optional credential the CLI needs to reach an authenticated endpoint (e.g.
  // the Z.AI runtime, which redirects the `claude` binary at Z.AI via
  // `launch.env`). Resolved by the shared credential store and exposed to
  // `launch.env` as `{{secret}}`. Most CLIs (claude-code/codex/opencode) use the
  // user's own logged-in account and declare none.
  auth?: ManifestAuth
  detect?: PluginDetectSpec
  install?: PluginInstallSpec
  update?: PluginUpdateSpec
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

// How to update an installed CLI through its own updater: `args` run against
// the resolved binary (e.g. `["update"]` for claude-code), mirroring
// `detect.versionArgs`. Absent, the Update action re-runs the `install` spec —
// idempotent for npm installs. There is deliberately NO staleness detection
// for CLIs (MC-1873): a CLI's "latest" belongs to the vendor's channel, not
// the marketplace registry.
export type PluginUpdateSpec = {
  args: string[]
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

// A credential descriptor any manifest kind can declare — a CLI plugin that
// proxies an authenticated endpoint (e.g. the Z.AI runtime) or a conversation
// provider. Resolved by Multicode's single shared credential store
// (src/main/secret-store.ts), which stores the value encrypted and exposes only
// redacted status. `env` names an environment variable consulted as a fallback
// source for the secret.
export type ManifestAuth = {
  type: 'api-key'
  label: string
  env?: string
}

// Back-compat alias: conversation provider manifests referenced this name.
export type ConversationProviderAuth = ManifestAuth

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
  // Selected reasoning-effort level; consumed by manifests declaring
  // `reasoningSelection` to spread `reasoningArgs` (no-op at the declared
  // default level).
  reasoning?: string
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

// Renderer-facing reasoning-selection metadata. `args` stays main-process-only;
// pickers need the levels and which one is the CLI's default.
export type PluginReasoningCatalog = {
  levels: PluginReasoningOption[]
  default?: string
}

// Renderer-facing skill-integration metadata. Carries the declared install
// targets verbatim (path template included) because the template *is* the
// declaration of where a harness keeps its skills — `buildHarnessMap`
// (src/shared/harness-map.ts) parses it, and nothing anywhere writes a harness
// directory as a string literal.
export type PluginSkillCatalogTarget = {
  scope: PluginSkillInstallScope
  path: string
  format: PluginSkillFormat
  restartRequired: boolean
}

export type PluginSkillCatalog = {
  support: PluginSkillSupport
  harnessId: string
  installTargets: PluginSkillCatalogTarget[]
  invocation?: PluginSkillInvocation
}

export type PluginRegistryListEntry = {
  id: string
  displayName: string
  source: PluginSource
  version: number
  binary: string
  // Conversation-resume capabilities projected from `capabilities` so renderer
  // reducers/components can resolve resume behavior synchronously (including
  // optimistic pre-launch) without reaching the main-process registry. See
  // agent-cli-resume.ts (ResumeCapabilities) and resumeCapabilitiesForCli.
  resumeSession: boolean
  sessionIdFromCaller: boolean
  modelSelection?: PluginModelCatalog
  reasoningSelection?: PluginReasoningCatalog
  // Set when this runtime is another CLI's binary redirected at an alternate
  // provider endpoint (today: `binary: "claude"` + a `launch.env` base-URL
  // redirect, e.g. zai and kimi-claude). Derived from the manifest, never
  // declared. Pickers group these under a "Models via Claude Code" section so
  // they read as hosted models rather than peer CLIs.
  hostedVia?: 'claude-code'
  skillIntegration?: PluginSkillCatalog
  // Present when the CLI declares a credential (`auth`); the renderer uses the
  // label to render a key-entry row in Agents settings. The secret value itself
  // is never sent to the renderer — only this descriptor.
  auth?: { label: string }
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
  // Plain-language reason this provider cannot start sessions right now (e.g.
  // its agent-harness CLI was not found). An unavailable provider is still
  // listed — never silently hidden — but spawn defaults skip it and the model
  // picker renders it disabled with this reason.
  unavailable?: string
}
