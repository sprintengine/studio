// The per-CLI recipes for one headless, structured-output call: how each
// agent CLI is invoked so that it answers once, with tools off, in JSON that
// matches a schema, and how its answer is read back. Both recipes were
// verified against the installed CLIs on 2026-09-07.
//
// Pure: argv in, argv out; parsing takes strings. Spawning and temp files
// belong to the service, which is why the Codex recipe takes file paths.

import { readChatTitleOutput } from '../../shared/text-generation/chat-title'

export type ChatTitleInvocation = {
  file: string
  args: string[]
}

export type ClaudeInvocationInput = {
  binaryPath: string
  model: string
  reasoning?: string | undefined
  /** The output schema, already serialised. */
  schemaJson: string
}

// `claude -p` with `--json-schema` returns a JSON envelope carrying the
// decoded object as `structured_output`. Everything else on the line shuts a
// door a title never needs open: no tools (so nothing executes, whatever the
// prompt says), no hooks, no skills, no MCP servers from the checkout. The
// prompt goes on stdin so a message containing shell metacharacters or a
// leading dash is never argv.
export function claudeChatTitleInvocation(input: ClaudeInvocationInput): ChatTitleInvocation {
  return {
    file: input.binaryPath,
    args: [
      '-p',
      '--output-format',
      'json',
      '--json-schema',
      input.schemaJson,
      '--model',
      input.model,
      ...(input.reasoning ? ['--effort', input.reasoning] : []),
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--tools',
      '',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ],
  }
}

// Reads the title out of `claude -p --output-format json` stdout. The envelope
// is one object today; verbose mode wraps it in an array of messages with the
// result last, and both shapes are accepted so a CLI flag drift does not read
// as a failure. Null when nothing there is a title — including stdout that is
// not JSON at all, which in json mode is a banner or an error, never an answer.
export function readClaudeChatTitleStdout(stdout: string): string | null {
  const answer = readClaudeStructuredStdout(stdout)
  return answer === null ? null : readChatTitleOutput(answer)
}

/**
 * The answer in `claude -p --output-format json` stdout, for any job: the
 * decoded `structured_output` when the schema was honoured, else the `result`
 * text. Null for an error envelope or stdout that is not JSON.
 */
export function readClaudeStructuredStdout(stdout: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const envelope = Array.isArray(parsed)
    ? parsed.findLast((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'result'),
      )
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  if (!envelope) return null
  if (envelope.is_error === true) return null
  if (envelope.structured_output !== undefined) return envelope.structured_output
  return envelope.result ?? null
}

export type ClaudeTextInvocationInput = {
  binaryPath: string
  model: string
  reasoning?: string | undefined
  /** The system prompt the call runs under instead of Claude Code's own. */
  system?: string
}

// `claude -p` for free text: the same doors shut as for a title (no tools, so
// nothing executes whatever the prompt says; no hooks, skills or project MCP
// servers), with the answer in the JSON envelope's `result` rather than a
// schema. The prompt goes on stdin; the system prompt is one argv entry, never
// a shell word.
export function claudeTextInvocation(input: ClaudeTextInvocationInput): ChatTitleInvocation {
  return {
    file: input.binaryPath,
    args: [
      '-p',
      '--output-format',
      'json',
      '--model',
      input.model,
      ...(input.reasoning ? ['--effort', input.reasoning] : []),
      ...(input.system ? ['--system-prompt', input.system] : []),
      '--settings',
      JSON.stringify({ disableAllHooks: true }),
      '--tools',
      '',
      '--disable-slash-commands',
      '--strict-mcp-config',
    ],
  }
}

/** What `claude -p --output-format json` says about one free-text call. */
export type ClaudeTextAnswer = {
  text: string
  /** The model that answered, as the CLI names it; null when it does not say. */
  model: string | null
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
}

/**
 * The answer in a free-text call's stdout: the envelope's `result`, the model
 * its `modelUsage` names, and its `usage` by the turn-usage contract (fresh
 * input apart from the cache's reads and writes). Null for an error envelope
 * or stdout that is not JSON.
 */
