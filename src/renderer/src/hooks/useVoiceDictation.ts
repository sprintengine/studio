import { useCallback, useEffect, useRef, useState } from 'react'

import { useWorkspaceStore } from '../store/workspaceStore'
import { publishDiagnosticSync } from '../utils/diagnostics'
import { pcmFloatToWav, transcribeAudio, TranscriptionError } from '../utils/voiceTranscription'

type RecordingContext = {
  stream: MediaStream
  audioContext: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  sampleRate: number
}

export type VoiceDictationController = {
  /** Mic is open and capturing. Drives the pulsing recording indicator. */
  recording: boolean
  /** A recording is being transcribed (mic already closed). */
  transcribing: boolean
  /** Start (if idle) or stop+transcribe (if recording). No-op while transcribing. */
  toggle: () => void
}

const MIN_RECORDING_SAMPLES = 1600 // ~0.1s of float frames before we bother sending

function notifyVoiceError(message: string): void {
  publishDiagnosticSync({
    level: 'error',
    source: 'voice',
    title: 'Voice dictation failed',
    message,
  })
}

/**
 * Microphone capture + Whisper transcription for the top-bar mic button.
 *
 * Captures raw PCM in the renderer via getUserMedia + Web Audio, encodes it to a
 * 16 kHz mono WAV on stop, POSTs it to the configured Multivoice host, and copies
 * the returned text to the clipboard (matching Multivoice's delivery model).
 */
export function useVoiceDictation(): VoiceDictationController {
  const settings = useWorkspaceStore((s) => s.appSettings.voiceDictation)
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const contextRef = useRef<RecordingContext | null>(null)
  // Keep the latest settings reachable from the async stop handler without
  // re-creating the toggle callback (which the global key handler depends on).
  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  const teardown = useCallback((ctx: RecordingContext) => {
    try {
      ctx.processor.disconnect()
      ctx.source.disconnect()
    } catch {
      /* nodes may already be detached */
    }
    void ctx.audioContext.close().catch(() => {})
    ctx.stream.getTracks().forEach((track) => track.stop())
  }, [])

  const start = useCallback(async () => {
    if (contextRef.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      notifyVoiceError(`Could not access the microphone. ${detail}`)
      return
    }

    const audioContext = new AudioContext()
    const source = audioContext.createMediaStreamSource(stream)
    const processor = audioContext.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    processor.onaudioprocess = (event) => {
      // Copy: the input buffer is reused by the audio thread after this returns.
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    source.connect(processor)
    processor.connect(audioContext.destination)
    contextRef.current = { stream, audioContext, source, processor, chunks, sampleRate: audioContext.sampleRate }
    setRecording(true)
  }, [])

  const stopAndTranscribe = useCallback(async () => {
    const ctx = contextRef.current
    if (!ctx) return
    contextRef.current = null
    setRecording(false)

    const { chunks, sampleRate } = ctx
    teardown(ctx)

    const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    if (totalSamples < MIN_RECORDING_SAMPLES) return // ignore an accidental tap

    const merged = new Float32Array(totalSamples)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }

    setTranscribing(true)
    try {
      const wav = pcmFloatToWav(merged, sampleRate)
      const result = await transcribeAudio(wav, settingsRef.current)
      await navigator.clipboard.writeText(result.text).catch(() => {
        notifyVoiceError('Transcribed text could not be copied to the clipboard.')
      })
      publishDiagnosticSync({
        level: 'info',
        source: 'voice',
        title: 'Transcription copied to clipboard',
        message: result.text.length > 160 ? `${result.text.slice(0, 157)}…` : result.text,
      })
    } catch (error) {
      const message =
        error instanceof TranscriptionError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Transcription failed.'
      notifyVoiceError(message)
    } finally {
      setTranscribing(false)
    }
  }, [teardown])

  const toggle = useCallback(() => {
    if (transcribing) return
    if (contextRef.current) {
      void stopAndTranscribe()
    } else {
      void start()
    }
  }, [transcribing, start, stopAndTranscribe])

  // Release the mic if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      const ctx = contextRef.current
      if (ctx) {
        contextRef.current = null
        teardown(ctx)
      }
    }
  }, [teardown])

  return { recording, transcribing, toggle }
}
