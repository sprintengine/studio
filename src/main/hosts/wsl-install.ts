// Putting the helper and its Node into a distribution, and starting it.
//
// Everything lands under `~/.local/share/sprintengine-studio/`:
//
//   runtime/node-<version>/bin/node    the pinned Node (`wsl-node-runtime.ts`)
//   <appVersion>/wsl-helper/…          the helper
//   <appVersion>/hooks/…               the hook reporters and status line
//   <appVersion>/automation/…          the MCP bridge
//   <appVersion>/plugin/…              the Claude plugin copy (written later,
//                                      by the helper itself; see `wsl-host.ts`)
//   server-<appVersion>/…              the Studio server a distribution's chats
//                                      run on (phase 7), a tree of its own with
//                                      its own marker, so a person who uses WSL
//                                      only for terminals never receives it
//   data/, data-<profile>/             that server's data, never pruned
//
// Each tree is installed the same way, and atomically:
//
//   1. a `sh -s` script makes a private staging directory;
//   2. the archive is streamed over `wsl.exe`'s stdin straight into
//      `tar -x` there (`--exec tar`, never a shell: see below);
//   3. a second `sh -s` script takes the install lock, checks the staged tree
//      (for Node, that `node --version` runs and says the pinned version),
//      writes a ready marker holding the archive's digest into it, and moves
//      it into place. Older versions are pruned, except any a running process
//      still uses. The lock, the liveness check and the move are the ones an
//      SSH machine's install runs too (`remote-install.ts`).
//
// A later start trusts a tree only when its marker holds the expected digest.
// When a start with a trusted Node still fails to run the helper, the Node
// marker is removed, so the next start installs Node again rather than
// failing the same way forever.
//
// Why the archive does not follow the script on one stdin: `sh` on Debian and
// Ubuntu is dash, which reads its script from a pipe in blocks, so the first
// bytes of an archive written after the script would be swallowed as script.
// Scripts go to `sh -s`; archives go to `tar` alone, with an argv that holds no
// quotes, spaces or `$` (a staging path relative to `--cd ~`), which is the one
// kind of argv `wsl.exe` passes through intact.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

import {
  checkLines,
  COMMITTED_MARKER,
  FAIL_MARKER,
  hexToken as hex,
  NODE_RUNTIME_REL,
  plainToken as token,
  posixInstallFunctions,
  pruneLines,
  PRUNE_GLOBS,
  REMOTE_DATA_REL,
  serverTreeName,
} from './remote-install'
import { WSL_NODE_VERSION, type WslNodePackage } from './wsl-node-runtime'

export { COMMITTED_MARKER, commitFailure, FAIL_MARKER, PRUNE_GLOBS, serverTreeName } from './remote-install'

/** The data root, relative to the Linux home: the same on every POSIX host. */
export const WSL_DATA_REL = REMOTE_DATA_REL

export type WslLaunchScriptInput = {
  appVersion: string
  /** The pinned archives' digests; the Node marker must hold one of them. */
  nodeDigests: readonly string[]
  /** The digest of the tree this entry runs from: the helper's payload, or the server's. */
  appDigest: string
  profile: string
  /**
   * What to start: the helper (the default), or the Studio server, which
   * reads a bootstrap envelope on stdin (`--bootstrap stdio`). Either way a
   * missing tree is reported as `app`.
   */
  entry?: 'helper' | 'server'
}

export const NEED_MARKER = '@@SPRINTENGINE_NEED'
export const STAGED_MARKER = '@@SPRINTENGINE_STAGED'
/** The launch script's exit code when something has to be installed first. */
export const NEEDS_INSTALL_EXIT = 3

/**
 * The script `sh -s` runs to start the helper: it `exec`s Node on the helper
 * when both trees are installed with the expected digests, and otherwise
 * prints what is missing (with `uname -m`, and whether `xz` is there to unpack
 * the smaller Node archive) and exits 3.
 */
