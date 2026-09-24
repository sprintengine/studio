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

import { createLineDecoder } from './frames.mjs'

// A reporter frame is small; a client streaming an endless line is dropped.
export const MAX_AGENT_STATE_LINE_BYTES = 64 * 1024
// A reporter sends one or a few frames per connection.
const MAX_AGENT_STATE_LINES_PER_CONNECTION = 64
// Agents in one distribution rarely hold more than a handful of sessions each.
export const MAX_MCP_CHANNELS = 64
// Bytes per data frame, before base64.
const MCP_CHUNK_BYTES = 64 * 1024

/** Handles one `agent.sock` connection, calling `send(line)` per frame. */
export function relayAgentStateConnection(socket, send) {
  let lines = 0
  const decoder = createLineDecoder({
    maxLineBytes: MAX_AGENT_STATE_LINE_BYTES,
    onLine(line) {
      lines += 1
      if (lines > MAX_AGENT_STATE_LINES_PER_CONNECTION) {
        socket.destroy()
        return
      }
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
  socket.on('data', (chunk) => decoder.push(chunk))
  socket.on('error', () => socket.destroy())
  // A reporter that connects and never writes must not hold a descriptor.
  socket.setTimeout(10_000, () => socket.destroy())
}

/**
 * The MCP side: connections become channels. `send(frame)` writes a frame to
 * main; `handleFromMain(frame)` takes main's `data` and `close` for a channel.
 */
export function createMcpMux(send) {
  const channels = new Map()
  let nextId = 1

  function closeChannel(id, { notify }) {
    const socket = channels.get(id)
    if (!socket) return
    channels.delete(id)
    if (notify) send({ t: 'ch', ch: id, op: 'close' })
    socket.destroy()
  }

  function accept(socket) {
    if (channels.size >= MAX_MCP_CHANNELS) {
      socket.destroy()
      return
    }
    const id = nextId
    nextId += 1
    channels.set(id, socket)
    send({ t: 'ch', ch: id, op: 'open' })
    socket.on('data', (chunk) => {
      for (let offset = 0; offset < chunk.length; offset += MCP_CHUNK_BYTES) {
        send({ t: 'ch', ch: id, op: 'data', b64: chunk.subarray(offset, offset + MCP_CHUNK_BYTES).toString('base64') })
      }
    })
    // The bridge finished writing (its client closed stdin): pass the
    // half-close on, and keep delivering what the server still sends back.
    socket.on('end', () => {
      if (channels.get(id) === socket) send({ t: 'ch', ch: id, op: 'end' })
    })
    socket.on('close', () => closeChannel(id, { notify: true }))
    socket.on('error', () => closeChannel(id, { notify: true }))
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
      for (const id of [...channels.keys()]) closeChannel(id, { notify: false })
    },
  }
}
