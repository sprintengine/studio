// Voice dictation transcription contract (network layer).
//
// Talks to a Multivoice transcription host over its batch HTTP contract
// (POST {base}/v1/transcriptions with a 16 kHz mono 16-bit WAV body and
// x-multivoice-* headers). The host can live anywhere the URL points — a
// remote/Cloudflare-hosted deployment, a machine on the LAN, or one running
// locally on 127.0.0.1 — so a single protocol covers every deployment mode.
//
// This module lives in `shared` and runs in the MAIN process: the Multivoice
// host speaks a native-client contract (custom x-multivoice-* headers, no CORS
// headers), so a renderer `fetch` is blocked by Chromium's CORS preflight with
// a bare "Failed to fetch". Issuing the request from the main process bypasses
// CORS/CSP entirely. The renderer encodes the WAV and hands it to main over the
// `voice:transcribe` IPC. The pure helpers are isolated from `fetch` so they can
// be unit tested in Node; `transcribeAudio` is the only impure entry point.

/** Minimal settings shape the transcription request depends on. Structurally
 *  satisfied by the renderer's `VoiceDictationSettings`. */
export type TranscriptionRequestSettings = {
  serverUrl: string
  authToken: string
  model: string
  language: string
}

export type TranscriptionResult = {
  text: string
  durationSeconds: number | null
  backend: string | null
  model: string | null
  serverVersion: string | null
}

/** IPC result for `voice:transcribe`. Failures carry a user-facing message
 *  instead of rejecting, so the renderer renders the exact diagnostic text. */
export type VoiceTranscribeResponse =
  | { ok: true; result: TranscriptionResult }
  | { ok: false; message: string }

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
  if (trimmed.endsWith('/v1/transcriptions')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/transcriptions`
  return `${trimmed}/v1/transcriptions`
}

/** Headers for a Multivoice host transcription request. Matches the contract in
 *  multivoice-tauri's remote_transcription.rs (`transcription_headers`). */
export function buildTranscriptionHeaders(settings: TranscriptionRequestSettings): Record<string, string> {
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

/** POST a WAV recording to the configured Multivoice host and return the text.
 *  Runs in the main process, so it is exempt from renderer CORS/CSP. */
export async function transcribeAudio(
  wav: ArrayBuffer,
  settings: TranscriptionRequestSettings,
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
