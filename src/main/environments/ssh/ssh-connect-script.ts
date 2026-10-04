import {
  compoundScript,
  NODE_RUNTIME_REL,
  plainToken,
  posixInstallFunctions,
  remoteBase,
  REMOTE_DATA_REL,
  SEND_MARKER,
  serverTreeName,
  streamInstallLines,
} from '../../hosts/remote-install'
import { remoteNodePackage, type RemoteNodeTarget } from '../../hosts/wsl-node-runtime'
import { parseSemver } from '../../../shared/semver'
import { parseGhVersion, type HostGhStatus } from '../../../shared/host-gh'

// The one script every SSH session runs (phase 8 spec, 5.2): a probe of what
// the machine is, then `@@SPRINTENGINE_SEND`, then one decision line from the
// client, then that decision carried out:
//
//   install          the archive follows on stdin; staged, checked, committed
//   install-fetch    the same, but the pinned Node is downloaded here first,
//                    by URL and digest written into this script (never sent
//                    by anyone), and checked here before it is unpacked
//   attach           the relay, onto the running server
//   start <idle> <b> a managed server started (`start --detach`), then the relay
//   upgrade <idle> <b>  the same with `--replace`: the old one drains and goes
//   stop             the running managed server asked to drain and leave
//
// Every line the client reads starts `@@SPRINTENGINE_`; anything before the
// first (a login profile's greeting) is noise, kept for diagnostics only. No
// secret is ever in this script, in the decision, or in any argv: the owner
// token is minted and read on the remote, by the starter and the relay.

export const PROBE_PROTO = 1
const MARK = '@@SPRINTENGINE_'

/** The pinned runtimes a remote can fetch for itself, by `uname -s`-`uname -m`. */
const FETCH_TARGETS: Array<[string, RemoteNodeTarget]> = [
  ['Linux-x86_64', 'linux-x64'],
  ['Linux-amd64', 'linux-x64'],
  ['Linux-aarch64', 'linux-arm64'],
  ['Linux-arm64', 'linux-arm64'],
  ['Darwin-x86_64', 'darwin-x64'],
  ['Darwin-arm64', 'darwin-arm64'],
]

export type ConnectScriptInput = {
  appVersion: string
  serverDigest: string
  stageId: string
  installDir: string | null
  /** The data directory's name under the data root: `data`, or `data-<profile>` for another profile. */
  dataName: string
  channel: 'latest' | 'nightly'
}

/**
 * The pinned runtime for this machine, chosen by `uname`: its URL, digest and
 * top directory. The digest marks a streamed binary too, which the desktop
 * cut from the same archive.
 */
function targetLines(): string[] {
  const cases = FETCH_TARGETS.map(([uname, target]) => {
    const pkg = remoteNodePackage(target)
    return `  ${uname}) url='${pkg.url}'; sum='${pkg.sha256}'; top='${pkg.dirName}' ;;`
  })
  return ["url=''; sum=''; top=''", 'case "$(uname -s)-$(uname -m)" in', ...cases, 'esac']
}

function fetchLines(): string[] {
  return [
    '[ -n "$url" ] || fail "fetch-target $(uname -s)-$(uname -m)"',
    'if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$stage/node.tgz" || fail "fetch $url"',
    'elif command -v wget >/dev/null 2>&1; then wget -q -O "$stage/node.tgz" "$url" || fail "fetch $url"',
    'else fail "fetch-tool"; fi',
    'if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$stage/node.tgz" | cut -d" " -f1)"',
    'else got="$(shasum -a 256 "$stage/node.tgz" | cut -d" " -f1)"; fi',
    // The client never trusts a digest the remote computes for it: the one
    // compared against is written into this script.
    '[ "$got" = "$sum" ] || fail "digest $got $sum"',
    `mkdir -p "$stage/${NODE_RUNTIME_REL}/bin" || fail stage`,
    `tar -xzf "$stage/node.tgz" -C "$stage" "$top/bin/node" || fail "unpack-node"`,
    `mv "$stage/$top/bin/node" "$stage/${NODE_RUNTIME_REL}/bin/node" || fail "unpack-node"`,
    'rm -rf "$stage/node.tgz" "$stage/${top:?}"',
  ]
}

