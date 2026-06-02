// Voice dictation WAV encoding (renderer).
//
// Resamples raw mic float samples captured via Web Audio down to 16 kHz mono
// and wraps them in a canonical WAV container for upload. The encoded buffer is
// handed to the main process over the `voice:transcribe` IPC, which owns the
// network request (see `src/shared/voiceTranscription.ts`) so it is exempt from
// renderer CORS/CSP. These helpers are pure so they can be unit tested in Node.

/** Sample rate Whisper expects; the host resamples internally too, but sending
 *  16 kHz keeps the upload small. */
export const TRANSCRIBE_TARGET_SAMPLE_RATE = 16000

/** Linear-interpolate a Float32 buffer from `inputRate` down to `targetRate`.
 *  Returns the input untouched when no resampling is needed. */
export function downsampleFloat32(
  input: Float32Array,
  inputRate: number,
  targetRate: number = TRANSCRIBE_TARGET_SAMPLE_RATE
): Float32Array {
  if (targetRate >= inputRate || input.length === 0) return input
  const ratio = inputRate / targetRate
  const outLength = Math.floor(input.length / ratio)
  const output = new Float32Array(outLength)
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, input.length - 1)
    const weight = position - lower
    output[i] = input[lower] * (1 - weight) + input[upper] * weight
  }
  return output
}

/** Convert normalized float samples ([-1, 1]) to signed 16-bit PCM. */
export function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]))
    output[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return output
}

/** Wrap mono 16-bit PCM in a canonical 44-byte WAV container. */
export function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2
  const blockAlign = bytesPerSample // mono
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // channels (mono)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 8 * bytesPerSample, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    view.setInt16(offset, samples[i], true)
  }
  return buffer
}

/** Resample + encode raw mic float samples into an uploadable WAV. */
export function pcmFloatToWav(input: Float32Array, inputRate: number): ArrayBuffer {
  const downsampled = downsampleFloat32(input, inputRate)
  const pcm = floatTo16BitPCM(downsampled)
  return encodeWav(pcm, TRANSCRIBE_TARGET_SAMPLE_RATE)
}
