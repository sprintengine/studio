// Putting the helper and its Node into a distribution, and starting it.
//
// Everything lands under `~/.local/share/sprintengine-studio/`:
//
//   runtime/node-<version>/bin/node    the pinned Linux Node (`wsl-node-runtime.ts`)
//   <appVersion>/wsl-helper/…          the helper
//   <appVersion>/hooks/…               the hook reporters and status line
//   <appVersion>/automation/…          the MCP bridge
//   <appVersion>/plugin/…              the Claude plugin copy (written later,
//                                      by the helper itself; see `wsl-host.ts`)
//
// Each tree is installed the same way, and atomically:
//
//   1. a `sh -s` script makes a private staging directory;
//   2. the archive is streamed over `wsl.exe`'s stdin straight into
//      `tar -x` there (`--exec tar`, never a shell: see below);
//   3. a second `sh -s` script takes a lock (`flock`), checks the staged tree
//      (for Node, that `node --version` runs and says the pinned version),
//      writes a ready marker holding the archive's digest into it, and renames
//      it into place with `mv -T`. Older versions are pruned, except any a
//      running process still uses (found through `/proc/*/cmdline`).
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

import { WSL_NODE_VERSION, type WslNodePackage } from './wsl-node-runtime'

/** The data root, relative to the Linux home. */
export const WSL_DATA_REL = '.local/share/sprintengine-studio'

const TOKEN = /^[A-Za-z0-9._+-]+$/u
const HEX = /^[a-f0-9]+$/u

function token(value: string, what: string): string {
  if (!TOKEN.test(value)) throw new Error(`${what} is not a plain token: ${JSON.stringify(value)}`)
  return value
}

function hex(value: string, what: string): string {
  if (!HEX.test(value)) throw new Error(`${what} is not hex.`)
  return value
}

export type WslLaunchScriptInput = {
  appVersion: string
  /** The pinned archives' digests; the Node marker must hold one of them. */
  nodeDigests: readonly string[]
  appDigest: string
  profile: string
}

export const NEED_MARKER = '@@SPRINTENGINE_NEED'
export const FAIL_MARKER = '@@SPRINTENGINE_FAIL'
export const STAGED_MARKER = '@@SPRINTENGINE_STAGED'
export const COMMITTED_MARKER = '@@SPRINTENGINE_COMMITTED'
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
  return [
    'set -u',
    `base="$HOME/${WSL_DATA_REL}"`,
    `rt="$base/runtime/node-${WSL_NODE_VERSION}"`,
    `app="$base/${version}"`,
    "need=''",
    'ok=0',
    `[ -x "$rt/bin/node" ] && case "$(cat "$rt/.ready" 2>/dev/null)" in ${nodeDigests}) ok=1 ;; esac`,
    '[ "$ok" = 1 ] || need="$need node"',
    `{ [ -f "$app/wsl-helper/helper.mjs" ] && [ "$(cat "$app/.ready" 2>/dev/null)" = '${hex(input.appDigest, 'The app digest')}' ]; } || need="$need app"`,
    'if [ -n "$need" ]; then',
    '  xz=0; command -v xz >/dev/null 2>&1 && xz=1',
    `  printf '${NEED_MARKER}%s arch=%s xz=%s\\n' "$need" "$(uname -m)" "$xz"`,
    `  exit ${NEEDS_INSTALL_EXIT}`,
    'fi',
    `exec "$rt/bin/node" "$app/wsl-helper/helper.mjs" --profile '${profile}'`,
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
  | { kind: 'app'; stageId: string; digest: string; appVersion: string }

/**
 * Checks the staged tree, marks it, moves it into place under a lock, and
 * prunes older versions nothing is running from. Prints `@@SPRINTENGINE_FAIL
 * <reason>` and exits 4 when anything is wrong, leaving what was installed
 * before untouched.
 */
export function buildCommitScript(input: CommitInput): string {
  const id = token(input.stageId, 'The stage id')
  const digest = hex(input.digest, 'The digest')
  const final =
    input.kind === 'node'
      ? `$base/runtime/node-${WSL_NODE_VERSION}`
      : `$base/${token(input.appVersion, 'The app version')}`
  const prune = input.kind === 'node' ? '"$base"/runtime/node-*' : '"$base"/[0-9]*'
  const check =
    input.kind === 'node'
      ? [
          'out="$("$stage/bin/node" --version 2>&1)" || fail "node-run $out"',
          `[ "$out" = '${WSL_NODE_VERSION}' ] || fail "node-version $out"`,
        ]
      : ['[ -f "$stage/wsl-helper/helper.mjs" ] || fail "payload incomplete"']
  return [
    'set -u',
    `base="$HOME/${WSL_DATA_REL}"`,
    `stage="$base/.stage/${id}"`,
    `final="${final}"`,
    `fail() { printf '${FAIL_MARKER} %s\\n' "$*"; rm -rf "$stage"; exit 4; }`,
    // Anything a running process names in its command line (the helper, a
    // hook's Node) is still in use and is not removed or replaced under it.
    'live() { for c in /proc/[0-9]*/cmdline; do grep -qF -- "$1/" "$c" 2>/dev/null && return 0; done; return 1; }',
    '[ -d "$stage" ] || fail "nothing staged"',
    'mkdir -p "$(dirname "$final")" || fail mkdir',
    'exec 9>"$base/.install.lock" || fail lock',
    'if command -v flock >/dev/null 2>&1; then flock -w 120 9 || fail "lock timeout"; fi',
    ...check,
    `if [ "$(cat "$final/.ready" 2>/dev/null)" = '${digest}' ]; then`,
    '  rm -rf "$stage"',
    'else',
    `  printf '%s' '${digest}' > "$stage/.ready" || fail marker`,
    '  if [ -e "$final" ]; then',
    `    if live "$final"; then mv "$final" "$final.old-${id}" || fail "set aside"; else rm -rf "$final" || fail remove; fi`,
    '  fi',
    '  mv -T "$stage" "$final" 2>/dev/null || mv "$stage" "$final" || fail move',
    'fi',
    `for d in ${prune}; do`,
    '  [ -d "$d" ] || continue',
    '  [ "$d" = "$final" ] && continue',
    '  live "$d" && continue',
    '  rm -rf "$d"',
    'done',
    `echo ${COMMITTED_MARKER}`,
  ].join('\n')
}

/** Drops the Node ready marker after a start that could not run the helper. */
export function buildUnreadyScript(): string {
  return `rm -f "$HOME/${WSL_DATA_REL}/runtime/node-${WSL_NODE_VERSION}/.ready"`
}

/** The reason a failed commit printed, or the script's own last words. */
export function commitFailure(stdout: string, stderr: string): string {
  const line = stdout.split(/\r?\n/u).find((candidate) => candidate.startsWith(FAIL_MARKER))
  return (line ? line.slice(FAIL_MARKER.length) : (stderr.split(/\r?\n/u).filter(Boolean).at(-1) ?? '')).trim()
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
      files.push({ path: `${source.into}/${rel}`, data: readFileSync(path) })
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

export function buildTar(files: ReadonlyArray<{ path: string; data: Buffer }>): Buffer {
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
    parts.push(header(file.path, file.data.length, '0', 0o600))
    parts.push(file.data)
    const pad = (512 - (file.data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