export function buildLaunchScript(input: WslLaunchScriptInput): string {
  const version = token(input.appVersion, 'The app version')
  const profile = token(input.profile, 'The profile id')
  const nodeDigests = input.nodeDigests.map((digest) => hex(digest, 'A Node digest')).join('|')
  const server = input.entry === 'server'
  const entryFile = server ? 'server.cjs' : 'wsl-helper/helper.mjs'
  return [
    'set -u',
    `base="$HOME/${WSL_DATA_REL}"`,
    `rt="$base/runtime/node-${WSL_NODE_VERSION}"`,
    `app="$base/${server ? serverTreeName(version) : version}"`,
    "need=''",
    'ok=0',
    `[ -x "$rt/bin/node" ] && case "$(cat "$rt/.ready" 2>/dev/null)" in ${nodeDigests}) ok=1 ;; esac`,
    '[ "$ok" = 1 ] || need="$need node"',
    `{ [ -f "$app/${entryFile}" ] && [ "$(cat "$app/.ready" 2>/dev/null)" = '${hex(input.appDigest, 'The app digest')}' ]; } || need="$need app"`,
    'if [ -n "$need" ]; then',
    '  xz=0; command -v xz >/dev/null 2>&1 && xz=1',
    `  printf '${NEED_MARKER}%s arch=%s xz=%s\\n' "$need" "$(uname -m)" "$xz"`,
    `  exit ${NEEDS_INSTALL_EXIT}`,
    'fi',
    server
      ? // The envelope follows on stdin, once the server has said `boot`.
        'exec "$rt/bin/node" "$app/server.cjs" --bootstrap stdio'
      : `exec "$rt/bin/node" "$app/wsl-helper/helper.mjs" --profile '${profile}'`,
  ].join('\n')
}

/**
 * The script `sh -s` runs for the stdio bridge (phase 7): the relay from the
 * installed server tree, on the pinned Node. It says it is ready before it
 * reads anything (`resources/wsl-server/bridge.mjs`).
 */
export function buildBridgeScript(appVersion: string): string {
  return [
    'set -u',
    `base="$HOME/${WSL_DATA_REL}"`,
    `exec "$base/runtime/node-${WSL_NODE_VERSION}/bin/node" "$base/${serverTreeName(appVersion)}/bridge.mjs"`,
  ].join('\n')
}

export type NeedReport = { node: boolean; app: boolean; arch: string; xz: boolean }

/** The launch script's `@@SPRINTENGINE_NEED` line, or null when it printed none. */
export function parseNeedReport(stdout: string): NeedReport | null {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith(NEED_MARKER))
  if (!line) return null
  const words = line.slice(NEED_MARKER.length).trim().split(/\s+/u)
  const field = (name: string) => words.find((word) => word.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
  return { node: words.includes('node'), app: words.includes('app'), arch: field('arch'), xz: field('xz') === '1' }
}

/** Where a staging directory sits, relative to the Linux home (so `--cd ~` reaches it). */
export function stageRel(stageId: string): string {
  return `${WSL_DATA_REL}/.stage/${token(stageId, 'The stage id')}`
}

/** Makes a fresh, private staging directory, and sweeps ones a crash left behind. */
export function buildStageScript(stageId: string): string {
  const id = token(stageId, 'The stage id')
  return [
    'set -eu',
    `base="$HOME/${WSL_DATA_REL}"`,
    'umask 077',
    'mkdir -p "$base/.stage"',
    `rm -rf "$base/.stage/${id}"`,
    `mkdir "$base/.stage/${id}"`,
    // A staging directory older than a day belongs to an install that died.
    'find "$base/.stage" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rm -rf {} + 2>/dev/null || true',
    `echo ${STAGED_MARKER}`,
  ].join('\n')
}

/** The `tar` argv that unpacks the streamed archive into the staging directory. */
export function tarArgs(kind: 'node', stageId: string, pkg: WslNodePackage): string[]
export function tarArgs(kind: 'app', stageId: string): string[]
export function tarArgs(kind: 'node' | 'app', stageId: string, pkg?: WslNodePackage): string[] {
  const dest = stageRel(stageId)
  if (kind === 'app') return ['tar', '-xzf', '-', '-C', dest]
  if (!pkg) throw new Error('A Node install needs its package.')
  // Only the binary: the rest of the archive (npm, headers) is two hundred
  // megabytes the helper never uses.
  return [
    'tar',
    pkg.compression === 'xz' ? '-xJf' : '-xzf',
    '-',
    '-C',
    dest,
    '--strip-components=1',
    `${token(pkg.dirName, 'The Node directory')}/bin/node`,
  ]
}

export type CommitInput =
  | { kind: 'node'; stageId: string; digest: string }
  | { kind: 'app' | 'server'; stageId: string; digest: string; appVersion: string }

/**
 * Checks the staged tree, marks it, moves it into place under the install
 * lock, and prunes older versions nothing is running from (the steps are
 * `remote-install.ts`'s, shared with SSH machines). Prints
 * `@@SPRINTENGINE_FAIL <reason>` and exits 4 when anything is wrong, leaving
 * what was installed before untouched.
 */
