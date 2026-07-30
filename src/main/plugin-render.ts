import type {
  PluginArgvToken,
  PluginManifest,
  PluginPermissionPreset,
  PluginRenderContext,
  PluginRenderedCommand,
} from '../shared/plugin-manifest'

// Render a plugin manifest into a concrete spawnable command.
//
// Pure function — no I/O, no globals. Substitutes {{var}} placeholders,
// expands {spread: 'x'} into argv tokens from an array variable, and
// merges manifest env + caller-provided variables.

const SUBSTITUTION_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

export function renderPluginLaunch(
  manifest: PluginManifest,
  context: PluginRenderContext
): PluginRenderedCommand {
  return renderArgvSpec(manifest, context, manifest.launch.argv, manifest.launch)
}

export function renderPluginResume(
  manifest: PluginManifest,
  context: PluginRenderContext
): PluginRenderedCommand | null {
  if (!manifest.resume || !manifest.resume.supported) return null
  const argvSpec = manifest.resume.argv ?? manifest.launch.argv
  return renderArgvSpec(manifest, context, argvSpec, manifest.launch)
}

// The reasoning-effort argv tokens a manifest renders for a selected level, or
// an empty array when none should render: when no level is selected, when the
// manifest declares no reasoningSelection, when the level equals the manifest's
// declared default (so ordinary launches stay byte-identical), or when the level
// is outside the declared set (better no flag than a value the CLI can't parse).
// A manifest declaring no `default` therefore renders a flag for every declared
// level, which is how a CLI with an undocumented default effort is modelled.
//
// `scope`, when passed, is the launch's full variable scope: the templates
// substitute against it (and `reasoning` is set on it) exactly as they did
// inline, so a manifest whose effort args reference another variable keeps
// resolving it. Callers outside the manifest render path pass none and get the
// minimal scope their own templates need.
export function renderReasoningArgs(
  manifest: PluginManifest,
  reasoning: string | undefined,
  scope?: Map<string, string | string[] | undefined>
): string[] {
  const level = reasoning?.trim()
  const selection = manifest.reasoningSelection
  if (
    !level ||
    !selection ||
    selection.args.length === 0 ||
    level === selection.default ||
    !selection.levels.some((declared) => declared.id === level)
  ) {
    return []
  }
  const variables = scope ?? new Map<string, string | string[] | undefined>([['binary', manifest.binary]])
  variables.set('reasoning', level)
  return selection.args.map((template) => substituteString(template, variables))
}

function renderArgvSpec(
  manifest: PluginManifest,
  context: PluginRenderContext,
  argvSpec: PluginArgvToken[],
  launchSpec: { cwd?: string; env?: Record<string, string> }
): PluginRenderedCommand {
  const variables = buildVariableScope(manifest, context)
  const argv = expandArgv(argvSpec, variables)
  const cwd = launchSpec.cwd ? substituteString(launchSpec.cwd, variables) : undefined
  const env = renderEnv(launchSpec.env, variables)
  return { argv, cwd, env }
}

// The presets the app can ask for, least → most permissive. A manifest need not
// declare all three, and an undeclared one must not be passed through as an
// unknown flag — that is fatal to the CLI. It degrades DOWN this ladder instead,
// to the most permissive preset the CLI actually declares, which can never grant
// more than was requested. A name outside the ladder has no ordering to walk, so
// it keeps the previous behaviour and falls back to `default`.
const PERMISSION_PRESET_LADDER = ['default', 'auto_workspace', 'bypass_all'] as const

function resolvePermissionPreset(
  manifest: PluginManifest,
  requested: string | undefined
): PluginPermissionPreset | undefined {
  const name = requested ?? 'default'
  const declared = manifest.permissionPresets[name]
  if (declared) return declared
  const rung = PERMISSION_PRESET_LADDER.indexOf(name as (typeof PERMISSION_PRESET_LADDER)[number])
  for (let below = rung - 1; below > 0; below -= 1) {
    const candidate = manifest.permissionPresets[PERMISSION_PRESET_LADDER[below]]
    if (candidate) return candidate
  }
  return manifest.permissionPresets.default
}

