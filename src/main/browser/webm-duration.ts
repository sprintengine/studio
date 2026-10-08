// The duration a WebM recording says it lasts.
//
// Chromium's MediaRecorder writes WebM as a live stream: the Segment and its
// Clusters have unknown sizes, and the Segment Info carries no Duration,
// because the muxer does not know how long the recording will be when it
// writes the header. Players then show the length as unknown and most will not
// seek. Once a recording has ended its length is known, so it is written into
// the Info element here, before the file is saved.
//
// This is a small EBML edit, not a remux: one Duration element is inserted at
// the end of Info (or an existing one overwritten in place), Info's size is
// grown to match, and every byte after it is copied unchanged. Nothing else in
// a live recording holds a byte offset that the insertion could move: there is
// no SeekHead and no Cues. A file that has a SeekHead before its Info, or that
// is not laid out as a WebM header, Segment and Info at all, is left as it is
// (`null`), still playable, only without a length.
//
// Everything the edit touches sits in the file's first few hundred bytes, so
// `webmDurationPatch` reads only a head of the file and answers the bytes that
// replace that part of it; a recording of tens of megabytes is then written
// as the patched head and the rest of the file copied after it, never held
// whole.

const EBML_HEADER_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const SEEK_HEAD_ID = 0x114d9b74
const INFO_ID = 0x1549a966
const CLUSTER_ID = 0x1f43b675
const TIMECODE_SCALE_ID = 0x2ad7b1
const DURATION_ID = 0x4489

/** Nanoseconds per timecode tick when Info names no scale: one millisecond. */
const DEFAULT_TIMECODE_SCALE = 1_000_000

/** How far into the Segment Info is looked for. Chromium writes it first. */
const MAX_SEGMENT_CHILDREN_BEFORE_INFO = 8

type Vint = { value: number; length: number; unknown: boolean }

/** An element id: its marker bits kept, 1 to 4 bytes. */
function readId(bytes: Uint8Array, offset: number): Vint | null {
  const first = bytes[offset]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 4 && (first & (0x80 >> (length - 1))) === 0) length += 1
  if (length > 4 || offset + length > bytes.length) return null
  let value = 0
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index]
  return { value, length, unknown: false }
}

/** An element size: its marker bit dropped, 1 to 8 bytes; all ones is "unknown". */
function readSize(bytes: Uint8Array, offset: number): Vint | null {
  const first = bytes[offset]
  if (first === undefined || first === 0) return null
  let length = 1
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1
  if (length > 8 || offset + length > bytes.length) return null
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]
    value = value * 256 + byte
    if (byte !== 0xff) allOnes = false
  }
  return { value, length, unknown: allOnes }
}

/** A size as `length` bytes, or null when it does not fit (the all-ones value is reserved for "unknown"). */
function encodeSize(value: number, length: number): Uint8Array | null {
  if (length < 1 || length > 8 || value < 0 || !Number.isSafeInteger(value)) return null
  if (value >= 2 ** (7 * length) - 1) return null
  const out = new Uint8Array(length)
  let rest = value
  for (let index = length - 1; index >= 0; index -= 1) {
    out[index] = rest % 256
    rest = Math.floor(rest / 256)
  }
  out[0] |= 0x80 >> (length - 1)
  return out
}

/** The shortest size encoding, never shorter than `atLeast`. */
function encodeSizeAtLeast(value: number, atLeast: number): Uint8Array | null {
  for (let length = atLeast; length <= 8; length += 1) {
    const encoded = encodeSize(value, length)
    if (encoded) return encoded
  }
  return null
}

type Element = { id: number; start: number; sizeStart: number; sizeLength: number; dataStart: number; size: Vint }

/** An element at `offset` of a file `total` bytes long, of which `bytes` is the start. */
function readElement(bytes: Uint8Array, offset: number, total: number): Element | null {
  const id = readId(bytes, offset)
  if (!id) return null
  const size = readSize(bytes, offset + id.length)
  if (!size) return null
  const dataStart = offset + id.length + size.length
  if (!size.unknown && dataStart + size.value > total) return null
  return { id: id.value, start: offset, sizeStart: offset + id.length, sizeLength: size.length, dataStart, size }
}

type InfoLayout = {
  segment: Element
  info: Element
  /** Nanoseconds per tick. */
  timecodeScale: number
  /** Where an existing Duration's float starts, and how wide it is. */
  duration: { dataStart: number; width: 4 | 8 } | null
}

function readUnsigned(bytes: Uint8Array, start: number, length: number): number {
  let value = 0
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[start + index]
  return value
}