export function buildConnectScript(input: ConnectScriptInput): string {
  const dataName = plainToken(input.dataName, 'The data directory name')
  if (!/^data(-[A-Za-z0-9._-]+)?$/u.test(dataName)) throw new Error(`Not a data directory name: ${dataName}`)
  const tree = serverTreeName(input.appVersion)
  const channel = input.channel === 'nightly' ? 'nightly' : 'latest'
  const relay = 'exec "$rt/bin/node" "$app/bridge.mjs" --mux "$data/run"'
  const install = streamInstallLines({
    stageId: input.stageId,
    appVersion: input.appVersion,
    serverDigest: input.serverDigest,
    nodeDigest: { shellVar: 'sum' },
  })
  const installFetch = streamInstallLines({
    stageId: input.stageId,
    appVersion: input.appVersion,
    serverDigest: input.serverDigest,
    nodeDigest: { shellVar: 'sum' },
    beforeUnpack: fetchLines(),
  })
  const indent = (lines: readonly string[]) => lines.map((line) => `    ${line}`)
  // Never run a program from a tree another user could have put there.
  const ownedCheck = `    { owned "$base" && owned "$app"; } || { printf '%sFAIL base-owner %s\\n' "$P" "$base"; exit 7; }`
  return compoundScript([
    'set -u',
    `P='${MARK}'`,
    `base=${remoteBase(input.installDir)}`,
    `data="$HOME/${REMOTE_DATA_REL}/${dataName}"`,
    `rt="$base/${NODE_RUNTIME_REL}"`,
    `app="$base/${tree}"`,
    ...posixInstallFunctions(),
    ...targetLines(),
    'probe() { printf \'%sPROBE %s=%s\\n\' "$P" "$1" "$2"; }',
    `probe proto ${PROBE_PROTO}`,
    'os="$(uname -s 2>/dev/null)"',
    'probe os "$os"',
    'probe machine "$(uname -m 2>/dev/null)"',
    'libc=unknown',
    'if [ "$os" = Darwin ]; then libc="darwin-$(sw_vers -productVersion 2>/dev/null)"',
    'elif ls /lib/ld-musl-* >/dev/null 2>&1; then libc=musl',
    'else v="$(getconf GNU_LIBC_VERSION 2>/dev/null)"; [ -n "$v" ] && libc="glibc-${v##* }"; fi',
    'probe libc "$libc"',
    'probe uid "$(id -u)"',
    'probe user "$(id -un 2>/dev/null)"',
    'probe home "$HOME"',
    'probe shell "${SHELL:-}"',
    'probe hostname "$(uname -n 2>/dev/null)"',
    'b="$base"',
    'while [ ! -d "$b" ] && [ "$b" != / ]; do b="$(dirname "$b")"; done',
    'probe base "$base"',
    'probe base_existing "$b"',
    'w=0; [ -w "$b" ] && w=1',
    'probe writable "$w"',
    'probe free_kb "$(df -Pk "$b" 2>/dev/null | awk \'NR==2{print $4}\')"',
    '[ "$os" = Linux ] && probe fstype "$(stat -f -c %T "$b" 2>/dev/null)"',
    // Can the install directory run what is put there? A home mounted noexec cannot.
    'e=0; t="$b/.sprintengine-exec-$$"',
    `if printf '#!/bin/sh\\nexit 0\\n' > "$t" 2>/dev/null && chmod 700 "$t" && "$t" 2>/dev/null; then e=1; fi`,
    'rm -f "$t"',
    'probe exec "$e"',
    'for tool in tar gzip curl wget sha256sum shasum systemctl loginctl; do',
    '  command -v "$tool" >/dev/null 2>&1 && probe has "$tool"',
    'done',
    // The machine's GitHub CLI, for Settings: a chat here opens its pull
    // requests with it. Whether it holds a token is asked without reading the
    // token back (it goes to /dev/null here), and never asks anything itself.
    // `ssh host sh -s` runs no login profile, so this PATH is the system's
    // (on a Mac, no Homebrew); the server's own gh runs fall back to the login
    // shell and find gh there. So the folders gh is installed in are looked in
    // too, the person's own first as a profile puts them, rather than telling
    // the person to install a gh they have. gh gets no stdin: this script's
    // stdin carries the decision line.
    'gh_bin="$(command -v gh 2>/dev/null)"',
    'if [ -z "$gh_bin" ]; then',
    '  for d in "$HOME/.local/bin" "$HOME/bin" /opt/homebrew/bin /usr/local/bin /home/linuxbrew/.linuxbrew/bin /snap/bin; do',
    '    if [ -x "$d/gh" ]; then gh_bin="$d/gh"; break; fi',
    '  done',
    'fi',
    'if [ -n "$gh_bin" ]; then',
    '  probe has gh',
    '  probe gh_version "$("$gh_bin" --version </dev/null 2>/dev/null | head -n 1)"',
    '  if GH_PROMPT_DISABLED=1 "$gh_bin" auth token </dev/null >/dev/null 2>&1; then probe gh_auth 1; else probe gh_auth 0; fi',
    'fi',
    'if command -v loginctl >/dev/null 2>&1; then probe linger "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)"; fi',
    'probe kill_user_processes "$(sed -n \'s/^KillUserProcesses=//p\' /etc/systemd/logind.conf 2>/dev/null | tail -n 1)"',
    'probe node_ready "$(cat "$rt/.ready" 2>/dev/null)"',
    'probe server_ready "$(cat "$app/.ready" 2>/dev/null)"',
    '[ -f "$data/run/server.json" ] && probe server_json "$(head -c 4096 "$data/run/server.json" | tr -d \'\\n\')"',
    'lock="$(head -c 1024 "$data/run/studio.lock" 2>/dev/null | tr -d \'\\n\')"',
    'pid="$(printf \'%s\' "$lock" | sed -n \'s/.*"pid":\\([0-9][0-9]*\\).*/\\1/p\')"',
    'probe lock_host "$(printf \'%s\' "$lock" | sed -n \'s/.*"hostname":"\\([^"]*\\)".*/\\1/p\')"',
    'alive=0; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && alive=1',
    'probe lock_pid "$pid"',
    'probe lock_alive "$alive"',
    '[ -n "${HTTPS_PROXY:-${https_proxy:-}}" ] && probe proxy 1',
    'probe end 1',
    `printf '%s\\n' '${SEND_MARKER}'`,
    'IFS= read -r decision || exit 0',
    'set -f',
    'case "$decision" in',
    '  install)',
    ...indent(install),
    '    ;;',
    '  install-fetch)',
    ...indent(installFetch),
    '    ;;',
    '  attach)',
    ownedCheck,
    `    ${relay}`,
    '    ;;',
    '  "start "*|"upgrade "*)',
    // shellcheck: the split is the point; `set -f` keeps it from globbing.
    '    set -- $decision',
    '    idle="${2:-}"; label="${3:-}"',
    '    case "$idle" in keep) idle_arg="--keep-running" ;; *[!0-9]*|"") exit 6 ;; *) idle_arg="--idle-ms=$idle" ;; esac',
    '    case "$label" in *[!A-Za-z0-9_-]*) exit 6 ;; esac',
    "    replace=''",
    '    [ "$1" = upgrade ] && replace=--replace',
    ownedCheck,
    `    "$rt/bin/node" "$app/server.cjs" start --detach --data-dir "$data" "$idle_arg" --started-by-b64="$label" --channel ${channel} $replace </dev/null || exit 5`,
    `    ${relay}`,
    '    ;;',
    '  stop)',
    '    if [ "$alive" = 1 ]; then',
    '      kill -TERM "$pid" 2>/dev/null',
    '      n=0',
    '      while kill -0 "$pid" 2>/dev/null && [ "$n" -lt 280 ]; do sleep 0.25 2>/dev/null || sleep 1; n=$((n + 1)); done',
    '      kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null',
    '    fi',
    `    printf '%sSTOPPED\\n' "$P"`,
    '    ;;',
    '  *) exit 0 ;;',
    'esac',
  ])
}

