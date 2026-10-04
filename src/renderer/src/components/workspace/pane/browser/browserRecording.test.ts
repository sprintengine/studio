import assert from 'node:assert/strict'
import { test } from 'vitest'

import { AGENT_CURSOR_LINGER_MS } from './agentCursor'
import {
  CLICK_PULSE_MS,
  chooseRecordingMimeType,
  containRect,
  cursorPose,
  recordingClock,
  type CursorEvent,
} from './browserRecording'

// The recorder's arithmetic: which encoding, where a frame sits on the canvas,
// where the agent's cursor lands on it, and the toolbar's clock.

test('VP9 when the build has it, then VP8, then plain WebM; nothing else', () => {
  assert.equal(
    chooseRecordingMimeType(() => true),
    'video/webm;codecs=vp9',
  )
  assert.equal(
    chooseRecordingMimeType((type) => type !== 'video/webm;codecs=vp9'),
    'video/webm;codecs=vp8',
  )
  assert.equal(
    chooseRecordingMimeType((type) => type === 'video/webm'),
    'video/webm',
  )
  assert.equal(
    chooseRecordingMimeType((type) => type === 'video/mp4'),
    null,
  )
})

test('a frame of another shape is fitted whole and centred', () => {
  assert.deepEqual(containRect({ width: 1280, height: 800 }, { width: 1280, height: 800 }), {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
  })
  // A tab resized to a phone mid-recording: pillarboxed in the first frame's size.
  assert.deepEqual(containRect({ width: 390, height: 844 }, { width: 1280, height: 800 }), {
    x: (1280 - 390 * (800 / 844)) / 2,
    y: 0,
    width: 390 * (800 / 844),
    height: 800,
  })
  assert.deepEqual(containRect({ width: 0, height: 0 }, { width: 10, height: 10 }), {
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  })
})

const frame = { x: 0, y: 0, width: 1280, height: 800 }
const at = 10_000
const event = (overrides: Partial<CursorEvent> = {}): CursorEvent => ({
  tabId: 't1',
  x: 320,
  y: 200,
  kind: 'move',
  viewport: { width: 640, height: 400 },
  at,
  ...overrides,
})

test("the cursor lands on the frame where the page's point is, at the frame's scale", () => {
  const pose = cursorPose(event(), at, frame)!
  assert.equal(pose.x, 640)
  assert.equal(pose.y, 400)
  assert.equal(pose.scale, 2)
  assert.equal(pose.opacity, 1)
  assert.equal(pose.pulse, null)
  const offset = cursorPose(event(), at, { x: 100, y: 0, width: 640, height: 400 })!
  assert.equal(offset.x, 420)
  assert.equal(offset.scale, 1)
})

test('it shows for as long as the overlay does, fading at the end', () => {
  assert.equal(cursorPose(event(), at + AGENT_CURSOR_LINGER_MS - 100, frame)!.opacity, 0.5)
  assert.equal(cursorPose(event(), at + AGENT_CURSOR_LINGER_MS + 1, frame), null)
})

test('a click rings, growing and fading over its pulse', () => {
  const start = cursorPose(event({ kind: 'click' }), at, frame)!
  assert.deepEqual(start.pulse, { radius: 12, opacity: 0.5 })
  const half = cursorPose(event({ kind: 'click' }), at + CLICK_PULSE_MS / 2, frame)!
  assert.deepEqual(half.pulse, { radius: 26, opacity: 0.25 })
  assert.equal(cursorPose(event({ kind: 'click' }), at + CLICK_PULSE_MS, frame)!.pulse, null)
})

test('an event without the viewport, or no event, draws no cursor', () => {
  assert.equal(cursorPose(null, at, frame), null)
  assert.equal(cursorPose(event({ viewport: undefined }), at, frame), null)
  assert.equal(cursorPose(event({ viewport: { width: 0, height: 400 } }), at, frame), null)
})

test('the clock reads minutes and seconds', () => {
  assert.equal(recordingClock(0), '0:00')
  assert.equal(recordingClock(7_900), '0:07')
  assert.equal(recordingClock(90_000), '1:30')
  assert.equal(recordingClock(-5), '0:00')
})
