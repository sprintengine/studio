#!/usr/bin/env node
// SprintEngine Studio's helper inside one WSL distribution.
//
// Main starts one of these per distribution, the first time anything needs
// that machine, as
//
//   wsl.exe -d <distro> --cd ~ --exec sh -s     (a script that execs:)
//   <node> ~/.local/share/sprintengine-studio/<version>/wsl-helper/helper.mjs --profile <id>
//
// and talks to it over that one process's stdin and stdout: newline-delimited
// JSON (`lib/frames.mjs`). It is the only channel between Windows and Linux, so
// the app needs no networking mode, no interop inside the distribution, and no
// port anywhere. Inside Linux, the helper listens on two private Unix sockets
// (`lib/sockets.mjs`) for the app's hooks, status line, OpenCode plugin and MCP
// bridge, and relays them to main (`lib/relay.mjs`). It also answers main's
// questions about the distribution: which processes a session left running,
// which CLIs are installed, the home folder, and running a program or git. It
// writes each launch's startup script where only this user can read it
// (`lib/sessions.mjs`), and watches git directories for the Git pane, because
// a watch Windows places on a `\\wsl.localhost` path hears nothing.
//
// Lifetime. It exits when its stdin closes (main quit, crashed, or killed the
// `wsl.exe`), when main says `shutdown`, or on a signal, and on the way out it
// removes its sockets and ends every process group it started. When the app
// quits, main's `shutdown` also asks it to end every session the app launched
// here, because ending the Windows `wsl.exe` of a terminal does not reach the
// Linux processes under it. Main stops it about two minutes after the last WSL
// session on this machine ends, so the VM can idle. Plain Node, no
// dependencies: it runs on the pinned Linux Node main installed next to it,
// never on the person's own.

import { chmodSync, readFileSync, rmSync, watch as fsWatch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createCliDetector } from './lib/cli-detect.mjs'
import { ensureTree } from './lib/files.mjs'
import { createLineDecoder, decodeFrame, encodeFrame, PROTOCOL_VERSION } from './lib/frames.mjs'
import { captureLoginEnv } from './lib/login-env.mjs'
import { endAllSessions, snapshot, survivorPids } from './lib/proc.mjs'
import { createMcpMux, relayAgentStateConnection } from './lib/relay.mjs'
import { checkRunRequest, childEnv, decodeStdin, killAllChildren, runArgv } from './lib/run.mjs'
import { clearSessionDir, ensureSessionDir, removeSessionEntries, writeSessionFiles } from './lib/sessions.mjs'
import { closePrivate, ensurePrivateDir, ensureSocketDir, listenPrivate } from './lib/sockets.mjs'

// Main's own frames can carry a plugin copy, so the cap is generous; it is
// still a cap, because a broken writer should end the helper rather than fill
// its memory.
const MAX_MAIN_LINE_BYTES = 64 * 1024 * 1024
const HELLO_TIMEOUT_MS = 30_000
const INFO_FILENAME = 'sprintengine-studio-mcp-info.json'
const CLI_SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/u
// The Git pane watches a handful of directories per open checkout.
const MAX_WATCHES = 512

const uid = typeof process.getuid === 'function' ? process.getuid() : -1
const helperDir = dirname(fileURLToPath(import.meta.url))
const appDir = dirname(helperDir)
const procRoot = process.env.SPRINTENGINE_HELPER_PROC_ROOT || '/proc'
// Tests point these at a temporary directory; production never sets them.
const socketBase = process.env.SPRINTENGINE_HELPER_SOCKET_BASE || undefined

let exiting = false
const servers = []
const agentConnections = new Set()
const watches = new Map()
let nextWatchId = 1
let infoPath = null
// Set by the hello: the session pid files live beside the sockets, in the
// directory the helper made private, and the launch files in the profile's
// own directory under the Linux home.
let pidDir = null
let sessionDir = null

function send(frame) {
  if (exiting) return
  try {
    process.stdout.write(encodeFrame(frame))
  } catch {
    shutdown(0)
  }
}

process.stdout.on('error', () => shutdown(0))

const mux = createMcpMux(send)

let loginEnvPromise = null
const loginEnv = () => {
  loginEnvPromise ??= captureLoginEnv({ uid })
  return loginEnvPromise
}

const detector = createCliDetector({
  getEnv: loginEnv,
  onPathsChanged: () => send({ t: 'ev', event: 'pathsChanged' }),
})

/** Ends every session this profile launched here, and drops their launch files. */
function endSessions() {
  endAllSessions({ procRoot, pidDir, uid, selfPid: process.pid })
  if (sessionDir) clearSessionDir(sessionDir)
}