// ── What the client makes of a probe ───────────────────────────────────────

export type Probe = {
  proto: number
  os: string
  machine: string
  libc: string
  uid: string
  user: string
  home: string
  shell: string
  hostname: string
  base: string
  baseExisting: string
  writable: boolean
  freeKb: number | null
  fstype: string | null
  exec: boolean
  tools: Set<string>
  /** The machine's GitHub CLI: installed, its version, and whether it holds a token. */
  gh: HostGhStatus
  linger: string | null
  killUserProcesses: string | null
  nodeReady: string
  serverReady: string
  serverRecord: Record<string, unknown> | null
  lock: { pid: number | null; alive: boolean; host: string | null }
  proxy: boolean
}

/** The probe's lines, or null when it did not end (the script was cut off). */
export function parseProbe(lines: readonly string[]): Probe | null {
  const fields = new Map<string, string>()
  const tools = new Set<string>()
  let ended = false
  for (const line of lines) {
    if (!line.startsWith(`${MARK}PROBE `)) continue
    const body = line.slice(`${MARK}PROBE `.length)
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq)
    const value = body.slice(eq + 1)
    if (key === 'has') tools.add(value)
    else if (key === 'end') ended = true
    else if (!fields.has(key)) fields.set(key, value)
  }
  if (!ended) return null
  const text = (key: string) => fields.get(key) ?? ''
  let serverRecord: Record<string, unknown> | null = null
  try {
    const parsed = fields.get('server_json') ? (JSON.parse(text('server_json')) as unknown) : null
    serverRecord = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    serverRecord = null
  }
  const free = Number(text('free_kb'))
  const pid = Number(text('lock_pid'))
  return {
    proto: Number(text('proto')),
    os: text('os'),
    machine: text('machine'),
    libc: text('libc'),
    uid: text('uid'),
    user: text('user'),
    home: text('home'),
    shell: text('shell'),
    hostname: text('hostname'),
    base: text('base'),
    baseExisting: text('base_existing'),
    writable: text('writable') === '1',
    freeKb: text('free_kb') && Number.isFinite(free) ? free : null,
    fstype: fields.get('fstype') || null,
    exec: text('exec') === '1',
    tools,
    gh: tools.has('gh')
      ? {
          installed: true,
          version: parseGhVersion(text('gh_version')),
          signedIn: text('gh_auth') === '1' ? true : text('gh_auth') === '0' ? false : null,
        }
      : { installed: false, version: null, signedIn: null },
    linger: fields.get('linger') || null,
    killUserProcesses: fields.get('kill_user_processes') || null,
    nodeReady: text('node_ready'),
    serverReady: text('server_ready'),
    serverRecord,
    lock: {
      pid: text('lock_pid') && Number.isInteger(pid) ? pid : null,
      alive: text('lock_alive') === '1',
      host: fields.get('lock_host') || null,
    },
    proxy: text('proxy') === '1',
  }
}

