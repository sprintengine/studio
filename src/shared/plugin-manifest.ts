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

// How the host's out-of-band context document reaches this CLI (design-door /
// MC-2016). `promptInjection` above answers "how does the USER's request get in";
// this answers "how does everything the HOST wants to say get in, without
// pretending to be the user".
//
// - `argv`  — the CLI takes a system-prompt flag. `args` are substituted
//   templates spread into launch AND resume argv as `contextArgs`, so a resumed
//   session is re-told (e.g. Claude Code:
//   ["--append-system-prompt-file", "{{contextFile}}"]).
// - `env`   — the CLI reads its instructions out of an environment variable
//   (e.g. OpenCode's OPENCODE_CONFIG_CONTENT). `env` is merged into the
//   launch env.
// - `prompt` — the CLI has no out-of-band channel at all, so the document is
//   wrapped in `<host-context>` tags and placed BEFORE the user's prompt.
//
// Absent ⇒ `prompt`. Templates may reference `{{contextFile}}` (absolute path of
// the written document), `{{contextFileJson}}` (that path as a JSON string
// literal, for a template that embeds it in a JSON document), `{{contextText}}`
// (the document itself) and `{{contextToml}}` (the document as a TOML
// basic-string literal, for a CLI that takes it through a config override). Nothing renders when the host had nothing
// to say, so an ordinary repo's launch is unchanged.
export type PluginContextInjectionMode = 'argv' | 'env' | 'prompt'