export function buildCommitScript(input: CommitInput): string {
  const id = token(input.stageId, 'The stage id')
  const digest = hex(input.digest, 'The digest')
  const final =
    input.kind === 'node'
      ? `$base/${NODE_RUNTIME_REL}`
      : input.kind === 'server'
        ? `$base/${serverTreeName(input.appVersion)}`
        : `$base/${token(input.appVersion, 'The app version')}`
  // Each kind prunes only its own trees. `data*/` matches none of these, so a
  // person's chats are never pruned.
  const prune = PRUNE_GLOBS[input.kind]
  const check =
    input.kind === 'node'
      ? checkLines('node', {})
      : input.kind === 'server'
        ? checkLines('server', { appVersion: input.appVersion })
        : ['[ -f "$stage/wsl-helper/helper.mjs" ] || fail "payload incomplete"']
  return [
    'set -u',
    `base="$HOME/${WSL_DATA_REL}"`,
    `id='${id}'`,
    `stage="$base/.stage/${id}"`,
    `final="${final}"`,
    ...posixInstallFunctions(),
    `fail() { printf '${FAIL_MARKER} %s\\n' "$*"; rm -rf "$stage"; [ "\${locked:-0}" = 1 ] && lock_drop; exit 4; }`,
    '[ -d "$stage" ] || fail "nothing staged"',
    'mkdir -p "$(dirname "$final")" || fail mkdir',
    'lock_take || fail "lock timeout"',
    'locked=1',
    ...check,
    `if [ "$(cat "$final/.ready" 2>/dev/null)" = '${digest}' ]; then`,
    '  rm -rf "$stage"',
    'else',
    `  printf '%s' '${digest}' > "$stage/.ready" || fail marker`,
    '  place "$stage" "$final" || fail move',
    'fi',
    ...pruneLines(prune),
    'lock_drop',
    `echo ${COMMITTED_MARKER}`,
  ].join('\n')
}

/** Drops the Node ready marker after a start that could not run the helper. */
export function buildUnreadyScript(): string {
  return `rm -f "$HOME/${WSL_DATA_REL}/runtime/node-${WSL_NODE_VERSION}/.ready"`
}

// ── The app payload ─────────────────────────────────────────────────────────

export type PayloadSource = { dir: string; into: string; filter?: (relativePath: string) => boolean }
export type AppPayload = { tarGz: Buffer; digest: string }

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * The helper, hooks and bridge as one gzipped tar, and the digest of what it
 * holds. Built the same byte for byte from the same files (sorted, with fixed
 * owners and times), so the digest changes exactly when a file does, and a
 * distribution already holding this build's payload is never sent it again.
 */
export function buildAppPayload(sources: readonly PayloadSource[]): AppPayload {
  const files: Array<{ path: string; data: Buffer }> = []
  for (const source of sources) {
    for (const path of walk(source.dir)) {
      const rel = relative(source.dir, path).split(sep).join('/')
      if (source.filter && !source.filter(rel)) continue
      files.push({ path: source.into ? `${source.into}/${rel}` : rel, data: readFileSync(path) })
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const tar = buildTar(files)
  return { tarGz: gzipSync(tar, { level: 9 }), digest: createHash('sha256').update(tar).digest('hex') }
}

// A minimal ustar writer: regular files and the directories above them, owned
// by nobody in particular, at the epoch. Enough for `tar -x` everywhere.
function header(name: string, size: number, type: '0' | '5', mode: number): Buffer {
  const block = Buffer.alloc(512)
  let path = name
  let prefix = ''
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 154)
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`Path too long for tar: ${name}`)
    prefix = path.slice(0, cut)
    path = path.slice(cut + 1)
  }
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0'
  block.write(path, 0, 100, 'utf8')
  block.write(octal(mode, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(size, 12), 124, 12, 'ascii')
  block.write(octal(0, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

/**
 * A tar of `files`, each 0600 unless it says otherwise (an executable, such as
 * the Node binary an SSH install repacks, carries 0700), under 0700
 * directories.
 */
export function buildTar(files: ReadonlyArray<{ path: string; data: Buffer; mode?: number }>): Buffer {
  const parts: Buffer[] = []
  const dirs = new Set<string>()
  for (const file of files) {
    const segments = file.path.split('/')
    for (let depth = 1; depth < segments.length; depth += 1) {
      const dir = `${segments.slice(0, depth).join('/')}/`
      if (dirs.has(dir)) continue
      dirs.add(dir)
      parts.push(header(dir, 0, '5', 0o700))
    }
    parts.push(header(file.path, file.data.length, '0', file.mode ?? 0o600))
    parts.push(file.data)
    const pad = (512 - (file.data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
