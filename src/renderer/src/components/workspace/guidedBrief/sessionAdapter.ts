import type {
  AgentCli,
  CliRuntimeSettings,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
} from '../../../../../shared/electron-api'
import {
  buildGuidedBriefSpecialistStartupPrompt,
  type GuidedBriefSpecialistKind,
} from '../../../specialists/specialistActions'
import { stripAnsiAndOverwrites } from './parseStream'

export type { GuidedBriefSpecialistKind }

export const GUIDED_BRIEF_SPECIALIST_MARKERS: Record<GuidedBriefSpecialistKind, string> = {
  strategist: 'BRIEF_READY',
  designer: 'MOCKUP_SET_READY',
}

export type GuidedBriefSessionLifecycle =
  | 'starting'
  | 'running'
  | 'ready'
  | 'exited'
  | 'error'

export type GuidedBriefSessionOutputChunk = {
  stream: 'stdout'
  chunk: string
  at: number
}

export type GuidedBriefMarkerDetection = {
  marker: string
  artifactPath: string
  watchPath: string
}

export type GuidedBriefRawTerminalTarget = {
  sessionId: string
  cwd: string
  label: string
}

export type GuidedBriefTerminalApi = {
  terminalSpawn: (
    sessionId: string,
    cols: number,
    rows: number,
    cwd?: string,
    resume?: boolean,
    sprintEngineStatePath?: string,
    cli?: AgentCli,
    initialPrompt?: string,
    cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>,
    shellOnly?: boolean,
    metadata?: TerminalSpawnMetadata,
  ) => Promise<TerminalSpawnResult>
  terminalWrite: (sessionId: string, data: string) => Promise<void>
  terminalWriteFast: (sessionId: string, data: string) => void
  terminalKill: (sessionId: string) => Promise<void>
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
}

export type GuidedBriefStrategistSessionInput = {
  kind: 'strategist'
  workspaceRoot: string
  sessionId?: string
  cli?: AgentCli
  cols?: number
  rows?: number
  ideaSeedPath?: string
  requirementsPath?: string
}

export type GuidedBriefDesignerSessionInput = {
  kind: 'designer'
  workspaceRoot: string
  acceptedBriefSnapshotPath: string
  sessionId?: string
  cli?: AgentCli
  cols?: number
  rows?: number
  inspirationDirectoryPath?: string
  uiDirectionPath?: string
  mockupPath?: string
}

export type StartGuidedBriefSpecialistSessionInput =
  | GuidedBriefStrategistSessionInput
  | GuidedBriefDesignerSessionInput

export type StartGuidedBriefSpecialistSessionOptions = {
  terminalApi: GuidedBriefTerminalApi
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  onOutput?: (chunk: GuidedBriefSessionOutputChunk) => void
  onLifecycle?: (state: GuidedBriefSessionLifecycle) => void
  onMarker?: (marker: string) => void
  onError?: (message: string) => void
}

export type GuidedBriefSpecialistSession = {
  sessionId: string
  kind: GuidedBriefSpecialistKind
  markerDetection: GuidedBriefMarkerDetection
  rawTerminal: GuidedBriefRawTerminalTarget
  prompt: string
  sendMessage: (message: string) => Promise<void>
  writeRaw: (data: string) => void
  stop: () => Promise<void>
  dispose: () => void
}

export type StartGuidedBriefSpecialistSessionResult =
  | { ok: true; session: GuidedBriefSpecialistSession }
  | { ok: false; sessionId: string; message: string }

