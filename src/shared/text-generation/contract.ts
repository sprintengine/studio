/**
 * The text-generation contract: what a caller asks for, what comes back, and
 * which agent CLIs can answer at all.
 *
 * The premise (MC-2423, MC-2484): the person's own installed agent CLI,
 * headless, one shot, structured output, under the subscription the CLI is
 * already logged into. No API key is read or sent anywhere on this path.
 *
 * Pure: no I/O, no Electron. Shared by main (the service), preload (the
 * bridge) and the renderer (the settings row and the title requester).
 */

/** Which CLI runs the job, on which model, at which effort. */
export type TextGenerationEngine = {
  cli: string
  model: string
  /** Absent means the backend's own cheap default, not the CLI's default. */
  reasoning?: string
}

/**
 * What a generation call can fail with. Every code is a reason to keep what
 * the caller already had, never a reason to show an error: a title that does
 * not arrive is the heuristic title, silently (MC-2484 rule of record).
 */
type TextGenerationFailureCode =
  | 'unsupported' // no backend for this CLI
  | 'unavailable' // the CLI is not installed, or could not be probed
  | 'timeout'
  | 'transport' // spawn failed, non-zero exit, or unparseable output
  | 'guardrail' // the model answered, but not with a usable title

export type TextGenerationResult =
  | { ok: true; value: string; ms: number }
  | { ok: false; code: TextGenerationFailureCode; message: string }

/** Per-CLI command/WSL override, the same shape the launch path forwards. */
export type TextGenerationCliRuntimeOverrides = Record<
  string,
  { command?: string; useWsl?: boolean } | undefined
>

export type ChatTitleRequest = {
  /** The first prompt the person sent. Truncated by the prompt builder. */
  prompt: string
  engine: TextGenerationEngine
  cliRuntimes?: TextGenerationCliRuntimeOverrides
  /** Caller-owned deadline. Defaults to DEFAULT_TEXT_GENERATION_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * A title is a background job with nothing waiting on it, so the budget is
 * generous: a cold `codex exec` takes 5-15 s, `claude -p` with thinking off
 * ~3 s (see `engineEnv` in the service), a slow day more. 90 s is far past
 * any answer still worth having.
 */
export const DEFAULT_TEXT_GENERATION_TIMEOUT_MS = 90_000

/**
 * The CLIs with a headless backend, and the cheap engine each one defaults to.
 *
 * This is code knowledge, not manifest knowledge: a manifest cannot declare a
 * backend that is not implemented, so the table lives beside the backends
 * rather than in plugin.json. The defaults are a small model at effort
 * `low`, never the chat's own model, which is what makes a title cost a
 * fraction of a turn.
 *
 * Verified 2026-09-07 on this machine: `claude-haiku-4-5` through
 * `claude 2.1.263`, and `gpt-5.6-luna` through `codex-cli 0.153.3` on a
 * ChatGPT account (`gpt-5.1-codex-mini` is refused there).
 */
const TEXT_GENERATION_BACKENDS: Readonly<
  Record<string, { readonly defaultModel: string; readonly defaultReasoning: string }>
> = {
  'claude-code': { defaultModel: 'claude-haiku-4-5', defaultReasoning: 'low' },
  codex: { defaultModel: 'gpt-5.6-luna', defaultReasoning: 'low' },
}

export function supportsTextGeneration(cli: string | null | undefined): boolean {
  return typeof cli === 'string' && Object.prototype.hasOwnProperty.call(TEXT_GENERATION_BACKENDS, cli)
}

/**
 * The person's setting, as persisted. `engine` null means "whichever supported
 * CLI is installed, at its default"; a stored engine with an empty model means
 * that CLI at its default model.
 */
export type TextGenerationSettings = {
  enabled: boolean
  engine: TextGenerationEngine | null
}

/**
 * Turn the setting into the engine a call should actually use, or null when
 * no call should be made. `installed(cli)` answers from the availability
 * probe: `false` excludes a CLI, while `true` and `undefined` (not probed yet)
 * both keep it — the same trust rule the deployment pickers use, so a slow
 * probe never silences the feature on a machine that has the CLI.
 *
 * A remembered engine whose CLI is gone falls through to the first supported
 * installed CLI in `candidates`, so uninstalling Codex does not leave the
 * setting pointing at nothing.
 */
export function resolveTextGenerationEngine(
  settings: TextGenerationSettings | null | undefined,
  candidates: ReadonlyArray<string>,
  installed: (cli: string) => boolean | undefined,
): TextGenerationEngine | null {
  if (!settings?.enabled) return null
  const usable = (cli: string): boolean => supportsTextGeneration(cli) && installed(cli) !== false

  const chosen = settings.engine
  if (chosen && usable(chosen.cli)) return withDefaults(chosen)

  const fallback = candidates.find(usable)
  return fallback ? withDefaults({ cli: fallback, model: '' }) : null
}

function withDefaults(engine: TextGenerationEngine): TextGenerationEngine {
  const backend = TEXT_GENERATION_BACKENDS[engine.cli]
  const model = engine.model.trim() || backend?.defaultModel || ''
  const reasoning = engine.reasoning?.trim() || backend?.defaultReasoning
  return { cli: engine.cli, model, ...(reasoning ? { reasoning } : {}) }
}
