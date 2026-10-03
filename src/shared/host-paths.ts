// =============================================================================
// Paths across the Windows ↔ WSL boundary
//
// One file names a folder three ways on a Windows machine that runs agents in
// WSL: `C:\Users\dev\repo` (Windows), `/mnt/c/Users/dev/repo` (the same drive
// seen from Linux) and, for a folder inside a distribution,
// `\\wsl.localhost\Ubuntu\home\dev\repo` (Windows) against `/home/dev/repo`
// (Linux). Every conversion between them lives here, pure and free of Node, so
// main and the renderer cannot drift into two answers for the same path.
//
// Nothing here touches the file system or asks WSL anything: a distribution is
// only ever known from a path that names it, or from the caller.
// =============================================================================

const DRIVE_PATH = /^([A-Za-z]):(?:\/(.*))?$/u
// `//wsl$/<distro>/…` and `//wsl.localhost/<distro>/…`, after separators are
// normalized. The share names are case-insensitive on the Windows side.
const WSL_SHARE_PATH = /^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/iu
const WSL_DRIVE_MOUNT = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u

function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/** True for `C:\…`, `C:/…` and any UNC path — a path Windows opens as it is. */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith('\\\\')
}

/**
 * The distribution a `\\wsl$\<distro>\…` or `\\wsl.localhost\<distro>\…` path
 * lives in, or null for any other path. Either separator is accepted.
 */
export function distroOfUncPath(path: string): string | null {
  const share = WSL_SHARE_PATH.exec(forwardSlashes(path))
  return share ? share[1] : null
}

/**
 * A path as a Linux process under WSL sees it.
 *
 *   C:\Users\dev\repo                     → /mnt/c/Users/dev/repo
 *   \\wsl$\Ubuntu\home\dev\repo           → /home/dev/repo
 *   \\wsl.localhost\Ubuntu\home\dev\repo  → /home/dev/repo
 *
 * A path already in Linux form comes back with its separators normalized, so
 * the conversion is idempotent. The distribution in a share path is dropped
 * here; `distroOfUncPath` reads it, and the launch passes it to `wsl.exe -d`.
 */
export function toWslPath(path: string, options: WslDriveMountOptions = {}): string {
  const normalized = forwardSlashes(path)
  const drive = DRIVE_PATH.exec(normalized)
  if (drive) return `${driveMountRootOf(options)}${drive[1].toLowerCase()}/${drive[2] ?? ''}`
  const share = WSL_SHARE_PATH.exec(normalized)
  if (share) return share[2] ?? '/'
  return normalized
}

/**
 * Where a distribution mounts the Windows drives. `/mnt/` unless its
 * `/etc/wsl.conf` says otherwise (`[automount] root = /` or `root = /win/`),
 * which only the distribution itself can tell; a Studio server inside it
 * learns the root and reports it, and every translation at the edge takes it
 * as given. Absent is the default.
 */
export type WslDriveMountOptions = { driveMountRoot?: string }

/** The default drive mount root, which `toWslPath` has always assumed. */
export const DEFAULT_WSL_DRIVE_MOUNT_ROOT = '/mnt/'

/**
 * A mount root as the translations use it: absolute, ending in one `/`.
 * Anything that is not an absolute Linux path is the default.
 */
export function normalizeDriveMountRoot(root: string | null | undefined): string {
  if (!root || !root.startsWith('/') || root.startsWith('//')) return DEFAULT_WSL_DRIVE_MOUNT_ROOT
  const trimmed = forwardSlashes(root).replace(/\/+$/u, '')
  return `${trimmed}/`
}

function driveMountRootOf(options: WslDriveMountOptions): string {
  return normalizeDriveMountRoot(options.driveMountRoot)
}