export type PluginContextInjection = {
  mode: PluginContextInjectionMode
  args?: string[]
  env?: Record<string, string>
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

// =============================================================================
// Agent-state capability (authoritative lifecycle-hook reporting)
//
// Declares how a CLI's lifecycle hooks are registered and how its native event
// names map to the shared AgentPhase vocabulary. A manifest WITHOUT this spec
// declares that the CLI cannot report authoritative agent state. The install
// writers, the event→phase mapping, and the turn-end flags all read this data;
// no per-CLI knowledge lives in core code.
// =============================================================================

// The phases an event may drive. `failed`/`stalled` are runtime-derived (pty
// exit, stall watchdog) and never event-declared; `exited` is allowed for
// SessionEnd-style events but a real process exit is still owned by the pty
// exit listener.
export type PluginAgentStatePhase =
  | 'starting'
  | 'thinking'
  | 'tool_use'
  | 'awaiting_input'
  | 'idle'
  | 'exited'

// Payload fields the reporter forwards for manifest discriminators to consult:
// Claude's `notification_type`, and a turn-outcome `status` (Cursor's stop
// payload). Adding a field here means teaching the reporter to forward it.
export type PluginAgentStateDiscriminatorField = 'notificationType' | 'status'

export type PluginAgentStateEventSpec = {
  // Native event name exactly as the CLI's hook payload / reporter frame names
  // it (`Stop`, `session.idle`, …).
  event: string
  // Registration matcher (Claude-style hooks config `matcher` key). Only
  // meaningful for registered command-hook events.
  matcher?: string
  // The phase this event drives.
  phase: PluginAgentStatePhase
  // Payload discriminator: the phase applies only when the named frame field's
  // value is in `oneOf`; any other (or absent) value drops the frame so the
  // prior phase stands. This is where Claude's Notification allow-list lives —
  // as data on the Claude plugin, not code in the shared path.
  when?: { field: PluginAgentStateDiscriminatorField; oneOf: string[] }
  // Failure discriminator: the event additionally counts as a FAILED turn when
  // the named frame field's value is in `oneOf` — for CLIs whose one turn-end
  // event carries the outcome in its payload (Cursor's stop
  // status: completed|aborted|error) instead of a separate failure event
  // (Kimi's StopFailure, OpenCode's session.error). An absent or unlisted
  // value leaves the event's declared flags as-is.
  failureWhen?: { field: PluginAgentStateDiscriminatorField; oneOf: string[] }
  // Whether the event is written into the CLI's hook registration (default
  // true). `false` = mapped if a frame ever arrives (e.g. a stale registration
  // from an older release) but never registered anew — Claude's PreToolUse.
  // Ignored for plugin-file registrations (the plugin subscribes itself).
  register?: boolean
  // This event is the session's turn end (drives automation finalization).
  // Raw-event-level deliberately: several events share a phase (Stop and
  // SubagentStop both map to idle) and only the event name tells them apart.
  turnEnd?: boolean
  // This event signals a failed turn (OpenCode's session.error, which still
  // maps to phase `idle` — the flag is the only way to tell a crash from a
  // clean finish).
  failure?: boolean
  // This event opens (`start`) or closes (`stop`) a piece of background work
  // the session still owns — Claude's SubagentStart / SubagentStop. The runtime
  // counts them per session, and a turn end that arrives with work still open
  // is NOT a turn end: the CLI has parked the model on "waiting for N
  // background agents" and will re-invoke it when they finish, so the session
  // stays working until the Stop that arrives with nothing outstanding
  // (owner ruling 2026-09-04 — the sidebar's finished mark was firing here).
  background?: 'start' | 'stop'
}

// Where `registration.path` resolves from: the workspace root (default) or the
// user's home directory — for CLIs whose only hook config is user-global
// (Kimi Code's ~/.kimi-code/config.toml). A user-scoped registration fires for
// every session of that CLI on the machine; the reporter exits silently when
// the MULTICODE_* launch env is absent, so outside-app sessions cost one
// short-lived no-op process per event and report nothing.
export type PluginAgentStateRegistrationScope = 'workspace' | 'user'

// Where and how the reporter is registered. Paths are scope-relative,
// forward-slashed.
export type PluginAgentStateRegistrationSpec = (
  // Merge tagged entries into a Claude-style shared settings JSON
  // (hooks.<Event>[].hooks[]), preserving everything else in the file.
  | { kind: 'settings-json'; path: string }
  // Merge signature-identified entries into a Cursor-style flat hooks JSON
  // ({ version, hooks: { <event>: [{ command }] } }), preserving the user's
  // own entries. No vendor-foreign tag key is written — ours are recognized by
  // the reporter command's shape alone.
  | { kind: 'flat-hooks-json'; path: string }
  // Marker-delimited managed block in a TOML config, [[hooks.<Event>]] shape
  // (Codex), preserving the rest of the file.
  | { kind: 'toml-block'; path: string }
  // Marker-delimited managed block in a TOML config, [[hooks]] array-of-tables
  // shape with an `event` key per entry (Kimi Code), preserving the rest of
  // the file.
  | { kind: 'toml-array-block'; path: string }
  // A standalone hook-config JSON file we own outright — plain write/remove,
  // no merge bookkeeping (Grok's per-file discovery).
  | { kind: 'owned-json'; path: string }
  // An in-process JS plugin installed into the CLI's plugin directory, from a
  // named bundled template with the socket path substituted at install time
  // (OpenCode). The template still contains CLI-specific subscription logic;
  // the manifest's `events` table remains the canonical mapping the main
  // process applies.
  | { kind: 'plugin-file'; path: string; template: string }
) & { scope?: PluginAgentStateRegistrationScope }

export type PluginAgentStateSpec = {
  registration: PluginAgentStateRegistrationSpec
  events: PluginAgentStateEventSpec[]
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
  // How the host-context document reaches this CLI. Absent ⇒ `prompt`.
  contextInjection?: PluginContextInjection
  completion: PluginCompletionSpec
  mcpConfig?: PluginMcpConfigSpec
  capabilities: PluginCapabilities
  souls?: PluginSoulsSpec
  modelSelection?: PluginModelSelectionSpec
  reasoningSelection?: PluginReasoningSelectionSpec
  themeSelection?: PluginThemeSelectionSpec
  skillIntegration?: PluginSkillIntegration
  // Authoritative agent-state integration (see the section above). Absent ⇒
  // the CLI cannot report authoritative agent state.
  agentStateSpec?: PluginAgentStateSpec
  // Optional credential the CLI needs to reach an authenticated endpoint (e.g.
  // the Z.AI runtime, which redirects the `claude` binary at Z.AI via
  // `launch.env`). Resolved by the shared credential store and exposed to
  // `launch.env` as `{{secret}}`. Most CLIs (claude-code/codex/opencode) use the
  // user's own logged-in account and declare none.
  auth?: ManifestAuth
  detect?: PluginDetectSpec
  install?: PluginInstallSpec
  update?: PluginUpdateSpec
  // Where the CLI is published, so the studio can ask a registry for the
  // newest version (npm's `/<pkg>/latest`) and choose the update command
  // (`brew upgrade <formula>` when the binary lives under Homebrew, else
  // `npm install -g <pkg>@latest`). Absent for CLIs that install from a
  // vendor script only (cursor, kimi-code): their version check is `unknown`.
  package?: PluginPackageSpec
}

export type PluginPackageSpec = {
  npm?: string
  brew?: string
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
  // The host-context document for this launch, when there is one. `contextFile`
  // is where main wrote it (already normalized for the target path style);
  // `contextText` is the document itself. Both absent ⇒ no `contextArgs` and no
  // context env, whatever the manifest declares — a CLI never sees an empty
  // flag.
  contextFile?: string
  contextText?: string
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
  // Projected from `agentStateSpec` presence: whether this CLI can report
  // authoritative agent state via lifecycle hooks. Hooks are the only
  // supported status mechanism, so a false here means the CLI is not offered
  // as an agent (pickers filter on it; the main process refuses launches).
  agentStateCapable: boolean
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
