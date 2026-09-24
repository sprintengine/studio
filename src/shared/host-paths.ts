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
export function toWslPath(path: string): string {
  const normalized = forwardSlashes(path)
  const drive = DRIVE_PATH.exec(normalized)
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2] ?? ''}`
  const share = WSL_SHARE_PATH.exec(normalized)
  if (share) return share[2] ?? '/'
  return normalized
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
}

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
  const mount = WSL_DRIVE_MOUNT.exec(normalized)
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
