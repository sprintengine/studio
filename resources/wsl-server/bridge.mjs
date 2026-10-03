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

import { connect } from 'node:net'

const BRIDGE_READY = '@@SPRINTENGINE_BRIDGE_READY'

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

start()