/** Where Info is in a file `total` bytes long, of which `bytes` is the start; null unless all of Info is in it. */
function locateInfo(bytes: Uint8Array, total = bytes.length): InfoLayout | null {
  const header = readElement(bytes, 0, total)
  if (!header || header.id !== EBML_HEADER_ID || header.size.unknown) return null
  const segment = readElement(bytes, header.dataStart + header.size.value, total)
  if (!segment || segment.id !== SEGMENT_ID) return null
  const segmentEnd = segment.size.unknown ? total : segment.dataStart + segment.size.value
  let offset = segment.dataStart
  for (let seen = 0; seen < MAX_SEGMENT_CHILDREN_BEFORE_INFO && offset < segmentEnd; seen += 1) {
    const child = readElement(bytes, offset, total)
    // A SeekHead holds offsets the insertion would move; a Cluster before any
    // Info means the layout is not the one this edit understands.
    if (!child || child.id === SEEK_HEAD_ID || child.id === CLUSTER_ID || child.size.unknown) return null
    if (child.id === INFO_ID) {
      let timecodeScale = DEFAULT_TIMECODE_SCALE
      let duration: InfoLayout['duration'] = null
      const infoEnd = child.dataStart + child.size.value
      if (infoEnd > bytes.length) return null
      let inner = child.dataStart
      while (inner < infoEnd) {
        const field = readElement(bytes, inner, total)
        if (!field || field.size.unknown) return null
        const fieldEnd = field.dataStart + field.size.value
        if (fieldEnd > infoEnd) return null
        if (field.id === TIMECODE_SCALE_ID && field.size.value >= 1 && field.size.value <= 8) {
          timecodeScale = readUnsigned(bytes, field.dataStart, field.size.value) || DEFAULT_TIMECODE_SCALE
        } else if (field.id === DURATION_ID) {
          if (field.size.value !== 4 && field.size.value !== 8) return null
          duration = { dataStart: field.dataStart, width: field.size.value }
        }
        inner = fieldEnd
      }
      return { segment, info: child, timecodeScale, duration }
    }
    offset = child.dataStart + child.size.value
  }
  return null
}

/** The length a WebM file states, in milliseconds, or null when it states none. */
export function readWebmDurationMs(bytes: Uint8Array): number | null {
  const layout = locateInfo(bytes)
  if (!layout?.duration) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ticks =
    layout.duration.width === 8
      ? view.getFloat64(layout.duration.dataStart)
      : view.getFloat32(layout.duration.dataStart)
  return (ticks * layout.timecodeScale) / 1_000_000
}

/**
 * The file with its length set to `durationMs`, or null when it cannot be
 * edited safely (see the header). The input is never modified.
 */
export function withWebmDuration(bytes: Uint8Array, durationMs: number): Uint8Array | null {
  const patch = webmDurationPatch(bytes, bytes.length, durationMs)
  if (!patch) return null
  const out = new Uint8Array(patch.head.length + bytes.length - patch.replaces)
  out.set(patch.head, 0)
  out.set(bytes.subarray(patch.replaces), patch.head.length)
  return out
}

/** What sets a file's length: `head` written in place of its first `replaces` bytes. */
export type WebmDurationPatch = { head: Uint8Array; replaces: number }

/**
 * The patch that sets the length of a file `total` bytes long to
 * `durationMs`, read from `head`, the file's first bytes; null when it cannot
 * be edited safely (see the header), or when Info does not end inside `head`.
 * `head` is never modified.
 */
export function webmDurationPatch(head: Uint8Array, total: number, durationMs: number): WebmDurationPatch | null {
  if (!Number.isFinite(durationMs) || durationMs < 0 || head.length > total) return null
  const layout = locateInfo(head, total)
  if (!layout) return null
  const ticks = (durationMs * 1_000_000) / layout.timecodeScale
  const { info, segment } = layout
  const infoEnd = info.dataStart + info.size.value

  if (layout.duration) {
    const copy = head.slice(0, infoEnd)
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength)
    if (layout.duration.width === 8) view.setFloat64(layout.duration.dataStart, ticks)
    else view.setFloat32(layout.duration.dataStart, ticks)
    return { head: copy, replaces: infoEnd }
  }

  // Duration: its id, a one-byte size of 8, and a big-endian float64.
  const durationElement = new Uint8Array(11)
  durationElement[0] = DURATION_ID >> 8
  durationElement[1] = DURATION_ID & 0xff
  durationElement[2] = 0x88
  new DataView(durationElement.buffer).setFloat64(3, ticks)

  const infoSize = encodeSizeAtLeast(info.size.value + durationElement.length, info.sizeLength)
  if (!infoSize) return null
  const grownBy = durationElement.length + (infoSize.length - info.sizeLength)

  // A Segment of known size grows by the same amount. Chromium's is unknown.
  let segmentSize: Uint8Array | null = null
  if (!segment.size.unknown) {
    segmentSize = encodeSizeAtLeast(segment.size.value + grownBy, segment.sizeLength)
    if (!segmentSize) return null
  }

  const parts: Uint8Array[] = []
  if (segmentSize) {
    parts.push(head.subarray(0, segment.sizeStart), segmentSize, head.subarray(segment.dataStart, info.sizeStart))
  } else {
    parts.push(head.subarray(0, info.sizeStart))
  }
  parts.push(infoSize, head.subarray(info.dataStart, infoEnd), durationElement)

  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return { head: out, replaces: infoEnd }
}
