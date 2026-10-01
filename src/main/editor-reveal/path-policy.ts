// Which files an agent may put in front of the person, and how its spelling of
// a path becomes one this machine can open.
//
// Three tiers, decided on the file's REAL path (symlinks resolved), because the
// containment helpers in `path-containment.ts` deliberately compare the path a
// caller handed over rather than the inode it lands on — and a symlink in the
// repository pointing at `~/.ssh/id_ed25519` is exactly the case this has to
// see through:
//
//   1. Inside the workspace folder, the agent's working directory, its
//      worktree, or any worktree of that repository → opened.
//   2. Outside all of those, but a file this agent session reported writing
//      (its edit hooks, the same feed its changelist is built from) → opened.
//      That is the patch it wrote to /tmp for the person to copy to a VM.
//   3. Anything else → the person decides: "Claude wants to show you <path>",
//      Open or Dismiss.
//
// And one set is never shown, whatever the tier: credentials (`~/.ssh`,
// `~/.aws`, `~/.gnupg`, `~/.config/gh` and its Windows home, `~/.netrc`,
// `~/.git-credentials`, `~/.kube`, `~/.docker`, keychains) and the app's own
// user-data folder. Reading them is not the danger — the agent runs as the
// person and can read them already — putting one on screen, where it can be
// screenshotted or shared, is.
//
// A paired remote device gets tier 1 only: it is a different machine asking,
// and "this agent wrote it" is a claim about a local session it does not have.
//
// WSL: an agent in a distribution speaks Linux paths. A relative path is joined
// onto its working directory in LINUX form first (joining `src/a.ts` onto a
// `\\wsl.localhost\…` cwd with Windows rules would be right by luck), then the
// whole thing is converted with `wslToWindowsPath`. The result carries both
// spellings: `path` for this machine, `displayPath` for the agent.

import { posix, resolve as resolveNative, isAbsolute as isAbsoluteNative } from 'node:path'

import { comparablePath, isWindowsPath, toWslPath, wslToWindowsPath } from '../../shared/host-paths'
import type { EditorRevealReason } from '../../shared/editor-reveal'

/** The file-system reads the policy needs, injected so the tiers are testable. */
export type PathPolicyFs = {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
  readFile(path: string): Promise<Buffer>
}

/** Where the agent is, as far as resolving its paths goes. */
export type AgentPathContext = {
  /** The directory a relative path is relative to, in this machine's spelling. Null: none known. */
  cwd: string | null
  /** Present when the agent runs inside a WSL distribution. */
  wsl: { distro: string | null } | null
  homeDir: string
}

export type ResolvedAgentPath = { path: string; displayPath: string }

/**
 * An agent's path in this machine's spelling.
 *
 * `~/` is expanded against this machine's home — except under WSL, where the
 * Linux home is not known here and a guess would open the wrong file.
 */
export function resolveAgentPath(
  raw: string,
  context: AgentPathContext,
): { ok: true; value: ResolvedAgentPath } | { ok: false; message: string } {
  const input = raw.trim()
  if (context.wsl) {
    if (isWindowsPath(input)) return { ok: true, value: { path: input, displayPath: input } }
    if (input === '~' || input.startsWith('~/')) {
      return { ok: false, message: `"${input}": give the absolute Linux path; the WSL home is not known here.` }
    }
    let linux = input.replace(/\\/g, '/')
    if (!linux.startsWith('/')) {
      if (!context.cwd)
        return { ok: false, message: `"${input}" is relative and this connection has no working directory.` }
      linux = posix.join(toWslPath(context.cwd), linux)
    }
    linux = posix.normalize(linux)
    const host = wslToWindowsPath(linux, { distro: context.wsl.distro ?? undefined })
    if (host === linux && !linux.startsWith('/mnt/')) {
      // Without the distribution there is no Windows spelling for a path
      // inside it, and opening `/home/…` on Windows opens nothing.
      return { ok: false, message: `"${input}": the WSL distribution this agent runs in is not known.` }
    }
    return { ok: true, value: { path: host, displayPath: linux } }
  }

  let path = input
  if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
    path = context.homeDir + path.slice(1)
  }
  if (!isAbsoluteNative(path)) {
    if (!context.cwd)
      return { ok: false, message: `"${input}" is relative and this connection has no working directory.` }
    path = resolveNative(context.cwd, path)
  } else {
    path = resolveNative(path)
  }
  return { ok: true, value: { path, displayPath: path } }
}

