import { useWorkspaceStore } from '../../store/workspaceStore'
import { publishDiagnosticSync } from '../../utils/diagnostics'
import { pcmFloatToWav } from '../../utils/voiceTranscription'

// Microphone capture + Whisper transcription behind the module's top-bar mic
// button and its `voice-dictation.toggle` command. A renderer-wide singleton
// (external store, not a hook) so the command can fire without the button
// mounted and both surfaces observe the same recording session. Reached only
// through lazy/dynamic imports from voice-dictation-module.ts — a static
// import there would drag the workspace store into the eager module-registry
// graph (the bundle-budget discipline the other modules follow).
//
// Captures raw PCM via getUserMedia + Web Audio, encodes a 16 kHz mono WAV on
// stop, POSTs it to the configured Multivoice host, and copies the returned
// text to the clipboard (matching Multivoice's delivery model).

type RecordingContext = {
  stream: MediaStream
  audioContext: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  chunks: Float32Array[]
  sampleRate: number
}

export type VoiceDictationSnapshot = {
  /** Mic is open and capturing. Drives the pulsing recording indicator. */
  recording: boolean
  /** A recording is being transcribed (mic already closed). */
  transcribing: boolean
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

let context: RecordingContext | null = null
let snapshot: VoiceDictationSnapshot = { recording: false, transcribing: false }
const listeners = new Set<() => void>()

function setSnapshot(update: Partial<VoiceDictationSnapshot>): void {
  snapshot = { ...snapshot, ...update }
  for (const listener of listeners) listener()
}

function teardown(ctx: RecordingContext): void {
  try {
    ctx.processor.disconnect()
    ctx.source.disconnect()
  } catch {
    /* nodes may already be detached */
  }
  void ctx.audioContext.close().catch(() => {})
  ctx.stream.getTracks().forEach((track) => track.stop())
}

async function start(): Promise<void> {
  if (context) return
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
  context = { stream, audioContext, source, processor, chunks, sampleRate: audioContext.sampleRate }
  setSnapshot({ recording: true })
}

async function stopAndTranscribe(): Promise<void> {
  const ctx = context
  if (!ctx) return
  context = null
  setSnapshot({ recording: false })

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

  setSnapshot({ transcribing: true })
  try {
    const wav = pcmFloatToWav(merged, sampleRate)
    // The transcription POST runs in the main process: the Multivoice host
    // sends no CORS headers, so a renderer fetch is blocked by the preflight.
    const settings = useWorkspaceStore.getState().appSettings.voiceDictation
    const response = await window.api.voiceTranscribe(wav, settings)
    if (!response.ok) {
      notifyVoiceError(response.message)
      return
    }
    const { text } = response.result
    await window.api.clipboardWriteText(text).catch(() => {
      notifyVoiceError('Transcribed text could not be copied to the clipboard.')
    })
    publishDiagnosticSync({
      level: 'info',
      source: 'voice',
      title: 'Transcription copied to clipboard',
      message: text.length > 160 ? `${text.slice(0, 157)}…` : text,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.'
    notifyVoiceError(message)
  } finally {
    setSnapshot({ transcribing: false })
  }
}

export const voiceDictationController = {
  getSnapshot(): VoiceDictationSnapshot {
    return snapshot
  },
  /** Fires on every recording/transcribing change; returns the unsubscriber. */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  /** Start (if idle) or stop+transcribe (if recording). No-op while transcribing. */
  toggle(): void {
    if (snapshot.transcribing) return
    if (context) {
      void stopAndTranscribe()
    } else {
      void start()
    }
  },
  /**
   * Release the mic and discard the take without transcribing — the mic
   * button's unmount path, so disabling the module mid-recording never leaves
   * the microphone open with no visible indicator.
   */
  abort(): void {
    const ctx = context
    if (!ctx) return
    context = null
    teardown(ctx)
    setSnapshot({ recording: false })
  },
}
