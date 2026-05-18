import type {
  PluginArgvToken,
  PluginManifest,
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

  const presetName = context.permissionPreset ?? 'default'
  const preset = manifest.permissionPresets[presetName] ?? manifest.permissionPresets.default
  if (preset) {
    scope.set('permissionArgs', preset.args)
  } else {
    scope.set('permissionArgs', [])
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