export type PathTrust = {
  /** Tier 1, already real (symlinks resolved) where they exist. */
  trustedRoots: readonly string[]
  /** Tier 2: `comparablePath` spellings of every file this agent session wrote. */
  agentWritten: ReadonlySet<string>
  /** A paired remote device: tier 1 only. */
  remote: boolean
  homeDir: string
  userDataDir: string
}

export type PathClassification =
  | { status: 'opened'; realPath: string; lineCount: number; tier: 'workspace' | 'agent_written' }
  | { status: 'awaiting_owner'; realPath: string; reason: 'outside_workspace' }
  | { status: 'refused'; reason: EditorRevealReason; message: string }

/** Past this the editor would not open it either (`MAX_TEXT_FILE_READ_BYTES`). */
export const EDITOR_REVEAL_MAX_BYTES = 5 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8_000

/** `child` is `root` or under it, compared the way two spellings of one folder agree. */
export function isInsideComparable(root: string, child: string): boolean {
  const base = comparablePath(root)
  const target = comparablePath(child)
  if (!base) return false
  if (target === base) return true
  return target.startsWith(base.endsWith('/') ? base : `${base}/`)
}

// Credential stores directly under a home directory. Matched on the comparable
// path so a Linux home inside a distribution (`//wsl.localhost/ubuntu/home/dev`)
// and a macOS or Windows home are all caught, not only this machine's own.
const HOME_ANCHOR = String.raw`(?:^|/)(?:home/[^/]+|users/[^/]+|root)/`
const SENSITIVE_UNDER_HOME = new RegExp(
  `${HOME_ANCHOR}(?:\\.ssh|\\.aws|\\.gnupg|\\.config/gh|\\.kube|\\.docker|appdata/roaming/github cli|library/keychains)(?:/|$)`,
  'i',
)
const SENSITIVE_FILE_UNDER_HOME = new RegExp(`${HOME_ANCHOR}(?:\\.netrc|_netrc|\\.git-credentials)$`, 'i')
const HOME_RELATIVE_SENSITIVE = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.kube',
  '.docker',
  'AppData/Roaming/GitHub CLI',
  'Library/Keychains',
  '.netrc',
  '_netrc',
  '.git-credentials',
]

/** A credential store or the app's own data — never shown, whoever asks. */
export function isSensitivePath(path: string, trust: Pick<PathTrust, 'homeDir' | 'userDataDir'>): boolean {
  const comparable = comparablePath(path)
  if (SENSITIVE_UNDER_HOME.test(comparable) || SENSITIVE_FILE_UNDER_HOME.test(comparable)) return true
  if (/\.keychain(?:-db)?$/i.test(comparable)) return true
  if (trust.userDataDir && isInsideComparable(trust.userDataDir, path)) return true
  if (trust.homeDir) {
    for (const entry of HOME_RELATIVE_SENSITIVE) {
      if (isInsideComparable(`${trust.homeDir.replace(/[\\/]+$/, '')}/${entry}`, path)) return true
    }
  }
  return false
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 1
  let lines = 1
  for (const byte of content) if (byte === 0x0a) lines += 1
  // A trailing newline ends the last line rather than starting another.
  return content[content.length - 1] === 0x0a ? lines - 1 : lines
}

