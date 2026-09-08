import type {
  AgentCli,
  CliRuntimeSettings,
  TerminalSpawnMetadata,
  TerminalSpawnResult,
} from '../../../../../shared/electron-api'
import { DESIGN_SYSTEM_MANIFEST_FILENAME } from '../../../../../shared/design-system/manifest'
import type { DesignSystemSeedSource } from '../../../types/workspace'
import {
  buildGuidedBriefSpecialistStartupPrompt,
  type GuidedBriefInterviewProtocol,
  type GuidedBriefSpecialistKind,
} from '../../../specialists/specialistActions'
import { stripAnsiAndOverwrites } from './parseStream'
import {
  createGuidedInterviewParser,
  type GuidedInterviewState,
} from './interviewProtocol'
import { GUIDED_BRIEF_AGENT_LABELS } from './agentLabels'

export type { GuidedBriefSpecialistKind }

export const GUIDED_BRIEF_SPECIALIST_MARKERS: Record<GuidedBriefSpecialistKind, string> = {
  strategist: 'BRIEF_READY',
  architect: 'ARCHITECTURE_PLAN_READY',
  designer: 'MOCKUP_SET_READY',
}

// A designer session authoring a design-system bundle (the design-system
// preset) signals readiness with its own marker — the bundle, not a mockup
// set, is the artifact.
export const GUIDED_BRIEF_DESIGN_SYSTEM_MARKER = 'DESIGN_SYSTEM_READY'

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
  terminalKill: (sessionId: string) => Promise<void>
  onTerminalReplay: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalData: (sessionId: string, cb: (data: string) => void) => () => void
  onTerminalExit: (sessionId: string, cb: (code: number) => void) => () => void
  onTerminalError: (sessionId: string, cb: (message: string) => void) => () => void
}

export type GuidedBriefStrategistSessionInput = {
  kind: 'strategist'
  workspaceRoot: string
  // Owning workspace, threaded into the PTY spawn metadata so the session
  // manager inventories the session (getSessionItems drops terminal sessions
  // without a workspaceId).
  workspaceId?: string
  sessionId?: string
  cli?: AgentCli
  cliModel?: string
  cols?: number
  rows?: number
  ideaSeedPath?: string
  requirementsPath?: string
}

export type GuidedBriefDesignerSessionInput = {
  kind: 'designer'
  workspaceRoot: string
  // See GuidedBriefStrategistSessionInput.workspaceId.
  workspaceId?: string
  acceptedBriefSnapshotPath?: string
  acceptedArchitecturePlanPath?: string | null
  sessionId?: string
  cli?: AgentCli
  cliModel?: string
  cols?: number
  rows?: number
  inspirationDirectoryPath?: string
  uiDirectionPath?: string
  mockupPath?: string
  // An attached design-system bundle exists at `design-system/` in the
  // workspace: the mockup designer's prompt gains the conform line. Never set
  // alongside `designSystem` (the authoring studio owns that directory).
  designSystemAttached?: boolean
  // Design-system preset: the same shared designer session (terminalSpawn
  // path, bypass preset) under a dedicated role prompt that authors the
  // portable bundle instead of mockups. `seedSource` is present when the
  // studio was started as "seed from an existing product" and makes the
  // prompt's opening move the reviewed extraction of that source.
  designSystem?: {
    bundleDirectoryPath: string
    ideaSeedPath: string
    seedSource?: DesignSystemSeedSource
  }
}

export type GuidedBriefArchitectSessionInput = {
  kind: 'architect'
  workspaceRoot: string
  // See GuidedBriefStrategistSessionInput.workspaceId.
  workspaceId?: string
  acceptedBriefSnapshotPath?: string | null
  sessionId?: string
  cli?: AgentCli
  cliModel?: string
  cols?: number
  rows?: number
  ideaSeedPath?: string
  architecturePlanPath?: string
}

export type StartGuidedBriefSpecialistSessionInput =
  | GuidedBriefStrategistSessionInput
  | GuidedBriefArchitectSessionInput
  | GuidedBriefDesignerSessionInput

