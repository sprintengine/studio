// Text generation in the main process: the person's own agent CLI, headless,
// one shot, under the login it already holds. The first job is the chat
// title (the first consumer); commit messages and PR text are
// follow-ups on the same shape.
//
// What every call guarantees:
//   - no API key is read or forwarded — the Anthropic key/base-URL variables
//     are stripped so `claude` binds its own subscription login, exactly as
//     the conversation provider does;
//   - a fresh process, no session, no transcript, tools off, read-only;
//   - the CLI runs in a scratch directory, never the checkout, so no CLAUDE.md
//     or AGENTS.md rides along and nothing is read from the project;
//   - failure is a typed `{ ok: false }`, never a throw — the caller keeps
//     what it had.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CliDetectResult } from '../../shared/electron-api'
import {
  CHAT_TITLE_OUTPUT_SCHEMA,
  buildChatTitlePrompt,
  sanitizeGeneratedChatTitle,
} from '../../shared/text-generation/chat-title'
import {
  DEFAULT_TEXT_GENERATION_TIMEOUT_MS,
  type ChatTitleRequest,
  type TextGenerationCliRuntimeOverrides,
  type TextGenerationResult,
  supportsTextGeneration,
} from '../../shared/text-generation/contract'
import { detectAgentCliAvailability } from '../cli-availability'
import { defaultProbeEnv } from '../cli-runtime-install'
import { listPluginRegistryEntries } from '../plugin-registry-instance'
import { STRIPPED_ANTHROPIC_AUTH_ENV_KEYS } from '../providers/claude-agent-provider'
import {
  claudeChatTitleInvocation,
  codexChatTitleInvocation,
  readClaudeChatTitleStdout,
  readCodexChatTitleOutput,
  type ChatTitleInvocation,
} from './backends'
import { runCommand, type RunCommand } from './run-command'

export type TextGenerationServiceDeps = {
  detect?: (cli: string, runtime?: { command?: string; useWsl?: boolean }) => Promise<CliDetectResult>
  run?: RunCommand
  env?: () => Record<string, string>
  /** Where scratch directories are made. Defaults to the OS temp dir. */
  scratchRoot?: string
  now?: () => number
}

const SCRATCH_PREFIX = 'sprintengine-text-'

