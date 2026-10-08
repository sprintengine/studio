import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

// Resolves a bundled hook reporter script across packaged and dev layouts.
// Mirrors memory-activity's resolver: extraResources ships resources/hooks/*.mjs
// to <resourcesPath>/hooks in packaged builds.
function getBundledHookReporterPath(filename: string): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, 'hooks', filename)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', 'hooks', filename),
    join(app.getAppPath(), 'resources', 'hooks', filename),
    join(__dirname, '..', '..', 'resources', 'hooks', filename),
    join(__dirname, '..', '..', '..', 'resources', 'hooks', filename),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// Every command-hook registration shares one stdin-filter reporter; plugin-file
// registrations name their own bundled template (e.g. OpenCode's in-process
// plugin, rewritten to .js on install).
export function getBundledAgentStateReporterPath(): string | null {
  return getBundledHookReporterPath('sprintengine-agent-state.mjs')
}

// The status-line forwarder, shipped by the same `resources/hooks` entry. Only
// the Claude-family specs that declare `statusLine: true` install it.
export function getBundledStatusLineForwarderPath(): string | null {
  return getBundledHookReporterPath('sprintengine-status-line.mjs')
}

// The app's own plugin marketplace, shipped by the `resources/studio-plugin`
// extraResources entry. Same packaged/dev shape as the reporter resolver above;
// null when the entry did not ship, which the service reports rather than
// installing an empty plugin into every workspace.
export function getBundledStudioPluginRoot(): string | null {
  const relative = ['studio-plugin']
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, ...relative)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', ...relative),
    join(app.getAppPath(), 'resources', ...relative),
    join(__dirname, '..', '..', 'resources', ...relative),
    join(__dirname, '..', '..', '..', 'resources', ...relative),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// A directory the build ships under resources (`wsl-helper`, `hooks`,
// `automation`), with the same packaged and dev lookups as the ones above.
export function getBundledResourceDir(name: string): string | null {
  if (app.isPackaged) {
    const packaged = join(process.resourcesPath, name)
    return existsSync(packaged) ? packaged : null
  }
  const candidates = [
    join(process.cwd(), 'resources', name),
    join(app.getAppPath(), 'resources', name),
    join(__dirname, '..', '..', 'resources', name),
    join(__dirname, '..', '..', '..', 'resources', name),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

// The template name comes from a plugin manifest; constrain it to a bare
// filename so a hostile manifest cannot path-traverse out of resources/hooks.
export function getBundledAgentStateReporterTemplatePath(template: string): string | null {
  if (!template || template.includes('/') || template.includes('\\') || template.includes('..')) return null
  return getBundledHookReporterPath(template)
}
