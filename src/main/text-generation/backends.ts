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
// as a failure. Null when nothing there is a title.
export function readClaudeChatTitleStdout(stdout: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return readChatTitleOutput(stdout)
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
  if (envelope.structured_output !== undefined) return readChatTitleOutput(envelope.structured_output)
  return readChatTitleOutput(envelope.result)
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