/** The glibc floor of the pinned Node (decision R24). */
export const GLIBC_FLOOR = [2, 28] as const

export type Assessment =
  | { supported: true; target: RemoteNodeTarget; needs: { node: boolean; server: boolean }; notes: string[] }
  | { supported: false; reason: string; notes: string[] }

/**
 * Whether Studio can run on the machine the probe describes, and what it is
 * missing. Each refusal is a sentence naming what was found.
 */
export function assessProbe(
  probe: Probe,
  input: { label: string; nodeDigests: readonly string[]; serverDigest: string; installDir: string | null },
): Assessment {
  const notes: string[] = []
  const label = input.label
  if (probe.proto !== PROBE_PROTO) return { supported: false, reason: `Studio couldn't read ${label}'s setup.`, notes }
  let os: 'linux' | 'darwin'
  if (probe.os === 'Linux') os = 'linux'
  else if (probe.os === 'Darwin') os = 'darwin'
  else if (/^(MINGW|MSYS|CYGWIN|Windows)/iu.test(probe.os) || !probe.os)
    return {
      supported: false,
      reason: `Can't run here: ${label} runs Windows. Studio servers run on Linux and macOS; on a Windows PC, use WSL.`,
      notes,
    }
  else
    return {
      supported: false,
      reason: `Can't run here: ${label} runs ${probe.os}, and Studio servers run on Linux and macOS.`,
      notes,
    }
  const arch =
    probe.machine === 'x86_64' || probe.machine === 'amd64'
      ? 'x64'
      : probe.machine === 'aarch64' || probe.machine === 'arm64'
        ? 'arm64'
        : null
  if (!arch)
    return {
      supported: false,
      reason: `Can't run here: ${label} is a ${probe.machine} machine, and Studio runs on x64 and arm64.`,
      notes,
    }
  if (os === 'linux') {
    if (probe.libc === 'musl')
      return {
        supported: false,
        reason: `Can't run here: ${label} uses musl (as Alpine does), and Studio's runtime needs glibc. Use a glibc distribution.`,
        notes,
      }
    const glibc = /^glibc-(\d+)\.(\d+)/u.exec(probe.libc)
    if (glibc) {
      const [major, minor] = [Number(glibc[1]), Number(glibc[2])]
      if (major < GLIBC_FLOOR[0] || (major === GLIBC_FLOOR[0] && minor < GLIBC_FLOOR[1]))
        return {
          supported: false,
          reason: `Can't run here: ${label} has glibc ${major}.${minor}, and Studio's runtime needs ${GLIBC_FLOOR.join('.')} or later.`,
          notes,
        }
    }
    if (probe.killUserProcesses === 'yes')
      notes.push(
        `${label} ends every process of yours when you log out (KillUserProcesses=yes), so its Studio server and any running agent stop when the connection does. An administrator can keep them running with: loginctl enable-linger ${probe.user || '<you>'}`,
      )
    if (probe.fstype === 'nfs')
      notes.push(`${label}'s home is on NFS: one Studio server serves it, whichever machine shares it.`)
  } else
    notes.push(
      `On macOS, a CLI that keeps its sign-in in the keychain can't read it over SSH; use its token or API-key sign-in on ${label}.`,
    )
  if (!probe.writable)
    return {
      supported: false,
      reason: `Can't install on ${label}: ${probe.baseExisting || probe.base} is not writable by you.`,
      notes,
    }
  if (!probe.exec)
    return {
      supported: false,
      reason: input.installDir
        ? `Can't run programs from ${input.installDir} on ${label} (it is mounted noexec). Choose a directory on another mount.`
        : `Can't run programs from your home on ${label} (it is mounted noexec). Choose an install directory on another mount in this machine's settings.`,
      notes,
    }
  const needs = {
    node: !input.nodeDigests.includes(probe.nodeReady),
    server: probe.serverReady !== input.serverDigest,
  }
  return { supported: true, target: `${os}-${arch}` as RemoteNodeTarget, needs, notes }
}

