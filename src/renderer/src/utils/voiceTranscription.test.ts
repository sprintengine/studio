import assert from 'node:assert/strict'

import {
  buildTranscriptionHeaders,
  buildTranscriptionUrl,
  parseTranscriptionResponse,
  TranscriptionError,
} from '../../../shared/voiceTranscription'
import { downsampleFloat32, encodeWav, floatTo16BitPCM, TRANSCRIBE_TARGET_SAMPLE_RATE } from './voiceTranscription'
import type { VoiceDictationSettings } from '../types/workspace'
import { test } from 'vitest'

test('voiceTranscription', async () => {
  const baseSettings: VoiceDictationSettings = {
    serverUrl: 'http://127.0.0.1:48173',
    authToken: '',
    model: 'small',
    language: 'auto',
  }

  // buildTranscriptionUrl normalizes the base URL onto the host route.
  assert.equal(buildTranscriptionUrl('http://127.0.0.1:48173'), 'http://127.0.0.1:48173/v1/transcriptions')
  assert.equal(buildTranscriptionUrl('http://127.0.0.1:48173/'), 'http://127.0.0.1:48173/v1/transcriptions')
  assert.equal(buildTranscriptionUrl('https://host.example.com/v1'), 'https://host.example.com/v1/transcriptions')
  assert.equal(
    buildTranscriptionUrl('https://host.example.com/v1/transcriptions'),
    'https://host.example.com/v1/transcriptions',
  )
  assert.throws(() => buildTranscriptionUrl('   '), TranscriptionError)

  // Headers carry the model/language/backend contract; token only when present.
  const noTokenHeaders = buildTranscriptionHeaders(baseSettings)
  assert.equal(noTokenHeaders['Content-Type'], 'audio/wav')
  assert.equal(noTokenHeaders['x-multivoice-client'], 'multicode')
  assert.equal(noTokenHeaders['x-multivoice-backend'], 'whisper')
  assert.equal(noTokenHeaders['x-multivoice-model'], 'small')
  assert.equal(noTokenHeaders['x-multivoice-language'], 'auto')
  assert.equal(noTokenHeaders['Authorization'], undefined)

  const tokenHeaders = buildTranscriptionHeaders({ ...baseSettings, authToken: '  secret  ', language: 'en' })
  assert.equal(tokenHeaders['Authorization'], 'Bearer secret')
  assert.equal(tokenHeaders['x-multivoice-language'], 'en')

  // downsampleFloat32 halves a 32 kHz buffer to the 16 kHz target and is a no-op
  // when the input is already at/below the target rate.
  const tone = new Float32Array(320)
  for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin(i / 4)
  const downsampled = downsampleFloat32(tone, 32000)
  assert.equal(downsampled.length, 160)
  const alreadyLow = new Float32Array([0.1, -0.2, 0.3])
  assert.equal(downsampleFloat32(alreadyLow, TRANSCRIBE_TARGET_SAMPLE_RATE), alreadyLow)

  // floatTo16BitPCM clamps and scales into the int16 range.
  const pcm = floatTo16BitPCM(new Float32Array([0, 1, -1, 2, -2]))
  assert.equal(pcm[0], 0)
  assert.equal(pcm[1], 0x7fff)
  assert.equal(pcm[2], -0x8000)
  assert.equal(pcm[3], 0x7fff) // clamped
  assert.equal(pcm[4], -0x8000) // clamped

  // encodeWav produces a valid 44-byte header for mono 16-bit PCM.
  const wav = encodeWav(new Int16Array([1, -1, 100]), TRANSCRIBE_TARGET_SAMPLE_RATE)
  const view = new DataView(wav)
  assert.equal(wav.byteLength, 44 + 3 * 2)
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF')
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE')
  assert.equal(view.getUint16(22, true), 1) // mono
  assert.equal(view.getUint32(24, true), TRANSCRIBE_TARGET_SAMPLE_RATE)
  assert.equal(view.getUint16(34, true), 16) // bits per sample
  assert.equal(view.getInt16(44, true), 1)

  // parseTranscriptionResponse trims text and rejects empty/invalid payloads.
  const parsed = parseTranscriptionResponse({
    text: '  hello world  ',
    durationSeconds: 1.5,
    backend: 'whisper',
    model: 'small',
    serverVersion: '0.1.0',
  })
  assert.equal(parsed.text, 'hello world')
  assert.equal(parsed.durationSeconds, 1.5)
  assert.equal(parsed.backend, 'whisper')
  assert.throws(() => parseTranscriptionResponse({ text: '   ' }), TranscriptionError)
  assert.throws(() => parseTranscriptionResponse(null), TranscriptionError)

  console.log('voiceTranscription guard passed')
})
