// Newline-delimited JSON, the helper's only wire.
//
// Main and the helper talk over the stdio of the one `wsl.exe` process that
// started the helper: one JSON object per line, in both directions. This is an
// app-internal wire. Both ends ship in the same build (main always starts the
// copy of the helper it installed itself), so it is deliberately outside
// docs/compatibility.md: a protocol mismatch is answered by killing the helper
// and starting the right one, never by negotiating a support window. Do not add
// one.

/** Bumped whenever a frame's meaning changes. Main refuses any other value. */
export const PROTOCOL_VERSION = 1

/**
 * A line decoder with a size cap. `onLine` gets each complete line without its
 * newline; a line that grows past `maxLineBytes` before its newline arrives is
 * reported to `onOverflow` and the decoder stops accepting input, because the
 * only sender that produces one is broken or hostile.
 */
export function createLineDecoder({ maxLineBytes, onLine, onOverflow }) {
  let pending = []
  let pendingBytes = 0
  let dead = false
  return {
    push(chunk) {
      if (dead) return
      let buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      let newline = buffer.indexOf(0x0a)
      while (newline !== -1) {
        const head = buffer.subarray(0, newline)
        if (pendingBytes + head.length > maxLineBytes) {
          dead = true
          onOverflow?.()
          return
        }
        const line = pending.length > 0 ? Buffer.concat([...pending, head]) : head
        pending = []
        pendingBytes = 0
        const text = line.toString('utf8').replace(/\r$/u, '')
        if (text.trim()) onLine(text)
        if (dead) return
        buffer = buffer.subarray(newline + 1)
        newline = buffer.indexOf(0x0a)
      }
      if (buffer.length > 0) {
        if (pendingBytes + buffer.length > maxLineBytes) {
          dead = true
          onOverflow?.()
          return
        }
        pending.push(Buffer.from(buffer))
        pendingBytes += buffer.length
      }
    },
    /** Bytes held for a line whose newline has not arrived. */
    pendingBytes: () => pendingBytes,
  }
}

/** One frame as the bytes that go on the wire. */
export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`
}

/** A line as a frame object, or null when it is not a JSON object. */
export function decodeFrame(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}