/** Whether the machine has room for `unpackedBytes`, with a fifth to spare. */
export function spaceFor(probe: Probe, unpackedBytes: number, label: string): string | null {
  if (probe.freeKb === null) return null
  const needKb = Math.ceil((unpackedBytes * 1.2) / 1024)
  if (probe.freeKb >= needKb) return null
  return `Not enough space on ${label}: Studio needs ${Math.ceil(needKb / 1024)} MB and ${probe.baseExisting || probe.base} has ${Math.floor(probe.freeKb / 1024)} MB free.`
}

// ── What to do about a running server (spec 5.6, Locating) ────────────────

export type Located =
  | { action: 'start' }
  | { action: 'attach'; note?: string }
  | { action: 'upgrade'; from: string }
  | { action: 'blocked'; reason: string; offerUpgrade: boolean }

/**
 * Which of two app versions is newer: numbers first, then a prerelease
 * (`0.5.0-nightly.20260923.41`) below its release and ordered identifier by
 * identifier, numbers as numbers. Null when either is not a version at all.
 */
export function compareVersions(a: string, b: string): number | null {
  const [x, y] = [parseSemver(a), parseSemver(b)]
  if (!x || !y) return null
  const width = Math.max(x.numbers.length, y.numbers.length)
  for (let i = 0; i < width; i++)
    if ((x.numbers[i] ?? 0) !== (y.numbers[i] ?? 0)) return (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0)
  if (x.prerelease === y.prerelease) return 0
  if (x.prerelease === null) return 1
  if (y.prerelease === null) return -1
  const [p, q] = [x.prerelease.split('.'), y.prerelease.split('.')]
  for (let i = 0; i < Math.max(p.length, q.length); i++) {
    const [l, r] = [p[i], q[i]]
    if (l === r) continue
    if (l === undefined) return -1
    if (r === undefined) return 1
    const [ln, rn] = [/^\d+$/u.test(l) ? Number(l) : null, /^\d+$/u.test(r) ? Number(r) : null]
    if (ln !== null && rn !== null) return ln - rn
    if (ln !== null) return -1
    if (rn !== null) return 1
    return l < r ? -1 : 1
  }
  return 0
}