function createUuidV4(): string {
  const nativeUuid = globalThis.crypto?.randomUUID?.()
  if (nativeUuid) return nativeUuid

  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

function createSessionId(): string {
  return createUuidV4()
}

function bracketedTerminalPaste(text: string): string {
  return `\x1b[200~${text.replace(/\r?\n/g, '\n')}\x1b[201~\r`
}

function promptForInput(input: StartGuidedBriefSpecialistSessionInput, marker: string): string {
  if (input.kind === 'strategist') {
    return buildGuidedBriefSpecialistStartupPrompt({
      kind: 'strategist',
      ideaSeedPath: input.ideaSeedPath,
      requirementsPath: input.requirementsPath,
      marker,
    })
  }

  return buildGuidedBriefSpecialistStartupPrompt({
    kind: 'designer',
    acceptedBriefSnapshotPath: input.acceptedBriefSnapshotPath,
    inspirationDirectoryPath: input.inspirationDirectoryPath,
    uiDirectionPath: input.uiDirectionPath,
    mockupPath: input.mockupPath,
    marker,
  })
}

function markerDetectionForInput(input: StartGuidedBriefSpecialistSessionInput, marker: string): GuidedBriefMarkerDetection {
  if (input.kind === 'strategist') {
    const artifactPath = input.requirementsPath ?? 'product/requirements.md'
    return {
      marker,
      artifactPath,
      watchPath: artifactPath,
    }
  }

  const artifactPath = input.mockupPath ?? 'mockups/app.html'
  return {
    marker,
    artifactPath,
    watchPath: 'mockups',
  }
}

// Strip ANSI/control codes and trim leading/trailing CLI prompt chrome so the
// marker still matches when wrapped by tools like Claude Code (`⏺ MARKER`) or
// Codex (`│ MARKER │`). The marker must still appear alone on its own line —
// the regex only removes whitespace and a small allowlist of prompt glyphs.
const PROMPT_CHROME = /^[\s>│●⏺•*»]+|[\s>│●⏺•*»]+$/gu

export function containsGuidedBriefMarker(output: string, marker: string): boolean {
  return stripAnsiAndOverwrites(output)
    .split(/\r?\n/)
    .some((line) => line.replace(PROMPT_CHROME, '') === marker)
}

export async function startGuidedBriefSpecialistSession(
  input: StartGuidedBriefSpecialistSessionInput,
  options: StartGuidedBriefSpecialistSessionOptions,
): Promise<StartGuidedBriefSpecialistSessionResult> {
  const sessionId = input.sessionId ?? createSessionId()
  const marker = GUIDED_BRIEF_SPECIALIST_MARKERS[input.kind]
  const prompt = promptForInput(input, marker)
  const markerDetection = markerDetectionForInput(input, marker)
  const disposers: Array<() => void> = []
  let outputBuffer = ''
  let markerEmitted = false

  const dispose = () => {
    while (disposers.length > 0) {
      disposers.pop()?.()
    }
  }

  disposers.push(options.terminalApi.onTerminalData(sessionId, (chunk) => {
    outputBuffer = `${outputBuffer}${chunk}`.slice(-marker.length - 4096)
    options.onOutput?.({ stream: 'stdout', chunk, at: Date.now() })
    if (!markerEmitted && containsGuidedBriefMarker(outputBuffer, marker)) {
      markerEmitted = true
      options.onLifecycle?.('ready')
      options.onMarker?.(marker)
    }
  }))
  disposers.push(options.terminalApi.onTerminalExit(sessionId, () => {
    options.onLifecycle?.(markerEmitted ? 'ready' : 'exited')
  }))
  disposers.push(options.terminalApi.onTerminalError(sessionId, (message) => {
    options.onLifecycle?.('error')
    options.onError?.(message)
  }))

  options.onLifecycle?.('starting')
  const spawnResult = await options.terminalApi.terminalSpawn(
    sessionId,
    input.cols ?? 100,
    input.rows ?? 30,
    input.workspaceRoot,
    false,
    undefined,
    input.cli ?? 'codex',
    prompt,
    options.cliRuntimes,
    false,
    {
      kind: 'agent',
      agentId: `guided-brief-${input.kind}`,
      visible: true,
    },
  ).catch((error): TerminalSpawnResult => ({
    ok: false,
    sessionId,
    message: error instanceof Error ? error.message : 'Failed to start Guided brief specialist session.',
    exitCode: 1,
  }))

  if (!spawnResult.ok) {
    dispose()
    options.onLifecycle?.('error')
    options.onError?.(spawnResult.message)
    return { ok: false, sessionId, message: spawnResult.message }
  }

  options.onLifecycle?.('running')
  return {
    ok: true,
    session: {
      sessionId,
      kind: input.kind,
      markerDetection,
      rawTerminal: {
        sessionId,
        cwd: input.workspaceRoot,
        label: input.kind === 'strategist' ? 'Product Strategist terminal' : 'Frontend Designer terminal',
      },
      prompt,
      sendMessage: (message) => options.terminalApi.terminalWrite(sessionId, bracketedTerminalPaste(message)),
      writeRaw: (data) => options.terminalApi.terminalWriteFast(sessionId, data),
      stop: () => options.terminalApi.terminalKill(sessionId),
      dispose,
    },
  }
}