function driveMountPattern(root: string): RegExp {
  if (root === DEFAULT_WSL_DRIVE_MOUNT_ROOT) return WSL_DRIVE_MOUNT
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^${escaped}([A-Za-z])(?:/(.*))?$`, 'u')
}

/**
 * The drive mount root a distribution reports, from what its kernel lists
 * as mounted (`/proc/mounts`): a `9p` or `drvfs` mount whose source is a
 * drive (`C:\`). Null when no drive is mounted, which is automount off.
 */
export function driveMountRootFromMounts(procMounts: string): string | null {
  for (const line of procMounts.split(/\r?\n/u)) {
    const [source, mountPoint, fsType] = line.split(/\s+/u)
    if (!source || !mountPoint || !fsType) continue
    if (fsType !== '9p' && fsType !== 'drvfs') continue
    // Sources are escaped the octal way (`C:\134` for `C:\`).
    const drive = /^([A-Za-z]):(?:\\|\\134|\/)?/u.exec(source)
    if (!drive) continue
    const point = mountPoint.replace(/\\040/gu, ' ')
    const match = /^(.*\/)([A-Za-z])\/?$/u.exec(point)
    if (match && match[2].toLowerCase() === drive[1].toLowerCase()) return match[1]
  }
  return null
}

/**
 * The drive mount root `/etc/wsl.conf` asks for: its `[automount]` section's
 * `root`, or `/mnt/`; null when that section turns automount off.
 */
export function driveMountRootFromWslConf(text: string | null): string | null {
  if (!text) return DEFAULT_WSL_DRIVE_MOUNT_ROOT
  let section = ''
  let root: string | null = null
  let enabled = true
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/[#;].*$/u, '').trim()
    if (!line) continue
    const header = /^\[([^\]]+)\]$/u.exec(line)
    if (header) {
      section = header[1].trim().toLowerCase()
      continue
    }
    if (section !== 'automount') continue
    const pair = /^([A-Za-z]+)\s*=\s*(.*)$/u.exec(line)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].trim().replace(/^"(.*)"$/u, '$1')
    if (key === 'enabled') enabled = !/^(false|0|no)$/iu.test(value)
    if (key === 'root') root = value
  }
  return enabled ? normalizeDriveMountRoot(root) : null
}

export type WslToWindowsOptions = {
  /**
   * The distribution a Linux-absolute path belongs to. Given, `/home/dev`
   * becomes `\\wsl.localhost\<distro>\home\dev`; absent, a Linux path that is
   * not a `/mnt/<drive>` mount is returned unchanged, because Windows has no
   * way to open it without knowing which distribution holds it.
   */
  distro?: string
  /** Separator for the result. Git and Node accept `/` on Windows as well. */
  separator?: '\\' | '/'
} & WslDriveMountOptions

/**
 * A Linux path under WSL as Windows opens it.
 *
 *   /mnt/c/Users/dev/repo      → C:\Users\dev\repo
 *   /mnt/d                     → D:\
 *   /home/dev/repo  (Ubuntu)   → \\wsl.localhost\Ubuntu\home\dev\repo
 *
 * Anything else (a Windows path, a relative path) comes back unchanged.
 */
export function wslToWindowsPath(path: string, options: WslToWindowsOptions = {}): string {
  const separator = options.separator ?? '\\'
  const normalized = forwardSlashes(path)
  const mount = driveMountPattern(driveMountRootOf(options)).exec(normalized)
  if (mount) {
    const rest = (mount[2] ?? '').split('/').join(separator)
    return `${mount[1].toUpperCase()}:${separator}${rest}`
  }
  if (options.distro && normalized.startsWith('/') && !normalized.startsWith('//')) {
    return linuxPathUnderRoot(normalized, `\\\\wsl.localhost\\${options.distro}`, separator)
  }
  return path
}

/**
 * A Linux-absolute path joined onto the UNC root of the distribution that
 * holds it, as `wslpath -w /` prints that root (`\\wsl.localhost\Ubuntu\`).
 */
export function linuxPathUnderRoot(linuxPath: string, root: string, separator: '\\' | '/' = '\\'): string {
  const base = forwardSlashes(root).replace(/\/+$/u, '')
  const rest = forwardSlashes(linuxPath)
    .split('/')
    .filter((segment) => segment.length > 0)
  return [base, ...rest].join('/').replace(/\//g, separator)
}

/**
 * A path reduced to a form two spellings of the same folder agree on:
 * forward slashes, no trailing slash, `/mnt/<drive>` read as the drive, and
 * drive paths lower-cased (Windows compares them without regard to case).
 *
 * A distribution's share has two names, `\\wsl$\<distro>` and
 * `\\wsl.localhost\<distro>`, and Windows reads both, like the distribution
 * name in them, without regard to case. Both are read as
 * `//wsl.localhost/<distro>` with those two parts lower-cased; the Linux path
 * after them is case-sensitive and kept as it is. Git's output for a WSL
 * repository is always spelled the `wsl.localhost` way, so a workspace stored
 * under `\\wsl$\` still compares equal to its own repository root.
 */
export function comparablePath(path: string): string {
  const normalized = forwardSlashes(path).replace(/\/+$/u, '')
  const share = WSL_SHARE_PATH.exec(normalized)
  if (share) return `//wsl.localhost/${share[1].toLowerCase()}${share[2] ?? ''}`
  const mount = WSL_DRIVE_MOUNT.exec(normalized)
  const comparable = mount ? `${mount[1].toUpperCase()}:/${mount[2] ?? ''}` : normalized
  return /^[A-Za-z]:/u.test(comparable) ? comparable.toLowerCase() : comparable
}

