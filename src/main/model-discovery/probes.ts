// How each agent CLI is asked which models it accepts, keyed by plugin id.
//
// Declared here in main-process code rather than in the plugin manifests: a
// manifest field would be an SDK change plus a drift-guard update, which is
// worth doing once the shape has settled (docs/model-discovery-plan.md, rule 8).
//
// Every parser below is a pure function over the CLI's own output, tested
// against output captured from the real binaries (./__fixtures__). A parser
// that cannot find what it expects throws with plain words; it never guesses a
// list, because rows the CLI did not print would end up in every picker.
import type { DiscoveredCliModel } from '../../shared/cli-model-catalog'
import { probeAgentSdkModels } from './agent-sdk-probe'
import { CliModelProbeError, type CliModelProbe } from './probe-types'

// Colour codes and zero-width characters. Cursor pads some labels with
// U+200B, which would otherwise survive into the picker as invisible text.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[A-Za-z]/g
const INVISIBLE_PATTERN = /[\u200b-\u200d\u2060\ufeff]/g

function cleanLine(line: string): string {
  return line.replace(ANSI_PATTERN, '').replace(INVISIBLE_PATTERN, '').replace(/\s+/g, ' ').trim()
}

function outputLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).map(cleanLine)
}

function dedupeById(models: DiscoveredCliModel[]): DiscoveredCliModel[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) return false
    seen.add(model.id)
    return true
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || undefined
}

// `codex debug models`: the JSON catalog Codex itself reads. Rows marked
// `visibility: "hide"` are internal (a review model, a reserve slug) and Codex's
// own picker leaves them out, so this does too. Order is Codex's `priority`,
// ties kept in the order Codex printed them.
export function parseCodexDebugModels(stdout: string): DiscoveredCliModel[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new CliModelProbeError('Codex did not print its model list as JSON.')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    throw new CliModelProbeError('Codex printed JSON without a models list.')
  }
  const rows = parsed.models
    .map((row, index) => ({ row, index }))
    .filter((entry): entry is { row: Record<string, unknown>; index: number } => isRecord(entry.row))
    .filter(({ row }) => row.visibility !== 'hide')
    .sort((a, b) => priorityOf(a.row) - priorityOf(b.row) || a.index - b.index)
  const models: DiscoveredCliModel[] = []
  for (const { row } of rows) {
    const id = text(row.slug)
    if (!id) continue
    const model: DiscoveredCliModel = { id }
    const displayName = text(row.display_name)
    if (displayName) model.displayName = displayName
    const description = text(row.description)
    if (description) model.description = description
    if (typeof row.context_window === 'number' && Number.isFinite(row.context_window) && row.context_window > 0) {
      model.contextWindow = row.context_window
    }
    if (Array.isArray(row.supported_reasoning_levels)) {
      const levels = row.supported_reasoning_levels
        .map((level) => (isRecord(level) ? text(level.effort) : undefined))
        .filter((level): level is string => Boolean(level))
      if (levels.length > 0) model.effortLevels = levels
    }
    const defaultEffort = text(row.default_reasoning_level)
    if (defaultEffort) model.defaultEffort = defaultEffort
    if (Array.isArray(row.additional_speed_tiers)) {
      model.supportsFastMode = row.additional_speed_tiers.includes('fast')
    }
    models.push(model)
  }
  return dedupeById(models)
}

function priorityOf(row: Record<string, unknown>): number {
  return typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : Number.POSITIVE_INFINITY
}

// A marker a CLI appends to the row that is currently its default. It says
// something about this machine's configuration, not about the model, so it is
// not part of the label.
const DEFAULT_MARKER = /\s*\((?:default|current)\)\s*$/i

// `cursor-agent --list-models`: an "Available models" heading, a blank line,
// then `id - label` rows, then a blank line and a usage tip.
export function parseCursorListModels(stdout: string): DiscoveredCliModel[] {
  const lines = outputLines(stdout)
  const heading = lines.findIndex((line) => /^available models:?$/i.test(line))
  if (heading < 0) throw new CliModelProbeError('Cursor did not print a model list.')
  const models: DiscoveredCliModel[] = []
  for (const line of lines.slice(heading + 1)) {
    if (!line) {
      if (models.length > 0) break
      continue
    }
    const match = /^(\S+) - (.+)$/.exec(line)
    if (!match) continue
    const label = match[2].replace(DEFAULT_MARKER, '').trim()
    models.push(label ? { id: match[1], displayName: label } : { id: match[1] })
  }
  return dedupeById(models)
}

// `grok models`: an "Available models:" heading, then `* id (default)` for the
// configured default and `- id` for the rest. Answers signed out as well.
export function parseGrokModels(stdout: string): DiscoveredCliModel[] {
  const lines = outputLines(stdout)
  const heading = lines.findIndex((line) => /^available models:?$/i.test(line))
  if (heading < 0) throw new CliModelProbeError('Grok did not print a model list.')
  const models: DiscoveredCliModel[] = []
  for (const line of lines.slice(heading + 1)) {
    const match = /^[*-] (\S+)/.exec(line.replace(DEFAULT_MARKER, ''))
    if (match) models.push({ id: match[1] })
  }
  return dedupeById(models)
}

// `opencode models`: one `provider/model` id per line and nothing else. An
// empty answer is a failure, not an empty catalog: OpenCode prints nothing
// while its provider index is still loading, and recording that as "lists no
// models" would empty the picker.
export function parseOpenCodeModels(stdout: string): DiscoveredCliModel[] {
  const models = outputLines(stdout)
    .filter((line) => /^[^\s/]+\/\S+$/.test(line))
    .map((id) => ({ id }))
  if (models.length === 0) throw new CliModelProbeError('OpenCode printed no models.')
  return dedupeById(models)
}

// The argv probe wrapper: runs the command, turns a timeout or a non-zero exit
// into a sentence, and hands stdout to the parser.
function argvProbe(args: string[], parse: (stdout: string) => DiscoveredCliModel[]): CliModelProbe {
  return {
    source: 'argv-probe',
    run: async (context) => {
      const outcome = await context.runArgv(args)
      const command = [context.binary.split(/[\\/]/).pop() ?? context.binary, ...args].join(' ')
      if (outcome.timedOut) {
        throw new CliModelProbeError(
          `${context.displayName} did not answer \`${command}\` within ${Math.round(context.timeoutMs / 1000)} s.`,
        )
      }
      if (outcome.code !== 0) {
        const detail = firstLine(outcome.stderr) ?? firstLine(outcome.stdout)
        throw new CliModelProbeError(`\`${command}\` exited with code ${outcome.code}${detail ? `: ${detail}` : '.'}`)
      }
      return parse(outcome.stdout)
    },
  }
}

function firstLine(value: string): string | undefined {
  return outputLines(value).find(Boolean)
}

// Claude Code answers through the Agent SDK's control channel instead of an
// argv command. The Z.AI and Kimi runtimes run the same `claude` binary but pin
// every model tier to their own endpoint's model through environment variables
// and declare no model selection, so asking the binary would list the
// Anthropic models those runtimes never launch; they have no probe.
export const CLI_MODEL_PROBES: Readonly<Record<string, CliModelProbe>> = {
  'claude-code': { source: 'agent-sdk', run: (context) => probeAgentSdkModels(context) },
  codex: argvProbe(['debug', 'models'], parseCodexDebugModels),
  cursor: argvProbe(['--list-models'], parseCursorListModels),
  grok: argvProbe(['models'], parseGrokModels),
  opencode: argvProbe(['models'], parseOpenCodeModels),
}