export function readClaudeTextStdout(stdout: string): ClaudeTextAnswer | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  const envelope = Array.isArray(parsed)
    ? parsed.findLast((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && (entry as { type?: unknown }).type === 'result'),
      )
    : parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  if (!envelope || envelope.is_error === true || typeof envelope.result !== 'string') return null
  const usage = envelope.usage && typeof envelope.usage === 'object' ? (envelope.usage as Record<string, unknown>) : {}
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  const counts = {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  }
  const modelUsage =
    envelope.modelUsage && typeof envelope.modelUsage === 'object' ? Object.keys(envelope.modelUsage) : []
  return {
    text: envelope.result,
    model: modelUsage[0] ?? null,
    usage: Object.fromEntries(Object.entries(counts).filter(([, value]) => value !== undefined)),
  }
}

export type CodexTextInvocationInput = {
  binaryPath: string
  model: string
  reasoning?: string | undefined
  /** A cap on the answer, through Codex's own `model_max_output_tokens`. */
  maxOutputTokens?: number | undefined
  /** Where Codex is told to write its last message: the answer. */
  outputPath: string
}

// `codex exec` for free text: the title recipe without an output schema, plus
// `--json`, whose event stream on stdout is where Codex says what the call
// spent. The answer is the last message, written to `outputPath`.
export function codexTextInvocation(input: CodexTextInvocationInput): ChatTitleInvocation {
  return {
    file: input.binaryPath,
    args: [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      input.model,
      ...(input.reasoning ? ['-c', `model_reasoning_effort="${input.reasoning}"`] : []),
      ...(input.maxOutputTokens !== undefined ? ['-c', `model_max_output_tokens=${input.maxOutputTokens}`] : []),
      '--json',
      '--output-last-message',
      input.outputPath,
      '-',
    ],
  }
}

/**
 * The message Codex is sent for a call with a system prompt: `codex exec`
 * takes no system prompt of its own, so the instructions lead the message,
 * marked off from the prompt they govern.
 */
export function codexTextPrompt(system: string, prompt: string): string {
  return `Instructions for this task:\n${system}\n\n---\n\n${prompt}`
}

/**
 * What a `codex exec --json` call spent, by the turn-usage contract, summed
 * over its `turn.completed` events: Codex counts the cache's share inside its
 * input, so the fresh input is the rest. Empty when the stream says nothing.
 */
export function readCodexTextUsage(stdout: string): ClaudeTextAnswer['usage'] {
  let input = 0
  let cached = 0
  let output = 0
  let seen = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    if (event?.type !== 'turn.completed' || !event.usage || typeof event.usage !== 'object') continue
    const usage = event.usage as Record<string, unknown>
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
    input += count(usage.input_tokens)
    cached += count(usage.cached_input_tokens)
    output += count(usage.output_tokens)
    seen = true
  }
  if (!seen) return {}
  return { inputTokens: Math.max(0, input - cached), outputTokens: output, cacheReadTokens: cached }
}

export type CodexInvocationInput = {
  binaryPath: string
  model: string
  reasoning?: string | undefined
  /** Where the service wrote the output schema. */
  schemaPath: string
  /** Where Codex is told to write its last message. */
  outputPath: string
}

// `codex exec` has no JSON envelope on stdout, so the recipe asks it to write
// the last message to a file and to validate that message against a schema
// file. `--ephemeral` keeps the call out of the person's session history,
// `-s read-only` keeps the model's hands off the checkout, and
// `--skip-git-repo-check` lets it run from the scratch directory the service
// hands it. The trailing `-` reads the prompt from stdin.
export function codexChatTitleInvocation(input: CodexInvocationInput): ChatTitleInvocation {
  return {
    file: input.binaryPath,
    args: [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '-s',
      'read-only',
      '--model',
      input.model,
      ...(input.reasoning ? ['-c', `model_reasoning_effort="${input.reasoning}"`] : []),
      '--output-schema',
      input.schemaPath,
      '--output-last-message',
      input.outputPath,
      '-',
    ],
  }
}

// The last-message file holds the JSON object Codex was asked for, or, when
// the schema was not honoured, whatever it said last.
export function readCodexChatTitleOutput(lastMessage: string): string | null {
  return readChatTitleOutput(lastMessage)
}