/** True when `path` looks like a WSL path to a Windows drive (`/mnt/c/…`). */
export function isWslDriveMountPath(path: string): boolean {
  return WSL_DRIVE_MOUNT.test(forwardSlashes(path))
}

/**
 * One absolute Linux path from an agent running in WSL, spelled the way the
 * workspace root is spelled on Windows, with `/` separators (Node and git on
 * Windows read them).
 *
 *   /mnt/c/Users/dev/repo/a.ts  (root C:\Users\dev\repo)                   → C:/Users/dev/repo/a.ts
 *   /home/dev/repo/a.ts         (root \\wsl$\Ubuntu\home\dev\repo)         → //wsl$/Ubuntu/home/dev/repo/a.ts
 *   /home/dev/repo/a.ts         (root \\wsl.localhost\Ubuntu\home\dev\repo) → //wsl.localhost/Ubuntu/home/dev/repo/a.ts
 *
 * A share root keeps its own share name, so a comparison with it is like for
 * like. Anything that is not an absolute Linux path comes back unchanged.
 */
export function wslPathInRootSpelling(path: string, root: string, distro: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) return path
  if (WSL_DRIVE_MOUNT.test(path)) return wslToWindowsPath(path, { separator: '/' })
  const share = WSL_SHARE_PATH.test(forwardSlashes(root)) ? /^\/\/([^/]+)\/([^/]+)/u.exec(forwardSlashes(root)) : null
  if (share) return `//${share[1]}/${share[2]}${path}`
  return wslToWindowsPath(path, { distro, separator: '/' })
}

/**
 * A tool call's input from an agent running in WSL, with every absolute Linux
 * path in it spelled the way the workspace root is spelled on Windows.
 *
 * Approval checks — what a permission mode lets through, what a remembered
 * "always allow" covers — place a request by comparing its paths with the
 * workspace root as strings. The agent names `/mnt/c/Users/dev/repo/a.ts` or
 * `/home/dev/repo/a.ts`; the root is `C:\Users\dev\repo` or
 * `\\wsl.localhost\Ubuntu\home\dev\repo`. Compared as they come, every file in
 * the workspace reads as outside it, and Auto approves nothing.
 *
 * Only for a session that really runs in WSL, which the caller knows and this
 * cannot: a native Windows agent naming `/mnt/c/…` means `C:\mnt\c\…`, and
 * translating that would place a file outside the workspace inside it.
 *
 * A share root keeps its own share name (`wsl$` or `wsl.localhost`) so the
 * comparison is like for like. The input itself is never changed: this is a
 * copy for the checks, and the agent still gets back what it sent.
 */
export function wslInputInRootSpelling(value: unknown, root: string, distro: string): unknown {
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      // One whole path: absolute, not a UNC path, no whitespace. A command line
      // that mentions a path is not respelled — a mode never answers commands,
      // and a remembered command grant does not read its paths this way.
      return entry.startsWith('/') && !entry.startsWith('//') && !/\s/u.test(entry)
        ? wslPathInRootSpelling(entry, root, distro)
        : entry
    }
    if (Array.isArray(entry)) return entry.map(visit)
    if (entry && typeof entry === 'object')
      return Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, visit(inner)]))
    return entry
  }
  return visit(value)
}
