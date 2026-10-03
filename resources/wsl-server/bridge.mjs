#!/usr/bin/env node
// The stdio bridge: bytes between this process's stdin and stdout and the
// Studio server's front-door socket, in both directions, unchanged.
//
// The Windows side runs it through `wsl.exe --exec sh -s` when it cannot reach
// the server over loopback TCP (forwarding off, a port another Windows process
// holds). It frames nothing and holds no credential: the mutual proof runs
// through it like any other byte, between the two ends that can check it.
//
// Its first words are a ready line on stdout, before it reads anything, so the
// `sh` that exec'd it cannot have swallowed what follows on stdin as script.
// The first line in is the socket's absolute path; every byte after that line
// goes to the socket. Either side closing ends the bridge.
//
// With `--mux <runDir>` it is an SSH machine's relay instead (phase 8, the
// same program by decision R21): one SSH session's stdio carries many streams
// (relay-mux.mjs), each either a connection to the Studio server's front door,
// proven with the owner token the relay reads from the private run directory,
// so the token never leaves this machine, or a TCP connection made from here,
// which is how the desktop's browser pane reaches this machine's network. Its
// ready line then names the running server, from its record, so the desktop
// knows what it reached before it opens anything.

import { connect } from 'node:net'
import { isAbsolute } from 'node:path'

import { MUX_VERSION, readServerRecord, serveRelay } from './relay-mux.mjs'

const BRIDGE_READY = '@@SPRINTENGINE_BRIDGE_READY'
const RELAY_READY = '@@SPRINTENGINE_RELAY'

const MAX_PATH_LINE = 1024

function fail(message) {
  process.stderr.write(`[studio-bridge] ${message}\n`)
  process.exit(2)
}

function start() {
  process.stdout.write(`${BRIDGE_READY}\n`)
  let head = Buffer.alloc(0)
  const onFirst = (chunk) => {
    head = Buffer.concat([head, chunk])
    const newline = head.indexOf(0x0a)
    if (newline === -1) {
      if (head.length > MAX_PATH_LINE) fail('The socket path line is too long.')
      return
    }
    process.stdin.off('data', onFirst)
    process.stdin.pause()
    const path = head.subarray(0, newline).toString('utf8').trim()
    const rest = head.subarray(newline + 1)
    if (!path.startsWith('/') || path.includes('\0') || !path.endsWith('.sock')) fail('That is not a socket path.')
    const socket = connect({ path, allowHalfOpen: true })
    socket.on('error', (error) => fail(`The socket refused: ${error.message}`))
    socket.once('connect', () => {
      if (rest.length > 0) socket.write(rest)
      process.stdin.pipe(socket)
      socket.pipe(process.stdout)
      socket.once('close', () => process.exit(0))
    })
  }
  process.stdin.on('data', onFirst)
  process.stdin.once('end', () => {
    // The Windows side is gone before (or after) the path: nothing to carry.
    if (head.indexOf(0x0a) === -1) process.exit(0)
  })
  process.stdout.on('error', () => process.exit(0))
}

function startMux(runDir) {
  if (!isAbsolute(runDir) || runDir.includes('\0')) fail('The run directory must be an absolute path.')
  const server = readServerRecord(runDir)
  const ready = {
    mux: MUX_VERSION,
    pid: process.pid,
    server: server
      ? {
          pid: server.pid ?? null,
          version: server.version ?? null,
          origin: server.origin ?? null,
          backendWire: server.backendWire ?? null,
          environmentId: server.environmentId ?? null,
          hostId: server.hostId ?? null,
          startedBy: server.startedBy ?? null,
        }
      : null,
  }
  process.stdout.write(`${RELAY_READY} ${JSON.stringify(ready)}\n`)
  // The SSH client's own address, for the server's audit log: who reached it, never what was said.
  const client = (process.env.SSH_CONNECTION ?? '').split(' ')[0] || null
  const { endpoint, stats } = serveRelay({ input: process.stdin, output: process.stdout, runDir, client })
  endpoint.onClosed((reason) => {
    process.stderr.write(
      `[studio-relay] ${reason} owner=${stats.owner} tcp=${stats.tcp} refused=${stats.refused} in=${stats.bytesIn} out=${stats.bytesOut} targets=${[...stats.targets].join(',')}\n`,
    )
    process.exit(0)
  })
  process.stdout.on('error', () => process.exit(0))
}

const muxAt = process.argv.indexOf('--mux')
if (muxAt !== -1) startMux(process.argv[muxAt + 1] ?? '')
else start()
