#!/usr/bin/env node
// Multicode automation-server stdio bridge.
//
// The Local automation server (Settings -> MCPs -> Local automation server)
// listens on a Unix domain socket / Windows named pipe speaking MCP's stdio
// framing (newline-delimited JSON-RPC 2.0). Stock MCP clients speak stdio, so
// this script is the adapter: it finds the running server via its discovery
// file and pipes stdin/stdout to the socket verbatim. No protocol logic.
//
//   claude mcp add multicode -- node /path/to/mcp-stdio-bridge.mjs
//
// Resolution order for the discovery file (automation-server-info.json):
//   1. --info-path <file>          explicit override (tests, extra profiles)
//   2. $MULTICODE_USER_DATA_DIR    the same override the dev app honors
//   3. the default Multicode userData dir for this platform
//
// Dev instances launched with MULTICODE_USER_DATA_DIR must pass the same env
// var (or --info-path) to the bridge; the default dir is the packaged app's.
//
// Standalone by design: only node: builtins, runs on any recent Node.

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const INFO_FILENAME = 'automation-server-info.json'

function fail(message) {
  process.stderr.write(`multicode-mcp-bridge: ${message}\n`)
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
      fail(`Unknown argument "${arg}". Usage: mcp-stdio-bridge.mjs [--info-path <automation-server-info.json>]`)
    }
  }
  return infoPath
}

function defaultUserDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Multicode')
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    return appData ? join(appData, 'Multicode') : null
  }
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'Multicode')
}

function resolveInfoPath() {
  const explicit = parseInfoPathArg(process.argv.slice(2))
  if (explicit) return explicit
  const envDir = process.env.MULTICODE_USER_DATA_DIR?.trim()
  if (envDir) return join(envDir, INFO_FILENAME)
  const defaultDir = defaultUserDataDir()
  if (!defaultDir) fail('Could not resolve the Multicode data directory; pass --info-path.')
  return join(defaultDir, INFO_FILENAME)
}

function readServerInfo(infoPath) {
  let raw
  try {
    raw = readFileSync(infoPath, 'utf8')
  } catch {
    fail(
      `No automation server discovery file at ${infoPath}. `
        + 'Multicode is not running, or the Local automation server is disabled '
        + '(Settings -> MCPs -> Local automation server).'
    )
  }
  let info
  try {
    info = JSON.parse(raw)
  } catch {
    fail(`Discovery file ${infoPath} is not valid JSON; toggle the automation server off and on to rewrite it.`)
  }
  if (typeof info.socketPath !== 'string' || info.socketPath.length === 0) {
    fail(`Discovery file ${infoPath} has no socketPath; toggle the automation server off and on to rewrite it.`)
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

socket.on('connect', () => {
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
})

socket.on('error', (error) => {
  const alive = appearsAlive(info.pid)
  if (alive === false) {
    fail(
      `Could not connect to ${info.socketPath} and the recorded app process (pid ${info.pid}) is gone — `
        + 'the discovery file is stale (the app likely crashed). Start Multicode and re-enable the automation server.'
    )
  }
  fail(`Could not connect to ${info.socketPath}: ${error.message}`)
})

// Server closed the connection (app quit or server toggled off): clean exit so
// MCP clients treat it as a normal disconnect.
socket.on('close', () => process.exit(0))
process.stdin.on('end', () => socket.end())