export type StartGuidedBriefSpecialistSessionOptions = {
  terminalApi: GuidedBriefTerminalApi
  cliRuntimes?: Partial<Record<AgentCli, Partial<CliRuntimeSettings>>>
  onOutput?: (chunk: GuidedBriefSessionOutputChunk) => void
  onLifecycle?: (state: GuidedBriefSessionLifecycle) => void
  onMarker?: (marker: string) => void
  onError?: (message: string) => void
  /**
   * Structured-interview state parsed from the same stdout stream (replay
   * included, so it rebuilds across renderer reloads). Fired after every
   * chunk whose parse changed the current question or decisions.
   */
  onInterview?: (state: GuidedInterviewState) => void
  /**
   * Install the curated frontend-design skill into the workspace's Claude skill
   * dir before the session starts. Called only when guidedBriefUsesDesignSkill
   * holds (Claude designer sessions); best-effort — a failure degrades craft
   * quality but never blocks the session.
   */
  ensureDesignSkillInstalled?: () => Promise<void>
}

export type GuidedBriefSpecialistSession = {
  sessionId: string
  kind: GuidedBriefSpecialistKind
  markerDetection: GuidedBriefMarkerDetection
  rawTerminal: GuidedBriefRawTerminalTarget
  prompt: string
  stop: () => Promise<void>
  dispose: () => void
  // How the session runs: a PTY the raw terminal binds to, or a conversation
  // session (Claude Agent SDK) rendered as streamed chat + question cards.
  transport: 'terminal' | 'conversation'
  // Conversation transport only: answer the current pending interview
  // question (structured respond, not keystrokes). Resolves false when no
  // question is pending.
  answer?: (text: string) => Promise<boolean>
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

// Hooks need to mint and persist a sessionId synchronously *before* calling
// terminalSpawn so a renderer refresh mid-spawn does not orphan the PTY. The
// adapter still falls back to its own generator when no sessionId is passed.
export function createGuidedBriefSessionId(): string {
  return createSessionId()
}

// Built-in skill id for the curated design-craft guidance. The wizard installs
// it into .claude/skills/ before a Claude designer session starts and names it
// in the startup prompt; see guidedBriefUsesDesignSkill.
export const GUIDED_BRIEF_DESIGN_SKILL_ID = 'frontend-design'

// Claude Code's CLI id. Conversation transport is Claude-only by construction;
// the PTY transport runs whatever CLI the user picked, so the design skill is
// gated on this id there.
const CLAUDE_CODE_CLI = 'claude-code'

// The frontend-design skill ships to the designer specialists (mockup +
// design-system authoring) running on Claude Code only. Conversation sessions
// are always Claude; PTY sessions must match the Claude CLI id. Other roles and
// other CLIs get no install and no activation line.
export function guidedBriefUsesDesignSkill(
  input: StartGuidedBriefSpecialistSessionInput,
  transport: 'terminal' | 'conversation',
): boolean {
  if (input.kind !== 'designer') return false
  return transport === 'conversation' || input.cli === CLAUDE_CODE_CLI
}

export function promptForInput(
  input: StartGuidedBriefSpecialistSessionInput,
  marker: string,
  interviewProtocol: GuidedBriefInterviewProtocol = 'terminal-markers',
  designSkillActivation = false,
): string {
  if (input.kind === 'strategist') {
    return buildGuidedBriefSpecialistStartupPrompt({
      kind: 'strategist',
      ideaSeedPath: input.ideaSeedPath,
      requirementsPath: input.requirementsPath,
      marker,
      interviewProtocol,
    })
  }

  if (input.kind === 'architect') {
    return buildGuidedBriefSpecialistStartupPrompt({
      kind: 'architect',
      ideaSeedPath: input.ideaSeedPath,
      acceptedBriefSnapshotPath: input.acceptedBriefSnapshotPath,
      architecturePlanPath: input.architecturePlanPath,
      marker,
      interviewProtocol,
    })
  }

  return buildGuidedBriefSpecialistStartupPrompt({
    kind: 'designer',
    acceptedBriefSnapshotPath: input.acceptedBriefSnapshotPath,
    acceptedArchitecturePlanPath: input.acceptedArchitecturePlanPath,
    inspirationDirectoryPath: input.inspirationDirectoryPath,
    uiDirectionPath: input.uiDirectionPath,
    mockupPath: input.mockupPath,
    designSkillActivation,
    designSystemAttached: input.designSystemAttached,
    designSystem: input.designSystem,
    marker,
    interviewProtocol,
  })
}

// Stable per-specialist agent id, shared by BOTH transports: the conversation
// transcript's resume cursor and the PTY spawn metadata key off the same id,
// so the session manager never shows the same specialist under two identities.
export function guidedBriefSpecialistAgentId(
  input: Pick<GuidedBriefDesignerSessionInput, 'kind' | 'designSystem'> | { kind: Exclude<GuidedBriefSpecialistKind, 'designer'> },
): string {
  if (input.kind === 'designer' && input.designSystem) return 'guided-brief-design-system'
  return `guided-brief-${input.kind}`
}

// Human session-manager labels for wizard specialists, keyed by the agent id
// above. Wizard agents are never registered in workspace.agents, so both
// transports label their session rows from this one map.
// The label map moved to `agentLabels.ts` so the sidebar's row naming can read
// it without this adapter — the terminal wiring, the marker parser and the
// interview protocol behind it — riding into the eager boot chunk
// (bundle-budget ratchet). Re-exported here because this is the module the
// four ids belong to.
export { GUIDED_BRIEF_AGENT_LABELS } from './agentLabels'

export function markerForInput(input: StartGuidedBriefSpecialistSessionInput): string {
  if (input.kind === 'designer' && input.designSystem) return GUIDED_BRIEF_DESIGN_SYSTEM_MARKER
  return GUIDED_BRIEF_SPECIALIST_MARKERS[input.kind]
}

export function markerDetectionForInput(input: StartGuidedBriefSpecialistSessionInput, marker: string): GuidedBriefMarkerDetection {
  if (input.kind === 'strategist') {
    const artifactPath = input.requirementsPath ?? 'product/requirements.md'
    return {
      marker,
      artifactPath,
      watchPath: artifactPath,
    }
  }

  if (input.kind === 'architect') {
    const artifactPath = input.architecturePlanPath ?? 'architecture/plan.md'
    return {
      marker,
      artifactPath,
      watchPath: artifactPath,
    }
  }

  if (input.designSystem) {
    return {
      marker,
      artifactPath: `${input.designSystem.bundleDirectoryPath}/${DESIGN_SYSTEM_MANIFEST_FILENAME}`,
      watchPath: input.designSystem.bundleDirectoryPath,
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
// design-tokens-allow: matches chrome a CLI printed, not a glyph the product draws
const PROMPT_CHROME = /^[\s>│●⏺•*»]+|[\s>│●⏺•*»]+$/gu

// Cheap structural equality so React state only updates when the parsed
// interview actually changed — every PTY chunk re-parses the buffer.
function interviewStateChanged(a: GuidedInterviewState, b: GuidedInterviewState): boolean {
  if (a.malformedCount !== b.malformedCount) return true
  if ((a.currentQuestion?.id ?? null) !== (b.currentQuestion?.id ?? null)) return true
  if (a.decisions.length !== b.decisions.length) return true
  for (let index = 0; index < a.decisions.length; index += 1) {
    const left = a.decisions[index]
    const right = b.decisions[index]
    if (left.id !== right.id || left.label !== right.label) return true
  }
  return false
}

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
  const marker = markerForInput(input)
  const usesDesignSkill = guidedBriefUsesDesignSkill(input, 'terminal')
  const prompt = promptForInput(input, marker, 'terminal-markers', usesDesignSkill)
  const markerDetection = markerDetectionForInput(input, marker)
  const agentId = guidedBriefSpecialistAgentId(input)
  const agentName = GUIDED_BRIEF_AGENT_LABELS[agentId]
  const disposers: Array<() => void> = []
  let outputBuffer = ''
  let markerEmitted = false
  const interviewParser = createGuidedInterviewParser()
  let lastInterviewState = interviewParser.state()

  const dispose = () => {
    while (disposers.length > 0) {
      disposers.pop()?.()
    }
  }

  const handleOutput = (chunk: string) => {
    outputBuffer = `${outputBuffer}${chunk}`.slice(-marker.length - 4096)
    options.onOutput?.({ stream: 'stdout', chunk, at: Date.now() })
    if (options.onInterview) {
      const nextInterviewState = interviewParser.push(chunk)
      if (nextInterviewState !== lastInterviewState && interviewStateChanged(lastInterviewState, nextInterviewState)) {
        lastInterviewState = nextInterviewState
        options.onInterview(nextInterviewState)
      } else {
        lastInterviewState = nextInterviewState
      }
    }
    if (!markerEmitted && containsGuidedBriefMarker(outputBuffer, marker)) {
      markerEmitted = true
      options.onLifecycle?.('ready')
      options.onMarker?.(marker)
    }
  }

  disposers.push(options.terminalApi.onTerminalReplay(sessionId, handleOutput))
  disposers.push(options.terminalApi.onTerminalData(sessionId, handleOutput))
  disposers.push(options.terminalApi.onTerminalExit(sessionId, () => {
    options.onLifecycle?.(markerEmitted ? 'ready' : 'exited')
  }))
  disposers.push(options.terminalApi.onTerminalError(sessionId, (message) => {
    options.onLifecycle?.('error')
    options.onError?.(message)
  }))

  if (!input.cli) {
    dispose()
    const message = 'Design Wizard specialist session is missing its CLI selection.'
    options.onLifecycle?.('error')
    options.onError?.(message)
    return { ok: false, sessionId, message }
  }

  options.onLifecycle?.('starting')
  // Install the design skill before spawn so Claude Code discovers it in
  // .claude/skills/ at startup. Best-effort: the activation line is already in
  // the prompt, and a missing skill degrades craft, it never breaks the run.
  if (usesDesignSkill && options.ensureDesignSkillInstalled) {
    await options.ensureDesignSkillInstalled().catch((error) => {
      console.warn('[guided-brief] frontend-design skill install failed', error)
    })
  }
  const spawnResult = await options.terminalApi.terminalSpawn(
    sessionId,
    input.cols ?? 100,
    input.rows ?? 30,
    input.workspaceRoot,
    false,
    undefined,
    input.cli,
    prompt,
    options.cliRuntimes,
    false,
    {
      kind: 'agent',
      agentId,
      // Inventory identity: the session manager only lists terminal sessions
      // whose snapshot carries a workspaceId, and labels agent rows without a
      // workspace.agents record from agentName.
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(agentName ? { agentName } : {}),
      // All guided-brief specialists run unattended in a workspace the user is
      // actively watching — they read project files, search the web, and write a
      // couple of artifacts. Without bypass they stall on per-tool permission
      // prompts (and never reach the structured-interview output). Apply the same
      // preset to every specialist, not just the designer.
      cliPermissionPreset: 'bypass' as const,
      ...(input.cliModel ? { cliModel: input.cliModel } : {}),
      visible: true,
    },
  ).catch((error): TerminalSpawnResult => ({
    ok: false,
    sessionId,
    message: error instanceof Error ? error.message : 'Failed to start Design Wizard specialist session.',
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
        label: input.kind === 'strategist'
          ? 'Product Strategist terminal'
          : input.kind === 'architect'
            ? 'Architect terminal'
            : input.designSystem
              ? 'Design System Designer terminal'
              : 'Frontend Designer terminal',
      },
      prompt,
      stop: () => options.terminalApi.terminalKill(sessionId),
      dispose,
      transport: 'terminal',
    },
  }
}
