// The two things the helper relays between Linux and main.
//
// Agent state: a hook reporter, the status-line forwarder or OpenCode's plugin
// connects to `agent.sock`, writes newline-delimited JSON frames and hangs up.
// Each line is capped, parsed, and sent to main as it arrived; main validates
// it with the same parser that reads its own socket (`parseAgentStateFrame`),
// so a frame from WSL is held to exactly the rules one from this machine is.
//
// MCP: each connection to `mcp.sock` is one MCP bridge (one agent's session
// with the app's automation server). It becomes a numbered channel on the
// stdio wire, and main connects that channel to the automation server and to
// nothing else: the helper cannot name a destination, so a channel can only
// ever reach the one server the bridge exists for.
//
// That server can start a shell on Windows, so a channel is only opened for a
// bridge that proves it was started by one of the app's own launches. Each WSL
// agent launch is given a token (exported by its startup script, inherited by
// the CLI and so by the bridge it starts), and the bridge's first line on
// `mcp.sock` is `{"t":"auth","token":"…"}`. The helper passes the token on in
// the channel's `open`, and main checks it against the tokens of launches that
// are still running before it connects anything. A connection whose first
// line is not an auth line is dropped here without reaching main at all, and
// revoking a token also closes the channels it opened. Owning the socket file
// is not enough: with `[interop] enabled=false` nothing else in the
// distribution can reach Windows.
//
// What this raises is the bar, not a wall. The token lives in the agent's
// environment, so the agent's own children have it, and anything running as
// the same user that reads `/proc/<pid>/environ` can take it while the
// session lives. The startup script deletes itself once read, so the token is
// not also left on disk.

import { createLineDecoder } from './frames.mjs'

// A reporter frame is small; a client streaming an endless line is dropped.
export const MAX_AGENT_STATE_LINE_BYTES = 64 * 1024
// What one connection may send in all. OpenCode's plugin keeps one
// connection open and sends a frame per file a patch touched, so a count of
// lines would cut a large patch short; bytes still bound a runaway writer.
export const MAX_AGENT_STATE_BYTES_PER_CONNECTION = 16 * 1024 * 1024
// Agents in one distribution rarely hold more than a handful of sessions each.
export const MAX_MCP_CHANNELS = 64
// Bytes per data frame, before base64.
const MCP_CHUNK_BYTES = 64 * 1024
// The auth line: small, and sent at once by a bridge that has one.
const MAX_AUTH_LINE_BYTES = 1024
const AUTH_TIMEOUT_MS = 10_000
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/u

/** Handles one `agent.sock` connection, calling `send(line)` per frame. */
export function relayAgentStateConnection(socket, send) {
  let bytes = 0
  const decoder = createLineDecoder({
    maxLineBytes: MAX_AGENT_STATE_LINE_BYTES,
    onLine(line) {
      let parsed
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) send(line)
    },
    onOverflow: () => socket.destroy(),
  })
  socket.on('data', (chunk) => {
    bytes += chunk.length
    if (bytes > MAX_AGENT_STATE_BYTES_PER_CONNECTION) {
      socket.destroy()
      return
    }
    decoder.push(chunk)
  })
  socket.on('error', () => socket.destroy())
  // A reporter that connects and never writes must not hold a descriptor.
  socket.setTimeout(10_000, () => socket.destroy())
}

/**
 * The token a bridge's first line carries, or null when the line is not an
 * auth line.
 */
export function parseAuthLine(line) {
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || parsed.t !== 'auth') return null
  return typeof parsed.token === 'string' && TOKEN.test(parsed.token) ? parsed.token : null
}

/**
 * The MCP side: connections become channels. `send(frame)` writes a frame to
 * main; `handleFromMain(frame)` takes main's `data` and `close` for a channel.
 */
export function createMcpMux(send) {
  const channels = new Map()
  // Connections still waiting for their auth line; closed with the rest.
  const waiting = new Set()
  let nextId = 1

  function closeChannel(id, { notify }) {
    const socket = channels.get(id)
    if (!socket) return
    channels.delete(id)
    if (notify) send({ t: 'ch', ch: id, op: 'close' })
    socket.destroy()
  }

  function open(socket, token, rest) {
    if (channels.size >= MAX_MCP_CHANNELS) {
      socket.destroy()
      return
    }
    const id = nextId
    nextId += 1
    channels.set(id, socket)
    send({ t: 'ch', ch: id, op: 'open', token })
    const forward = (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += MCP_CHUNK_BYTES) {
        send({ t: 'ch', ch: id, op: 'data', b64: chunk.subarray(offset, offset + MCP_CHUNK_BYTES).toString('base64') })
      }
    }
    if (rest.length > 0) forward(rest)
    socket.on('data', forward)
    // The bridge finished writing (its client closed stdin): pass the
    // half-close on, and keep delivering what the server still sends back.
    const onEnd = () => {
      if (channels.get(id) === socket) send({ t: 'ch', ch: id, op: 'end' })
    }
    if (socket.readableEnded) onEnd()
    else socket.on('end', onEnd)
    socket.on('close', () => closeChannel(id, { notify: true }))
    socket.on('error', () => closeChannel(id, { notify: true }))
  }

  function accept(socket) {
    if (channels.size + waiting.size >= MAX_MCP_CHANNELS) {
      socket.destroy()
      return
    }
    waiting.add(socket)
    let head = Buffer.alloc(0)
    const drop = () => {
      waiting.delete(socket)
      socket.destroy()
    }
    const timer = setTimeout(drop, AUTH_TIMEOUT_MS)
    timer.unref?.()
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const newline = head.indexOf(0x0a)
      if (newline === -1) {
        if (head.length > MAX_AUTH_LINE_BYTES) {
          clearTimeout(timer)
          drop()
        }
        return
      }
      clearTimeout(timer)
      socket.off('data', onData)
      socket.off('close', onGone)
      socket.off('error', onGone)
      waiting.delete(socket)
      const token = newline <= MAX_AUTH_LINE_BYTES ? parseAuthLine(head.subarray(0, newline).toString('utf8')) : null
      if (!token) {
        socket.destroy()
        return
      }
      // Held until the listeners above are attached, so nothing the bridge
      // sent after its auth line is read before there is somewhere to put it.
      socket.pause()
      open(socket, token, head.subarray(newline + 1))
      socket.resume()
    }
    const onGone = () => {
      clearTimeout(timer)
      waiting.delete(socket)
    }
    socket.on('data', onData)
    socket.on('close', onGone)
    socket.on('error', onGone)
  }

  function handleFromMain(frame) {
    const id = frame.ch
    const socket = channels.get(id)
    if (!socket) return
    if (frame.op === 'data' && typeof frame.b64 === 'string') {
      socket.write(Buffer.from(frame.b64, 'base64'))
    } else if (frame.op === 'end') {
      socket.end()
    } else if (frame.op === 'close') {
      channels.delete(id)
      socket.end()
      // A bridge that will not finish its half is not waited on.
      setTimeout(() => socket.destroy(), 2_000).unref()
    }
  }

  return {
    accept,
    handleFromMain,
    size: () => channels.size,
    closeAll() {
      for (const socket of waiting) socket.destroy()
      waiting.clear()
      for (const id of [...channels.keys()]) closeChannel(id, { notify: false })
    },
  }
}
