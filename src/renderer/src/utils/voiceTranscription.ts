// Voice dictation transcription client.
//
// Talks to a Multivoice transcription host over its batch HTTP contract
// (POST {base}/v1/transcriptions with a 16 kHz mono 16-bit WAV body and
// x-multivoice-* headers). The host can live anywhere the URL points — a
// remote/Cloudflare-hosted deployment, a machine on the LAN, or one running
// locally on 127.0.0.1 — so a single protocol covers every deployment mode.
//
// The pure helpers (URL/header building, resampling, WAV encoding, response
// parsing) are isolated from the DOM/`fetch` so they can be unit tested in
// Node. `transcribeAudio` is the only impure entry point.

import type { VoiceDictationSettings } from '../types/workspace'

/** Sample rate Whisper expects; the host resamples internally too, but sending
 *  16 kHz keeps the upload small. */
export const TRANSCRIBE_TARGET_SAMPLE_RATE = 16000

export type TranscriptionResult = {
  text: string
  durationSeconds: number | null
  backend: string | null
  model: string | null
  serverVersion: string | null
}

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TranscriptionError'
  }
}

/** Join the configured base URL with the host's transcription route, tolerating
 *  a trailing slash or an accidentally-included `/v1` suffix. */
export function buildTranscriptionUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/u, '')
  if (!trimmed) throw new TranscriptionError('No transcription server URL is configured.')
  if (/\/v1\/transcriptions$/u.test(trimmed)) return trimmed
  if (/\/v1$/u.test(trimmed)) return `${trimmed}/transcriptions`
  return `${trimmed}/v1/transcriptions`
}

/** Headers for a Multivoice host transcription request. Matches the contract in
 *  multivoice-tauri's remote_transcription.rs (`transcription_headers`). */
export function buildTranscriptionHeaders(settings: VoiceDictationSettings): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'audio/wav',
    'x-multivoice-client': 'multicode',
    'x-multivoice-backend': 'whisper',
    'x-multivoice-model': settings.model,
    'x-multivoice-language': settings.language || 'auto',
  }
  const token = settings.authToken.trim()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

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

/** Parse a Multivoice host transcription response, throwing on an empty result. */
export function parseTranscriptionResponse(payload: unknown): TranscriptionResult {
  if (!payload || typeof payload !== 'object') {
    throw new TranscriptionError('The transcription server returned an unexpected response.')
  }
  const record = payload as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!text) throw new TranscriptionError('The transcription server returned no text.')
  return {
    text,
    durationSeconds: typeof record.durationSeconds === 'number' ? record.durationSeconds : null,
    backend: typeof record.backend === 'string' ? record.backend : null,
    model: typeof record.model === 'string' ? record.model : null,
    serverVersion: typeof record.serverVersion === 'string' ? record.serverVersion : null,
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** POST a WAV recording to the configured Multivoice host and return the text. */
export async function transcribeAudio(
  wav: ArrayBuffer,
  settings: VoiceDictationSettings,
  fetchImpl: FetchLike = fetch
): Promise<TranscriptionResult> {
  const url = buildTranscriptionUrl(settings.serverUrl)
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: buildTranscriptionHeaders(settings),
      body: wav,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new TranscriptionError(`Could not reach the transcription server at ${url}. ${detail}`)
  }

  if (response.status === 401) {
    throw new TranscriptionError('The transcription server rejected the auth token (401).')
  }
  if (response.status === 429) {
    throw new TranscriptionError('The transcription server is busy with another request (429).')
  }
  if (!response.ok) {
    throw new TranscriptionError(`The transcription server returned an error (HTTP ${response.status}).`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new TranscriptionError('The transcription server returned a non-JSON response.')
  }
  return parseTranscriptionResponse(payload)
}
