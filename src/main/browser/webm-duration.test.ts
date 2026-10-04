import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'vitest'

import { readWebmDurationMs, withWebmDuration } from './webm-duration'

// A second of a 160×120 page recorded by Electron's own MediaRecorder (VP9),
// exactly as the pane's recorder writes it: a live stream, so no Duration.
const RECORDED = new Uint8Array(readFileSync(join(__dirname, '__fixtures__', 'media-recorder-vp9-160x120.webm')))

// The fixture's layout: Segment at 36 (8-byte unknown size), Info at 48 with a
// one-byte size of 25, Tracks from 78, the first Cluster from 154.
const INFO_SIZE_AT = 52
const INFO_END = 78

test('a live recording states no length until one is written', () => {
  assert.equal(readWebmDurationMs(RECORDED), null)
})

test('the length is inserted at the end of Info, and every byte after it is the same', () => {
  const patched = withWebmDuration(RECORDED, 1034.5)
  assert.ok(patched)
  assert.equal(readWebmDurationMs(patched), 1034.5)
  assert.equal(patched.length, RECORDED.length + 11)
  // Info's size grew by the 11 bytes of the Duration element, in the same one byte.
  assert.equal(patched[INFO_SIZE_AT], RECORDED[INFO_SIZE_AT]! + 11)
  assert.deepEqual(patched.subarray(0, INFO_SIZE_AT), RECORDED.subarray(0, INFO_SIZE_AT))
  assert.deepEqual(patched.subarray(INFO_END + 11), RECORDED.subarray(INFO_END), 'tracks and clusters untouched')
  assert.equal(readWebmDurationMs(RECORDED), null, 'the input is not modified')
})

test('a file that already states a length has it overwritten in place', () => {
  const once = withWebmDuration(RECORDED, 500)!
  const twice = withWebmDuration(once, 2_000)!
  assert.equal(twice.length, once.length)
  assert.equal(readWebmDurationMs(twice), 2_000)
})

test('anything that is not a WebM header, Segment and Info is left alone', () => {
  assert.equal(withWebmDuration(new Uint8Array(0), 1_000), null)
  assert.equal(withWebmDuration(new Uint8Array([1, 2, 3, 4]), 1_000), null)
  assert.equal(withWebmDuration(RECORDED.subarray(0, 60), 1_000), null, 'cut off inside Info')
  assert.equal(withWebmDuration(RECORDED, Number.NaN), null)
  assert.equal(withWebmDuration(RECORDED, -1), null)
})

// A minimal file built by hand: EBML header, Segment, then the given children.
function webm(segmentChildren: number[][], segmentSize: 'unknown' | 'known' = 'unknown'): Uint8Array {
  const header = [0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 0x01]
  const body = segmentChildren.flat()
  const size = segmentSize === 'unknown' ? [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : [0x80 | body.length]
  return new Uint8Array([...header, 0x18, 0x53, 0x80, 0x67, ...size, ...body])
}
const infoWith = (payload: number[]) => [0x15, 0x49, 0xa9, 0x66, 0x80 | payload.length, ...payload]
const TIMECODE_SCALE_1MS = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]
const CLUSTER = [0x1f, 0x43, 0xb6, 0x75, 0x81, 0x00]

test('a SeekHead before Info is not edited: its offsets would move', () => {
  const seekHead = [0x11, 0x4d, 0x9b, 0x74, 0x80]
  assert.equal(withWebmDuration(webm([seekHead, infoWith(TIMECODE_SCALE_1MS), CLUSTER]), 1_000), null)
})

test('a Segment of known size grows with its Info', () => {
  const file = webm([infoWith(TIMECODE_SCALE_1MS), CLUSTER], 'known')
  const patched = withWebmDuration(file, 750)!
  assert.equal(readWebmDurationMs(patched), 750)
  // The Segment's one-byte size, right after its id at 9..12.
  assert.equal(patched[13], file[13]! + 11)
})

test('the length is written in the file’s own timecode scale', () => {
  // 1 tick = 1 µs: 1.5 s is 1,500,000 ticks, read back as 1500 ms.
  const microsecondTicks = [0x2a, 0xd7, 0xb1, 0x82, 0x03, 0xe8]
  const patched = withWebmDuration(webm([infoWith(microsecondTicks), CLUSTER]), 1_500)!
  assert.equal(readWebmDurationMs(patched), 1_500)
  const view = new DataView(patched.buffer)
  const durationAt = patched.findIndex((byte, index) => byte === 0x44 && patched[index + 1] === 0x89)
  assert.equal(view.getFloat64(durationAt + 3), 1_500_000)
})

test('an Info that outgrows its one-byte size takes a wider one', () => {
  // A payload of 120 bytes (a long WritingApp) plus the 11-byte Duration is past 126.
  const writingApp = [0x57, 0x41, 0x80 | 117, ...new Array<number>(117).fill(0x61)]
  const patched = withWebmDuration(webm([infoWith(writingApp), CLUSTER]), 250)!
  assert.equal(readWebmDurationMs(patched), 250)
  assert.equal(patched.length, webm([infoWith(writingApp), CLUSTER]).length + 12)
})