function buildVariableScope(
  manifest: PluginManifest,
  context: PluginRenderContext
): Map<string, string | string[] | undefined> {
  const scope = new Map<string, string | string[] | undefined>()

  for (const [name, decl] of Object.entries(manifest.variables ?? {})) {
    if (decl.default !== undefined) {
      scope.set(name, String(decl.default))
    }
  }

  for (const [name, value] of Object.entries(context.variables ?? {})) {
    if (value === undefined) continue
    scope.set(name, Array.isArray(value) ? value.map(String) : String(value))
  }

  scope.set('binary', context.binary ?? manifest.binary)
  if (context.sessionId !== undefined) scope.set('sessionId', context.sessionId)
  if (context.prompt !== undefined) scope.set('prompt', context.prompt)
  if (context.cwd !== undefined) scope.set('cwd', context.cwd)
  if (context.workspaceRoot !== undefined) scope.set('workspaceRoot', context.workspaceRoot)
  if (context.files !== undefined) scope.set('files', context.files)

  const preset = resolvePermissionPreset(manifest, context.permissionPreset)
  scope.set('permissionArgs', preset?.args ?? [])

  // `modelArgs` mirrors `permissionArgs`: a spreadable token list manifests
  // opt into via { spreadIf: "modelArgs" }. Rendered only when a model was
  // selected AND the manifest declares how to pass it; otherwise empty, so the
  // CLI's own default model wins and plugins without modelSelection are
  // unaffected by stale persisted model ids.
  const model = context.model?.trim()
  const modelArgTemplates = manifest.modelSelection?.args
  if (model && modelArgTemplates && modelArgTemplates.length > 0) {
    scope.set('model', model)
    scope.set(
      'modelArgs',
      modelArgTemplates.map((template) => substituteString(template, scope))
    )
  } else {
    scope.set('modelArgs', [])
  }

  // `reasoningArgs` mirrors `modelArgs`: spread into argv via
  // { spreadIf: "reasoningArgs" }. The render rule lives in
  // renderReasoningArgs, which the acknowledged-legacy native-Windows codex
  // path also calls so both paths honor one rule. It sets `reasoning` on this
  // scope only when the level actually renders, so an unset, default, or
  // undeclared level leaves `{{reasoning}}` unresolved as before.
  scope.set('reasoningArgs', renderReasoningArgs(manifest, context.reasoning, scope))

  // `themeArgs` mirrors `modelArgs`: spread into argv via { spreadIf: "themeArgs" }.
  // Rendered only when the host reported a color scheme AND the manifest declares
  // themeSelection; otherwise empty, so a CLI without theme support — or before
  // the renderer has pushed a scheme — keeps its own configured theme.
  //
  // When the manifest provides a `schemes` map (for CLIs with no literal
  // "light"/"dark" value, e.g. Codex's named syntax themes), the active scheme
  // resolves through it and is exposed as `{{themeName}}`. Without a map, the
  // templates substitute `{{colorScheme}}` directly. A scheme that the map
  // doesn't cover yields no theme args — better to let the CLI keep its own
  // detection than to force a wrong or empty theme.
  const colorScheme = context.colorScheme?.trim()
  const themeSelection = manifest.themeSelection
  const themeArgTemplates = themeSelection?.args
  const themeName = themeSelection?.schemes
    ? colorScheme === 'light' || colorScheme === 'dark'
      ? themeSelection.schemes[colorScheme]
      : undefined
    : colorScheme
  if (colorScheme && themeName && themeArgTemplates && themeArgTemplates.length > 0) {
    scope.set('colorScheme', colorScheme)
    scope.set('themeName', themeName)
    scope.set(
      'themeArgs',
      themeArgTemplates.map((template) => substituteString(template, scope))
    )
  } else {
    scope.set('themeArgs', [])
  }

  return scope
}

function expandArgv(
  argvSpec: PluginArgvToken[],
  variables: Map<string, string | string[] | undefined>
): string[] {
  const out: string[] = []
  for (const token of argvSpec) {
    if (typeof token === 'string') {
      out.push(substituteString(token, variables))
      continue
    }
    if ('spread' in token) {
      const value = variables.get(token.spread)
      if (Array.isArray(value)) {
        out.push(...value)
      } else if (typeof value === 'string' && value.length > 0) {
        out.push(value)
      }
      continue
    }
    if ('spreadIf' in token) {
      const value = variables.get(token.spreadIf)
      if (Array.isArray(value) && value.length > 0) {
        out.push(...value)
      } else if (typeof value === 'string' && value.length > 0) {
        out.push(value)
      }
      continue
    }
    if ('valueIf' in token) {
      const condition = variables.get(token.valueIf)
      const truthy =
        (Array.isArray(condition) && condition.length > 0) ||
        (typeof condition === 'string' && condition.length > 0)
      if (truthy) out.push(substituteString(token.value, variables))
      continue
    }
  }
  return out
}

function substituteString(
  template: string,
  variables: Map<string, string | string[] | undefined>
): string {
  return template.replace(SUBSTITUTION_PATTERN, (_match, name: string) => {
    const value = variables.get(name)
    if (value === undefined) return ''
    if (Array.isArray(value)) return value.join(' ')
    return value
  })
}

function renderEnv(
  envSpec: Record<string, string> | undefined,
  variables: Map<string, string | string[] | undefined>
): Record<string, string> {
  const env: Record<string, string> = {}
  if (!envSpec) return env
  for (const [name, template] of Object.entries(envSpec)) {
    const value = substituteString(template, variables)
    if (value.length > 0) env[name] = value
  }
  return env
}