/**
 * Attach, start, upgrade or refuse, from what the probe found. A newer server
 * is never replaced or stopped, so two desktops on different versions never
 * replace each other's server in turn; an external one is never replaced
 * without the person asking (decision R31).
 */
export function locateServer(
  probe: Probe,
  app: { version: string; backendWire: number; hostId?: string | null },
  label: string,
): Located {
  const record = probe.serverRecord
  if (!probe.lock.alive) return { action: 'start' }
  if (probe.lock.host && probe.hostname && probe.lock.host !== probe.hostname) {
    const recordHost = typeof record?.hostId === 'string' ? record.hostId : null
    if (!recordHost || !recordHost.endsWith(probe.hostname))
      return {
        action: 'blocked',
        reason: `A Studio server is already running for this home on ${probe.lock.host}. One server serves one home.`,
        offerUpgrade: false,
      }
  }
  if (!record)
    return {
      action: 'blocked',
      reason: `${label} runs a Studio server that was started another way, and this app can only reach one a desktop started. Stop it on ${label} to let Studio start its own.`,
      offerUpgrade: false,
    }
  const version = typeof record.version === 'string' ? record.version : '?'
  const origin = typeof record.origin === 'string' ? record.origin : 'bootstrap'
  const wire = typeof record.backendWire === 'number' ? record.backendWire : null
  if (version === app.version && wire === app.backendWire) return { action: 'attach' }
  const order = compareVersions(version, app.version)
  // A version this app cannot place is never replaced: it may be the newer one.
  if (order === null)
    return {
      action: 'blocked',
      reason: `${label} runs a Studio server whose version (${version}) this app (${app.version}) cannot compare with its own, so Studio left it alone.`,
      offerUpgrade: false,
    }
  if (order > 0 || (order === 0 && wire !== app.backendWire && (wire ?? 0) > app.backendWire))
    return {
      action: 'blocked',
      reason: `${label} runs Studio server ${version}; this app is ${app.version}. Update this app to use it.`,
      offerUpgrade: false,
    }
  if (origin === 'bootstrap') return { action: 'upgrade', from: version }
  return {
    action: 'blocked',
    reason: `${label} runs Studio server ${version}, started outside this app; this app speaks ${app.version}. Update it to connect.`,
    offerUpgrade: true,
  }
}
