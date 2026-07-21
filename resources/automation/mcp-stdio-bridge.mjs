#!/usr/bin/env node
// SprintEngine Studio MCP stdio bridge.
//
// SprintEngine Studio listens on a Unix domain socket / Windows named pipe speaking MCP's stdio
// framing (newline-delimited JSON-RPC 2.0). Stock MCP clients speak stdio, so
// this script is the adapter: it finds the running server via its discovery
// file and pipes stdin/stdout to the socket verbatim. No protocol logic.
//
//   claude mcp add sprintengine-studio -- node /path/to/mcp-stdio-bridge.mjs
//
// Resolution order for the canonical discovery file (with a legacy filename fallback):
//   1. --info-path <file>          explicit override (tests, extra profiles)
//   2. $MULTICODE_USER_DATA_DIR    the same override the dev app honors
//   3. the default Multicode userData dir for this platform
//
// Dev instances launched with MULTICODE_USER_DATA_DIR must pass the same env
// var (or --info-path) to the bridge; the default dir is the packaged app's.
//
// Standalone by design: only node: builtins, runs on any recent Node.

import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const INFO_FILENAMES = ['sprintengine-studio-mcp-info.json', 'automation-server-info.json']

function fail(message) {
  process.stderr.write(`sprintengine-studio-mcp-bridge: ${message}\n`)
  process.exit(1)
}

function parseInfoPathArg(argv) {
  let infoPath
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--info-path') {
      infoPath = argv[i + 1]
      if (!infoPath) fail('--info-path needs a file argument.')
      i += 1
    } else if (arg.startsWith('--info-path=')) {
      infoPath = arg.slice('--info-path='.length)
      if (!infoPath) fail('--info-path needs a file argument.')
    } else {
      fail(`Unknown argument "${arg}". Usage: mcp-stdio-bridge.mjs [--info-path <sprintengine-studio-mcp-info.json>]`)
    }
  }
  return infoPath
}

// Electron derives userData from package.json's `name` ("multicode",
// lowercase). "Multicode" is kept as a fallback for case-sensitive
// filesystems in case a future release promotes productName to the app name.
function defaultUserDataDirs() {
  if (process.platform === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support')
    return [join(base, 'sprintengine-studio'), join(base, 'SprintEngine Studio'), join(base, 'multicode'), join(base, 'Multicode')]
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? [join(appData, 'sprintengine-studio'), join(appData, 'SprintEngine Studio'), join(appData, 'multicode'), join(appData, 'Multicode')] : []
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return [join(configHome, 'sprintengine-studio'), join(configHome, 'SprintEngine Studio'), join(configHome, 'multicode'), join(configHome, 'Multicode')]
}

function resolveInfoPath() {
  const explicit = parseInfoPathArg(process.argv.slice(2))
  if (explicit) return explicit
  const envDir = process.env.MULTICODE_USER_DATA_DIR?.trim()
  if (envDir) {
    const candidates = INFO_FILENAMES.map((filename) => join(envDir, filename))
    return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
  }
  const candidates = defaultUserDataDirs().flatMap((dir) => INFO_FILENAMES.map((filename) => join(dir, filename)))
  if (candidates.length === 0) fail('Could not resolve the SprintEngine Studio data directory; pass --info-path.')
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]
}

function readServerInfo(infoPath) {
  let raw
  try {
    raw = readFileSync(infoPath, 'utf8')
  } catch {
    fail(
      `No Studio MCP discovery file at ${infoPath}. `
        + 'SprintEngine Studio is not running yet.'
    )
  }
  let info
  try {
    info = JSON.parse(raw)
  } catch {
    fail(`Discovery file ${infoPath} is not valid JSON; restart SprintEngine Studio to rewrite it.`)
  }
  if (typeof info.socketPath !== 'string' || info.socketPath.length === 0) {
    fail(`Discovery file ${infoPath} has no socketPath; restart SprintEngine Studio to rewrite it.`)
  }
  return info
}

function appearsAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but is not ours to signal.
    return error && error.code === 'EPERM' ? true : false
  }
}

const infoPath = resolveInfoPath()
const info = readServerInfo(infoPath)

const socket = connect(info.socketPath)
let connected = false

socket.on('connect', () => {
  connected = true
  // Advisory attribution only: the gateway's trust boundary remains the local
  // OS user/socket. This frame is deliberately sent before stdin piping, and
  // the server serializes frames per connection so initialize cannot overtake it.
  socket.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'sprintengine.studio/connect',
    params: {
      workspaceId: process.env.MULTICODE_WORKSPACE_ID,
      agentId: process.env.MULTICODE_AGENT_ID,
      agentName: process.env.MULTICODE_AGENT_NAME,
      cliId: process.env.MULTICODE_AGENT_CLI,
      sprintRunId: process.env.MULTICODE_SPRINTENGINE_MCP_RUN_ID,
    },
  })}\n`)
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})

socket.on('error', (error) => {
  if (connected) {
    fail(`Connection to the SprintEngine Studio MCP gateway was lost: ${error.message}`)
  }
  const alive = appearsAlive(info.pid)
  if (alive === false) {
    fail(
      `Could not connect to ${info.socketPath} and the recorded app process (pid ${info.pid}) is gone — `
        + 'the discovery file is stale (the app likely crashed). Start SprintEngine Studio.'
    )
  }
  fail(`Could not connect to ${info.socketPath}: ${error.message}`)
})

// Server closed the connection (app quit): clean exit so
// MCP clients treat it as a normal disconnect.
socket.on('close', () => process.exit(0))
process.stdin.on('end', () => socket.end())