function closeWatch(id) {
  const watcher = watches.get(id)
  if (!watcher) return
  watches.delete(id)
  try {
    watcher.close()
  } catch {
    // Already closed.
  }
}

async function shutdown(code, options = {}) {
  if (exiting) return
  exiting = true
  if (options.endSessions) {
    try {
      endSessions()
    } catch {
      // Best effort on the way out; nothing is left to report to.
    }
  }
  killAllChildren()
  detector.close()
  mux.closeAll()
  for (const id of [...watches.keys()]) closeWatch(id)
  for (const socket of agentConnections) socket.destroy()
  await Promise.all(servers.map(({ server, path }) => closePrivate(server, path).catch(() => undefined)))
  // The discovery file too, unless a newer helper has written its own there.
  try {
    if (infoPath && JSON.parse(readFileSync(infoPath, 'utf8')).pid === process.pid) rmSync(infoPath, { force: true })
  } catch {
    // Gone or unreadable: nothing of ours to remove.
  }
  process.exit(code)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void shutdown(0))

async function start(hello) {
  const profile = String(hello.profile ?? '')
  const socketDir = ensureSocketDir({ env: process.env, uid, profile, base: socketBase })
  pidDir = ensurePrivateDir(join(socketDir, 'sessions'), uid)
  const home = process.env.HOME || homedir()
  sessionDir = ensureSessionDir({ home, uid, profile })
  // The first helper a main starts: anything its pid files still name was
  // launched by a main that has since gone (it crashed, or was killed before
  // it could end them), and nothing will ever manage it again.
  if (hello.endOrphans === true) endSessions()
  const agentSocket = join(socketDir, 'agent.sock')
  const mcpSocket = join(socketDir, 'mcp.sock')
  servers.push({
    server: await listenPrivate(agentSocket, (socket) => {
      agentConnections.add(socket)
      socket.on('close', () => agentConnections.delete(socket))
      relayAgentStateConnection(socket, (line) => send({ t: 'ev', event: 'agentState', line }))
    }),
    path: agentSocket,
  })
  // Half-open: a bridge whose client closed its stdin still gets the replies
  // already on their way.
  servers.push({
    server: await listenPrivate(mcpSocket, (socket) => mux.accept(socket), { allowHalfOpen: true }),
    path: mcpSocket,
  })
  // The MCP bridge finds its server through a discovery file in its user-data
  // directory. This directory stands in for it inside Linux, so the bridge the
  // app ships runs here unchanged. `channelAuth` tells it to open with its
  // launch's token (lib/relay.mjs).
  infoPath = join(socketDir, INFO_FILENAME)
  writeFileSync(
    infoPath,
    `${JSON.stringify(
      {
        socketPath: mcpSocket,
        transport: 'unix-socket',
        pid: process.pid,
        protocol: 'mcp-jsonrpc-ndjson',
        channelAuth: 'launch-token',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  chmodSync(infoPath, 0o600)
  // Read in the background now; the first CLI check or git command waits on it.
  void loginEnv()
  return {
    uid,
    profile,
    home,
    arch: process.arch,
    nodePath: process.execPath,
    appDir,
    agentSocket,
    mcpSocket,
    userDataDir: socketDir,
    pidDir,
    sessionDir,
  }
}

const methods = {
  ping: async () => ({}),
  async home() {
    const env = await loginEnv()
    const home = env.HOME || process.env.HOME || homedir()
    return {
      home,
      env: {
        ...(env.CLAUDE_CONFIG_DIR ? { CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR.split(',')[0] } : {}),
        ...(env.CODEX_HOME ? { CODEX_HOME: env.CODEX_HOME } : {}),
        ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}),
      },
    }
  },
  async 'proc.snapshot'(params) {
    const keys = Array.isArray(params?.keys) ? params.keys.filter((key) => typeof key === 'string') : []
    return { verdicts: await snapshot({ procRoot, pidDir, keys, uid }) }
  },
  async 'proc.killSession'(params) {
    const cliSessionId =
      typeof params?.cliSessionId === 'string' && CLI_SESSION_ID.test(params.cliSessionId) ? params.cliSessionId : ''
    const key = typeof params?.key === 'string' ? params.key : ''
    const killed = []
    for (const pid of survivorPids({ procRoot, pidDir, cliSessionId, key, uid, selfPid: process.pid })) {
      try {
        process.kill(pid, 'SIGKILL')
        killed.push(pid)
      } catch {
        // Gone between the read and the kill, which is the goal.
      }
    }
    if (key && /^[A-Za-z0-9._-]+$/u.test(key)) rmSync(join(pidDir, `${key}.pid`), { force: true })
    return { killed }
  },
  async 'cli.detect'(params) {
    const requests = Array.isArray(params?.requests) ? params.requests : []
    return { results: await detector.detect(requests, { force: params?.force === true }) }
  },
  async run(params) {
    const problem = checkRunRequest(params ?? {})
    if (problem) throw new Error(problem)
    if (params.timeoutMs === null) throw new Error('run needs a deadline.')
    return runArgv({
      argv: params.argv,
      cwd: params.cwd,
      env: childEnv(await loginEnv(), params.env),
      timeoutMs: params.timeoutMs,
    })
  },
  async git(params) {
    const args = Array.isArray(params?.args) ? params.args : null
    const request = {
      argv: ['git', '-C', params?.cwd, ...(args ?? [])],
      cwd: params?.cwd,
      timeoutMs: params?.timeoutMs,
      env: params?.env,
    }
    const problem = args ? checkRunRequest(request) : 'args must be an array.'
    if (problem) throw new Error(problem)
    const stdin = decodeStdin(params.stdinB64)
    if (stdin === null) throw new Error('stdinB64 must be base64 text.')
    return runArgv({ ...request, env: childEnv(await loginEnv(), params.env), stdin })
  },
  async 'files.ensureTree'(params) {
    return ensureTree({ appDir, name: params?.name, digest: params?.digest, files: params?.files })
  },
  async 'session.write'(params) {
    return { paths: writeSessionFiles(sessionDir, params?.files) }
  },
  async 'session.remove'(params) {
    removeSessionEntries(sessionDir, params?.names)
    return {}
  },
  async 'watch.add'(params) {
    const path = params?.path
    if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) {
      throw new Error('path must be an absolute path.')
    }
    if (watches.size >= MAX_WATCHES) throw new Error('Too many directories are watched already.')
    const id = nextWatchId
    nextWatchId += 1
    const watcher = fsWatch(path, { recursive: params?.recursive === true, persistent: true }, (_event, filename) => {
      send({ t: 'ev', event: 'watch', id, filename: typeof filename === 'string' ? filename : null })
    })
    watcher.on('error', () => {
      closeWatch(id)
      send({ t: 'ev', event: 'watchError', id })
    })
    watches.set(id, watcher)
    return { id }
  },
  async 'watch.remove'(params) {
    if (Number.isInteger(params?.id)) closeWatch(params.id)
    return {}
  },
}

async function handleRequest(frame) {
  const method = methods[frame.method]
  if (!method) {
    send({ t: 'res', id: frame.id, error: { message: `Unknown method ${String(frame.method)}.` } })
    return
  }
  try {
    send({ t: 'res', id: frame.id, result: await method(frame.params) })
  } catch (error) {
    send({ t: 'res', id: frame.id, error: { message: String(error?.message ?? error) } })
  }
}

let greeted = false
const helloTimer = setTimeout(() => void shutdown(2), HELLO_TIMEOUT_MS)

async function handleFrame(frame) {
  if (!greeted) {
    if (frame.t !== 'hello') {
      void shutdown(2)
      return
    }
    greeted = true
    clearTimeout(helloTimer)
    if (frame.protocol !== PROTOCOL_VERSION) {
      send({ t: 'hello', ok: false, protocol: PROTOCOL_VERSION, error: 'protocol mismatch' })
      void shutdown(3)
      return
    }
    try {
      send({ t: 'hello', ok: true, protocol: PROTOCOL_VERSION, info: await start(frame) })
    } catch (error) {
      send({ t: 'hello', ok: false, protocol: PROTOCOL_VERSION, error: String(error?.message ?? error) })
      void shutdown(4)
    }
    return
  }
  if (frame.t === 'req' && Number.isInteger(frame.id)) void handleRequest(frame)
  else if (frame.t === 'ch') mux.handleFromMain(frame)
  else if (frame.t === 'shutdown') void shutdown(0, { endSessions: frame.endSessions === true })
}

const decoder = createLineDecoder({
  maxLineBytes: MAX_MAIN_LINE_BYTES,
  onLine(line) {
    const frame = decodeFrame(line)
    if (frame) void handleFrame(frame)
  },
  onOverflow: () => void shutdown(5),
})

process.stdin.on('data', (chunk) => decoder.push(chunk))
process.stdin.on('end', () => void shutdown(0))
process.stdin.on('close', () => void shutdown(0))
process.stdin.on('error', () => void shutdown(0))

// Said first, before anything is read: main sends its hello only after this
// line, because the shell that started us may otherwise have read part of it.
send({ t: 'boot', protocol: PROTOCOL_VERSION, pid: process.pid, version: readVersion() })

function readVersion() {
  try {
    return readFileSync(join(appDir, '.ready'), 'utf8').trim()
  } catch {
    return null
  }
}
