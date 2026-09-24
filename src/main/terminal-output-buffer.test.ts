import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { WebContents } from 'electron'
import { createTerminalOutputBuffer } from './terminal-output-buffer'
import { TerminalReplayBuffer } from './terminal-replay-buffer'
import type { TerminalSession } from './terminal-session'

const HIGH = 100
const LOW = 10
const STALL_MS = 40

function harness() {
  const sent: Array<{ channel: string; payload: string | number }> = []
  const sender = { isDestroyed: () => false } as unknown as WebContents
  const session = {
    sessionId: 'session_flow',
    sender,
    visible: true,
    lastInputAt: null,
    output: new TerminalReplayBuffer(),
  } as unknown as TerminalSession
  const flow: string[] = []
  const buffer = createTerminalOutputBuffer({
    getSession: (sessionId) => (sessionId === session.sessionId ? session : undefined),
    sendTerminalEvent: (_sender, channel, payload) => sent.push({ channel, payload }),
    recordDataBatch: () => undefined,
    flowControl: {
      highWatermark: HIGH,
      lowWatermark: LOW,
      stallResumeMs: STALL_MS,
      pause: () => flow.push('pause'),
      resume: () => flow.push('resume'),
    },
  })
  // What the runtime does per pty chunk: append to the replay, then queue it.
  const emit = (data: string) => {
    const bytes = session.output.append(data, 1024 * 1024)
    buffer.send(session, data, bytes)
  }
  return { sent, session, flow, buffer, emit }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a pane that never acknowledges is never waited on', () => {
  const { buffer, emit, flow, session } = harness()
  emit('x'.repeat(HIGH * 5))
  buffer.flush(session.sessionId)
  emit('x'.repeat(HIGH * 5))
  buffer.flush(session.sessionId)
  assert.deepEqual(flow, [], 'no window with a mounted view acks, and none may stall an agent')
})

test('pauses the pty above the high watermark and resumes at the low one', () => {
  const { buffer, emit, flow, session } = harness()
  emit('a'.repeat(60))
  buffer.flush(session.sessionId)
  // The pane acknowledges some of it: from here on it is waited on.
  buffer.ack(session.sessionId, 10)
  assert.equal(buffer.rendererBacklog(session.sessionId), 50)
  assert.deepEqual(flow, [])

  // Queued-but-unsent output counts too, so a burst inside one batch window
  // pauses the pty before main's own pending bound has to drop anything.
  emit('b'.repeat(80))
  assert.equal(buffer.rendererBacklog(session.sessionId), 130)
  assert.deepEqual(flow, ['pause'])
  assert.equal(buffer.isFlowPaused(session.sessionId), true)

  buffer.flush(session.sessionId)
  buffer.ack(session.sessionId, 100)
  assert.deepEqual(flow, ['pause'], 'still above the low watermark: stays paused')
  buffer.ack(session.sessionId, 25)
  assert.equal(buffer.rendererBacklog(session.sessionId), 5)
  assert.deepEqual(flow, ['pause', 'resume'])
  assert.equal(buffer.isFlowPaused(session.sessionId), false)
})

test('a pane that stops acknowledging while paused is given up on', async () => {
  const { buffer, emit, flow, session } = harness()
  emit('a'.repeat(20))
  buffer.flush(session.sessionId)
  buffer.ack(session.sessionId, 20)
  emit('c'.repeat(HIGH * 2))
  assert.deepEqual(flow, ['pause'])
  await delay(STALL_MS * 3)
  assert.deepEqual(flow, ['pause', 'resume'], 'the stall timer resumed the pty')
  // And it is no longer waited on until it acks again.
  buffer.flush(session.sessionId)
  emit('d'.repeat(HIGH * 2))
  assert.deepEqual(flow, ['pause', 'resume'])
})

test('a reset (hide, reveal, replay, new window) resumes and forgets the pane', () => {
  const { buffer, emit, flow, session } = harness()
  emit('a'.repeat(20))
  buffer.flush(session.sessionId)
  buffer.ack(session.sessionId, 20)
  emit('e'.repeat(HIGH * 2))
  assert.deepEqual(flow, ['pause'])
  buffer.resetRendererFlow(session.sessionId)
  assert.deepEqual(flow, ['pause', 'resume'])
  buffer.flush(session.sessionId)
  emit('f'.repeat(HIGH * 2))
  assert.deepEqual(flow, ['pause', 'resume'], 'not acking since the reset, so not waited on')
})

test('records how far the pane has been sent, and not while it is hidden', () => {
  const { buffer, emit, session, sent } = harness()
  emit('one\r\n')
  buffer.flush(session.sessionId)
  assert.equal(session.rendererDeliveredOffset, session.output.endOffset)
  assert.equal(session.rendererDeliveredTo, session.sender)
  const delivered = session.rendererDeliveredOffset

  session.visible = false
  emit('two\r\n')
  buffer.flush(session.sessionId)
  assert.equal(session.rendererDeliveredOffset, delivered, 'a hidden pane was sent nothing')
  assert.equal(sent.length, 1)
  assert.equal(session.output.readFrom(delivered ?? 0), 'two\r\n', 'what the reveal owes the pane')
})
