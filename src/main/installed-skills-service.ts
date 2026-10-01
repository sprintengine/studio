import { createHash } from 'node:crypto'
import { distroOfHostId } from '../shared/execution-host'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path, { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { PluginRegistryListEntry } from '../shared/plugin-manifest'
import type {
  InstalledSkill,
  InstalledSkillRemoveInput,
  InstalledSkillRemoveResult,
  InstalledSkillsInput,
  InstalledSkillsResult,
} from '../shared/installed-skills'
import { parseSkillFrontmatter } from '../shared/skills'
import { skillsDirFromTemplate } from '../shared/harness-map'
import { parseCodexConfigTables } from './mcp-config-readers/codex'
import { resolveClaudeConfigDir } from './claude-config-dir'
import { isWslDriveMountPath, wslToWindowsPath } from '../shared/host-paths'
import type { WslHome } from './wsl-home'

type Root = { path: string; scope: InstalledSkill['scope']; origin: string; managed?: boolean }
/** `path.win32` or `path.posix`: the helpers below take either, so tests can speak Windows. */
type PathApi = typeof path.win32
type Options = {
  listPlugins: () => PluginRegistryListEntry[]
  trashItem: (path: string) => Promise<void>
  homeDir?: string
  env?: NodeJS.ProcessEnv
  /** Resolves the WSL side for a session that runs its CLI there. Windows only. */
  // `distro` is the machine's (`wsl:<distro>`); absent, the default distribution.
  probeWsl?: (distro?: string | null) => Promise<WslHome | null>
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

/**
 * Whether two paths name the same folder. Windows paths compare without regard
 * to case or separator: the workspace root, the CLI's own receipts and the home
 * directory each spell the same folder their own way (`C:\Users\dev` from the
 * OS, `c:/Users/dev` from a picker), and an exact string compare quietly drops
 * the match.
 */
export function samePath(a: string, b: string, api: PathApi = path): boolean {
  const left = api.resolve(a)
  const right = api.resolve(b)
  return api.sep === '\\' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * A path a CLI running inside WSL wrote (a plugin receipt's install path, a
 * configured skills folder) as this process can open it: `/mnt/c/...` is the
 * Windows drive, any other absolute path lives under the distribution root.
 */
export function wslToHost(value: string, root: string, api: PathApi = path): string {
  if (isWslDriveMountPath(value)) return api.normalize(wslToWindowsPath(value))
  return value.startsWith('/') ? api.join(root, value) : value
}

type ReceiptRoot = { path: string; scope: InstalledSkill['scope']; origin: string }

/**
 * The skill folders a Claude plugin receipt (`plugins/installed_plugins.json`)
 * vouches for. Receipts are authoritative; a cache directory by itself is not
 * evidence of an installed plugin. Two shapes exist: the current one keeps a
 * list of installations per plugin, the older one a single object with no
 * scope, which was always a user install. A project installation counts when
 * its folder is the project being listed or one of its checkout ancestors,
 * compared as paths rather than strings.
 */
export function claudeReceiptRoots(
  data: unknown,
  projectFolders: readonly string[],
  options: { api?: PathApi; hostPath?: (value: string) => string } = {},
): ReceiptRoot[] {
  const api = options.api ?? path
  const hostPath = options.hostPath ?? ((value: string) => value)
  const plugins = (data as { plugins?: unknown } | null)?.plugins
  if (!plugins || typeof plugins !== 'object') return []
  const roots: ReceiptRoot[] = []
  for (const [name, entry] of Object.entries(plugins as Record<string, unknown>)) {
    const installs: unknown[] = Array.isArray(entry) ? entry : entry && typeof entry === 'object' ? [entry] : []
    for (const candidate of installs) {
      const install = candidate as Record<string, unknown> | null
      if (!install || typeof install.installPath !== 'string') continue
      const scope = install.scope === undefined || install.scope === 'user' ? 'global' : 'project'
      if (scope === 'project') {
        const projectPath = typeof install.projectPath === 'string' ? hostPath(install.projectPath) : null
        if (!projectPath || !projectFolders.some((folder) => samePath(folder, projectPath, api))) continue
      }
      roots.push({ path: api.join(hostPath(install.installPath), 'skills'), scope, origin: `Plugin: ${name}` })
    }
  }
  return roots
}

/** Discovery is independent of the catalogue and never installs anything. */
export function createInstalledSkillsService(options: Options) {
  const hostHome = options.homeDir ?? homedir()
  const hostEnv = options.env ?? process.env
  // A removal must refer to the exact entry we showed, including its inode.
  // Re-scanning alone would authorize a replacement created after the dialog.
  const observed = new Map<string, { path: string; fingerprint: string; context: string }>()
  const contextKey = (input: InstalledSkillsInput) =>
    JSON.stringify([input.workspaceRoot, input.pluginId, input.pathStyle === 'wsl', input.hostId ?? null])

  async function rootsFor(input: InstalledSkillsInput, diagnostics: string[]): Promise<Root[]> {
    const plugin = options.listPlugins().find((entry) => entry.id === input.pluginId)
    const integration = plugin?.skillIntegration
    if (!integration || integration.support === 'unsupported')
      throw new Error('This CLI does not declare skill support.')
    // A CLI that runs inside WSL reads its user folders from the Linux home,
    // not from the Windows profile this process sees. The project folder is
    // the same files either way: the launch `cd`s into it through /mnt.
    let wsl: WslHome | null = null
    if (input.pathStyle === 'wsl') {
      wsl = options.probeWsl ? await options.probeWsl(distroOfHostId(input.hostId)).catch(() => null) : null
      if (!wsl) diagnostics.push('Could not read the WSL home folder, so skills installed inside WSL are not listed.')
    }
    const home = wsl?.home ?? hostHome
    const env = wsl?.env ?? hostEnv
    const hostPath = (value: string) => (wsl ? wslToHost(value, wsl.root) : value)
    const roots: Root[] = []
    const add = (path: string, scope: Root['scope'], origin = plugin.displayName, managed = false) => {
      const absolute = resolve(path)
      if (!roots.some((root) => samePath(root.path, absolute))) roots.push({ path: absolute, scope, origin, managed })
    }
    const harness = integration.harnessId
    const nativeDir = integration.installTargets
      .filter((target) => target.scope === 'workspace')
      .map((target) => skillsDirFromTemplate(target.path))
      .find((path) => path !== null)
    const projectFolders = input.workspaceRoot ? [resolve(input.workspaceRoot)] : []
    // CLIs inherit repository skills when launched in a package or worktree.
    // Stop at the checkout's .git file/directory, never at the primary checkout.
    if (input.workspaceRoot) {
      const ancestors: string[] = []
      let folder = resolve(input.workspaceRoot)
      while (true) {
        try {
          await stat(join(folder, '.git'))
          projectFolders.push(...ancestors)
          break
        } catch (error) {
          if (!missing(error)) break
        }
        const parent = dirname(folder)
        if (parent === folder || samePath(parent, home)) break
        ancestors.push(parent)
        folder = parent
      }
    }
    // The manifest owns the project location; user roots below reflect the
    // CLI's discovery convention, including its config-home override.
    if (nativeDir) for (const folder of projectFolders) add(join(folder, nativeDir), 'project')
    const cliHome =
      harness === 'codex'
        ? env.CODEX_HOME || join(home, '.codex')
        : harness === 'claude'
          ? resolveClaudeConfigDir(home, env)
          : harness === 'opencode'
            ? join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode')
            : join(home, `.${harness}`)
    add(join(cliHome, 'skills'), 'global')
    if (harness === 'codex' || harness === 'opencode' || harness === 'gemini') {
      for (const folder of projectFolders) add(join(folder, '.agents/skills'), 'project', 'Shared skills')
      add(join(home, '.agents/skills'), 'global', 'Shared skills')
    }
    if (harness === 'opencode' || harness === 'grok') {
      for (const folder of projectFolders) add(join(folder, '.claude/skills'), 'project', 'Shared with Claude Code')
      add(join(resolveClaudeConfigDir(home, env), 'skills'), 'global', 'Shared with Claude Code')
    }
    if (harness === 'grok' || harness === 'gemini') {
      const directory = harness === 'grok' ? 'plugins' : 'extensions'
      for (const [folder, scope] of [
        [cliHome, 'global'],
        ...projectFolders.map((folder) => [join(folder, `.${harness}`), 'project']),
      ] as [string, Root['scope']][]) {
        try {
          for (const name of await readdir(join(folder, directory))) {
            if (name.startsWith('.') || name === 'cache' || name === 'marketplaces') continue
            add(join(folder, directory, name, 'skills'), scope, `Plugin: ${name}`, true)
          }
        } catch (error) {
          if (!missing(error)) diagnostics.push(`${folder}: ${message(error)}`)
        }
      }
    }
    if (harness === 'grok') {
      try {
        const config = await readFile(join(cliHome, 'config.toml'), 'utf8')
        const paths = parseCodexConfigTables(config, 'skills')['']?.paths
        if (Array.isArray(paths))
          for (const path of paths) {
            if (typeof path === 'string' && (isAbsolute(path) || (wsl && path.startsWith('/'))))
              add(hostPath(path), 'global', 'Configured skills folder')
          }
      } catch (error) {
        if (!missing(error)) diagnostics.push(`${cliHome}/config.toml: ${message(error)}`)
      }
    }
    if (harness === 'codex') {
      add(join(cliHome, 'skills/.system'), 'global', 'Built into Codex', true)
      add(hostPath('/etc/codex/skills'), 'global', 'Managed by administrator', true)
      // Only configured plugins contribute cache roots. Never advertise every
      // downloaded catalogue plugin as an installed skill.
      for (const config of [
        join(cliHome, 'config.toml'),
        ...(input.workspaceRoot ? [join(input.workspaceRoot, '.codex/config.toml')] : []),
      ]) {
        try {
          const plugins = parseCodexConfigTables(await readFile(config, 'utf8'), 'plugins')
          for (const [id, settings] of Object.entries(plugins)) {
            const [name, marketplace] = id.split('@')
            if (!name || !marketplace || ![name, marketplace].every((part) => /^[\w-]+$/.test(part))) continue
            const cache = join(cliHome, 'plugins/cache', marketplace, name)
            try {
              for (const version of await readdir(cache)) {
                const installed = join(cache, version)
                try {
                  const manifest = JSON.parse(await readFile(join(installed, '.codex-plugin/plugin.json'), 'utf8')) as {
                    skills?: unknown
                  }
                  const paths =
                    typeof manifest.skills === 'string'
                      ? [manifest.skills]
                      : Array.isArray(manifest.skills)
                        ? manifest.skills.filter((value): value is string => typeof value === 'string')
                        : ['skills']
                  for (const path of paths)
                    add(
                      resolve(installed, path),
                      'global',
                      `Plugin: ${id}${settings.enabled === false ? ' (disabled)' : ''}`,
                      true,
                    )
                } catch (error) {
                  if (!missing(error)) diagnostics.push(`${installed}: ${message(error)}`)
                }
              }
            } catch (error) {
              if (!missing(error)) diagnostics.push(`${cache}: ${message(error)}`)
            }
          }
        } catch (error) {
          if (!missing(error)) diagnostics.push(`${config}: ${message(error)}`)
        }
      }
    }
    const receipt = join(cliHome, 'plugins/installed_plugins.json')
    try {
      const data: unknown = JSON.parse(await readFile(receipt, 'utf8'))
      for (const root of claudeReceiptRoots(data, projectFolders, { hostPath }))
        add(root.path, root.scope, root.origin, true)
    } catch (error) {
      if (!missing(error)) diagnostics.push(`Cannot read plugin installations: ${message(error)}`)
    }
    return roots
  }

  async function fingerprint(path: string): Promise<string> {
    const entry = await lstat(path)
    const content = await readFile(join(path, 'SKILL.md'))
    return createHash('sha256')
      .update(`${entry.dev}:${entry.ino}:${entry.mtimeMs}:`)
      .update(await realpath(path))
      .update(content)
      .digest('hex')
  }

  async function list(input: InstalledSkillsInput): Promise<InstalledSkillsResult> {
    try {
      if (
        !input ||
        typeof input.pluginId !== 'string' ||
        (input.workspaceRoot !== null && (typeof input.workspaceRoot !== 'string' || !isAbsolute(input.workspaceRoot)))
      ) {
        return { ok: false, message: 'Choose an agent CLI and an absolute project folder.' }
      }
      const diagnostics: string[] = []
      const roots = await rootsFor(input, diagnostics)
      const skills: InstalledSkill[] = []
      await Promise.all(
        roots.map(async (root) => {
          let entries: string[]
          try {
            entries = await readdir(root.path)
          } catch (error) {
            if (!missing(error)) diagnostics.push(`${root.path}: ${message(error)}`)
            return
          }
          for (const name of entries.sort()) {
            if (name.startsWith('.')) continue
            const path = join(root.path, name)
            try {
              if (!(await stat(path)).isDirectory()) continue
              const text = await readFile(join(path, 'SKILL.md'), 'utf8')
              const metadata = parseSkillFrontmatter(text)
              const entry = await lstat(path)
              const stamp = await fingerprint(path)
              const id = createHash('sha256')
                .update(`${contextKey(input)}:${path}:${stamp}`)
                .digest('hex')
              // A symlinked parent is shared storage. Removing its child would
              // mutate the shared target; only a leaf symlink is safe to unlink.
              const sharedParent = (await realpath(dirname(path))) !== resolve(dirname(path))
              const removable = !root.managed && !sharedParent
              skills.push({
                id,
                name: metadata.name || basename(path),
                description: metadata.description || '',
                path,
                scope: root.scope,
                origin: root.origin,
                linked: entry.isSymbolicLink(),
                removable,
                ...(!removable
                  ? {
                      removalNote: root.managed
                        ? 'Managed by its plugin or administrator.'
                        : 'This skills folder links to shared storage. Manage it at the source.',
                    }
                  : {}),
              })
              observed.set(id, { path, fingerprint: stamp, context: contextKey(input) })
              if (observed.size > 10000) observed.delete(observed.keys().next().value!)
            } catch (error) {
              if (!missing(error)) diagnostics.push(`${path}: ${message(error)}`)
            }
          }
        }),
      )
      return {
        ok: true,
        skills: skills.sort(
          (a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
        ),
        diagnostics,
      }
    } catch (error) {
      return { ok: false, message: message(error) }
    }
  }

  async function remove(input: InstalledSkillRemoveInput): Promise<InstalledSkillRemoveResult> {
    const seen = observed.get(input?.installationId)
    if (!seen || seen.context !== contextKey(input))
      return { ok: false, message: 'Refresh the skill inventory before removing this installation.' }
    try {
      const current = await list(input)
      if (!current.ok) return current
      const skill = current.skills.find((row) => row.id === input.installationId)
      if (!skill || (await fingerprint(seen.path)) !== seen.fingerprint)
        return { ok: false, message: 'This installation changed. Refresh and review it again.' }
      if (!skill.removable) return { ok: false, message: skill.removalNote || 'This skill is managed.' }
      await options.trashItem(seen.path)
      observed.delete(input.installationId)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: message(error) }
    }
  }
  return { list, remove }
}