export async function generateChatTitle(
  request: ChatTitleRequest,
  deps: TextGenerationServiceDeps = {},
): Promise<TextGenerationResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const { engine } = request
  if (!supportsTextGeneration(engine.cli)) {
    return { ok: false, code: 'unsupported', message: `${engine.cli} has no text generation backend.` }
  }
  const model = engine.model.trim()
  if (!model) return { ok: false, code: 'unsupported', message: 'No model was chosen for text generation.' }

  const binaryPath = await resolveBinary(engine.cli, request.cliRuntimes, deps.detect ?? cachedDetect)
  if (!binaryPath.ok) return binaryPath

  const scratch = await mkdtemp(path.join(deps.scratchRoot ?? tmpdir(), SCRATCH_PREFIX))
  try {
    const schemaJson = JSON.stringify(CHAT_TITLE_OUTPUT_SCHEMA)
    const prompt = buildChatTitlePrompt(request.prompt)
    const timeoutMs = request.timeoutMs ?? DEFAULT_TEXT_GENERATION_TIMEOUT_MS
    const env = engineEnv(engine.cli, deps.env)
    const run = deps.run ?? runCommand

    const backend = await prepareBackend(engine.cli, {
      binaryPath: binaryPath.path,
      model,
      reasoning: engine.reasoning,
      schemaJson,
      scratch,
    })
    const outcome = await run({ ...backend.invocation, cwd: scratch, env, stdin: prompt, timeoutMs })
    const failure = runFailure(engine.cli, outcome)
    if (failure) return failure
    return guard(await backend.readAnswer(outcome.stdout), engine.cli, now() - startedAt)
  } catch (error) {
    return { ok: false, code: 'transport', message: describe(error) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

type PreparedBackend = {
  invocation: ChatTitleInvocation
  readAnswer: (stdout: string) => Promise<string | null>
}

// Each backend's answer lives somewhere different — Claude's on stdout, Codex's
// in a file it is told to write — so the recipe and its reader are prepared
// together, and the run itself is one line above.
async function prepareBackend(
  cli: string,
  input: { binaryPath: string; model: string; reasoning: string | undefined; schemaJson: string; scratch: string },
): Promise<PreparedBackend> {
  if (cli === 'codex') {
    const schemaPath = path.join(input.scratch, 'schema.json')
    const outputPath = path.join(input.scratch, 'last-message.txt')
    await writeFile(schemaPath, input.schemaJson, 'utf8')
    await writeFile(outputPath, '', 'utf8')
    return {
      invocation: codexChatTitleInvocation({ ...input, schemaPath, outputPath }),
      readAnswer: async () => readCodexChatTitleOutput(await readFile(outputPath, 'utf8')),
    }
  }
  return {
    invocation: claudeChatTitleInvocation(input),
    readAnswer: async (stdout) => readClaudeChatTitleStdout(stdout),
  }
}

// Detection through the same 60 s cache the launch pre-flight uses, so a
// title never pays for a fresh login-shell probe when a spawn moments ago
// already answered. Errored probes are absent from the map, which reads here
// as "could not be probed" — never as "not installed".
async function cachedDetect(cli: string, runtime?: { command?: string; useWsl?: boolean }): Promise<CliDetectResult> {
  const base = {
    cli,
    binary: runtime?.command?.trim() || cli,
    version: null,
    resolvedPath: null,
    useWsl: runtime?.useWsl ?? false,
  }
  const entry = listPluginRegistryEntries().find((candidate) => candidate.id === cli)
  if (!entry) return { ...base, installed: false, error: `No plugin manifest found for "${cli}".` }
  const availability = await detectAgentCliAvailability(
    { cliRuntimes: runtime ? { [cli]: runtime } : undefined },
    { listEntries: () => [entry] },
  )
  const detected = availability[cli]
  if (!detected)
    return {
      ...base,
      binary: base.binary === cli ? entry.binary : base.binary,
      installed: false,
      error: 'the availability probe failed',
    }
  return {
    ...base,
    binary: base.binary === cli ? entry.binary : base.binary,
    installed: detected.installed,
    version: detected.version,
    resolvedPath: detected.resolvedPath,
    error: null,
  }
}

async function resolveBinary(
  cli: string,
  cliRuntimes: TextGenerationCliRuntimeOverrides | undefined,
  detect: NonNullable<TextGenerationServiceDeps['detect']>,
): Promise<{ ok: true; path: string } | Extract<TextGenerationResult, { ok: false }>> {
  const detection = await detect(cli, cliRuntimes?.[cli])
  if (detection.error !== null) {
    return { ok: false, code: 'unavailable', message: `${cli} could not be probed: ${detection.error}` }
  }
  if (!detection.installed) {
    return { ok: false, code: 'unavailable', message: `${cli} is not installed on this machine.` }
  }
  // The probe's absolute path is what the launch path executes too: it came
  // from the person's interactive shell, which is where a ~/.zshrc-only PATH
  // entry lives. A bare name is the last resort.
  const resolved = detection.resolvedPath?.trim()
  return { ok: true, path: resolved && path.isAbsolute(resolved) ? resolved : detection.binary }
}

// The launch PATH (managed runtime shims, the Studio CLI bin dir), minus the
// variables that would swing `claude` from its subscription login onto API
// billing or a third-party endpoint, plus thinking switched off. `--effort
// low` alone still lets `claude` spend ~1,700 thinking tokens on a title
// (measured 2026-09-08, claude 2.1.265: 10-23 s per call); with
// `MAX_THINKING_TOKENS=0` the same call answers in ~3 s with the same title.
// A title is a lookup, not a reasoning task. Codex has no such split; it
// inherits the same PATH untouched.
function engineEnv(cli: string, readEnv: (() => Record<string, string>) | undefined): Record<string, string> {
  const base = readEnv ? readEnv() : stringEnv(defaultProbeEnv())
  if (cli !== 'claude-code') return base
  const next = { ...base }
  for (const key of STRIPPED_ANTHROPIC_AUTH_ENV_KEYS) delete next[key]
  next.MAX_THINKING_TOKENS = '0'
  return next
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function runFailure(
  cli: string,
  outcome: Awaited<ReturnType<RunCommand>>,
): Extract<TextGenerationResult, { ok: false }> | null {
  if (outcome.spawnError) {
    return { ok: false, code: 'unavailable', message: `${cli} could not be started: ${outcome.spawnError}` }
  }
  if (outcome.timedOut) return { ok: false, code: 'timeout', message: `${cli} did not answer in time.` }
  if (outcome.code !== 0) {
    const detail = outcome.stderr.trim() || outcome.stdout.trim()
    return {
      ok: false,
      code: 'transport',
      message: detail ? `${cli} exited ${outcome.code}: ${failureReason(detail)}` : `${cli} exited ${outcome.code}.`,
    }
  }
  return null
}

// The one line of a failed run worth keeping. Usually the last line, but
// `codex exec` prints a refused API request as `ERROR:` followed by the
// response body pretty-printed over several lines — the last line of that is
// a lone `}` — so the body's own message is read out instead. A refused model
// or effort level then names itself in the diagnostics log.
function failureReason(detail: string): string {
  const marker = detail.lastIndexOf('ERROR:')
  if (marker !== -1) {
    const reason = apiErrorMessage(detail.slice(marker + 'ERROR:'.length).trim())
    if (reason) return reason
  }
  return lastLine(detail)
}

function apiErrorMessage(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { error, message } = parsed as { error?: unknown; message?: unknown }
  const nested = error && typeof error === 'object' ? (error as { message?: unknown }).message : undefined
  const reason = typeof nested === 'string' ? nested : typeof message === 'string' ? message : null
  return reason?.trim() || null
}

function guard(raw: string | null, cli: string, ms: number): TextGenerationResult {
  const title = sanitizeGeneratedChatTitle(raw)
  if (!title) return { ok: false, code: 'guardrail', message: `${cli} returned no usable title.` }
  return { ok: true, value: title, ms }
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines[lines.length - 1] ?? text
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