function looksBinary(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.length, BINARY_SNIFF_BYTES))
  if (sample.length === 0) return false
  let control = 0
  for (const byte of sample) {
    if (byte === 0) return true
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x1b) control += 1
  }
  return control / sample.length > 0.3
}

/**
 * The agent wrote THIS file: the real file is one it reported, or the path it
 * reported leads to it through its folders only. A path it wrote that has since
 * become a symlink to something else is not what it wrote.
 */
async function wroteThisFile(
  path: string,
  realPath: string,
  written: ReadonlySet<string>,
  fs: PathPolicyFs,
): Promise<boolean> {
  if (written.has(comparablePath(realPath))) return true
  if (!written.has(comparablePath(path))) return false
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separator <= 0) return false
  const folder = await fs.realpath(path.slice(0, separator)).catch(() => null)
  if (!folder) return false
  return comparablePath(`${folder}/${path.slice(separator + 1)}`) === comparablePath(realPath)
}

/**
 * Decide one resolved path. Sensitive paths are refused before the file system
 * is touched and again after the real path is known, so neither a direct
 * spelling nor a symlink reaches one.
 */
export async function classifyAgentPath(path: string, trust: PathTrust, fs: PathPolicyFs): Promise<PathClassification> {
  if (isSensitivePath(path, trust)) {
    return { status: 'refused', reason: 'sensitive_path', message: 'Credential stores and app data are never shown.' }
  }
  let realPath: string
  try {
    realPath = await fs.realpath(path)
  } catch {
    return { status: 'refused', reason: 'not_found', message: 'No file at that path.' }
  }
  if (isSensitivePath(realPath, trust)) {
    return {
      status: 'refused',
      reason: 'sensitive_path',
      message: 'That path leads to a credential store or app data, which are never shown.',
    }
  }
  let size: number
  try {
    const stat = await fs.stat(realPath)
    if (!stat.isFile()) return { status: 'refused', reason: 'not_found', message: 'That path is a folder, not a file.' }
    size = stat.size
  } catch {
    return { status: 'refused', reason: 'not_found', message: 'No file at that path.' }
  }
  if (size > EDITOR_REVEAL_MAX_BYTES) {
    return { status: 'refused', reason: 'too_large', message: 'The file is larger than the editor opens (5 MB).' }
  }

  const insideTrusted = trust.trustedRoots.some((root) => isInsideComparable(root, realPath))
  const written = !trust.remote && (await wroteThisFile(path, realPath, trust.agentWritten, fs))
  if (!insideTrusted && !written) {
    if (trust.remote) {
      return {
        status: 'refused',
        reason: 'outside_workspace',
        message: 'A paired device can only show files inside the workspace.',
      }
    }
    return { status: 'awaiting_owner', realPath, reason: 'outside_workspace' }
  }

  let content: Buffer
  try {
    content = await fs.readFile(realPath)
  } catch {
    return { status: 'refused', reason: 'not_found', message: 'The file could not be read.' }
  }
  if (looksBinary(content)) {
    return { status: 'refused', reason: 'binary', message: 'The file is binary; the editor shows text.' }
  }
  return {
    status: 'opened',
    realPath,
    lineCount: countLines(content),
    tier: insideTrusted ? 'workspace' : 'agent_written',
  }
}

/**
 * The name the person and the agent use: relative to the workspace folder when
 * it is inside it, otherwise the agent's own spelling.
 */
export function displayPathFor(resolved: ResolvedAgentPath, workspaceRoot: string | null): string {
  if (workspaceRoot && isInsideComparable(workspaceRoot, resolved.path)) {
    const base = comparablePath(workspaceRoot)
    const target = comparablePath(resolved.path)
    const relative = target.slice(base.length).replace(/^\/+/, '')
    if (relative) {
      // `comparablePath` lower-cases a drive path; take the same span of the
      // original so the name keeps the file's own casing.
      const original = resolved.path.replace(/\\/g, '/')
      return original.slice(original.length - relative.length)
    }
  }
  return resolved.displayPath
}
