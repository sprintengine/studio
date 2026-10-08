// Did this tool call open a pull request? The one reader of that question
// (owner ruling 2026-10-04: a conversation owns a pull request when its agent
// created it). Every path that sees an agent's tool calls asks it here: the
// server for a chat's stream, and the server again for a terminal agent's
// hook, which forwards the call it saw and decides nothing itself. An earlier
// capture had a copy of this rule in each of three places, and the copies
// disagreed about which output fields to read, which tools to gate on and
// whom to file the result under; with one reader there is nothing to disagree.
//
// TWO PARTS, both required:
//
// - The gate is the CALL. A shell command that creates one (`gh pr create`,
//   `glab mr create`, `git push -o merge_request.create`), or a tool named for
//   creating one (a GitHub, GitLab or Gitea MCP server's
//   `create_pull_request` / `create_merge_request`). A URL alone is not
//   enough: `gh pr list`, `gh pr view` and a push to GitLab or Gitea all print
//   the URLs of pull requests that already exist, and somebody else may have
//   opened those.
// - The evidence is the RESULT. The call did not fail, and its OUTPUT names a
//   pull request URL the shared classifier reads (`classifyPullRequestUrl`).
//   Never the input: an agent that merely typed a URL has opened nothing.
//
// "Already exists" is not an opening. `gh pr create` on a branch that has a
// pull request fails and prints that pull request's URL, and so does a second
// agent on the same branch; neither of them opened it. Only the forge's own
// refusal counts as one: a title or a log line that says "already exists"
// is not.
//
// The create is the chain's last command. `gh pr create … || gh pr view
// --json url` prints the URL of whatever pull request the branch already
// had, which may be somebody else's; the creation's own output is only
// trusted when nothing ran after it.
//
// Left out on purpose: `tea` and Forgejo's CLI (their output is not one this
// was checked against), `az repos pr create` (it prints an API URL, not the
// pull request's page), and a pull request made with `curl` or `gh api`. An
// agent that opens one any of those ways says so with the gateway's
// `pull_request.link`.

import { classifyPullRequestUrl, type PullRequestForge } from './pr-url'

/** One tool call, as the server saw it: in a chat's stream, or forwarded from a terminal agent's hook. */
export type PullRequestToolCall = {
  /** The tool's name as the agent's CLI spells it: `Bash`, `shell`, `mcp__github__create_pull_request`. */
  name: string
  /** The shell command it ran, when it ran one. Read off `input` when absent. */
  command?: string | null
  /** The tool's input; only a shell call's command is read off it. */
  input?: unknown
  /** What it returned: a string, or the structured result a CLI or an MCP server gave. */
  output: unknown
  /** The call failed. A failed call opened nothing. */
  failed?: boolean
}

export type OpenedPullRequest = { url: string; forge: PullRequestForge }

/** How much of one output is read: a noisy push can put a megabyte in front of the URL. */
export const PULL_REQUEST_OUTPUT_SCAN_CHARS = 64 * 1024
/** A URL this long is not a pull request's. */
const MAX_URL_LENGTH = 2048

/**
 * The shell commands that create one, however the shell spaced them, and
 * wherever in a compound command they sit (`cd ../site && gh pr create`).
 * `gh pr list` and `glab mr view` do not match.
 */
const CREATE_COMMANDS: readonly RegExp[] = [
  /\bgh\s+pr\s+create\b/,
  /\bglab\s+mr\s+create\b/,
  // A push that asks GitLab to open the merge request: `-o merge_request.create`
  // or `--push-option=merge_request.create`, in one command.
  /\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(?:\s-o\s*|--push-option[=\s]\s*)["']?merge_request\.create\b/,
]

/** A tool named for creating one, after any server prefix (`mcp__github__`, `gitlab.`, `gitea_`). */
const CREATE_TOOL_NAME = /(?:^|[_.:/-])create[_-]?(?:pull[_-]?request|merge[_-]?request)$/i

/**
 * The forges' refusals to open a second pull request for a branch: gh's,
 * GitHub's API (through an MCP server), GitLab's (glab, its API, a push
 * option), and Gitea's.
 */
const ALREADY_EXISTS: readonly RegExp[] = [
  /\ba pull request for branch\b[^\n]*\balready exists\b/i,
  /\ba pull request already exists for\b/i,
  /\banother open merge request already exists\b/i,
  /\bpull request already exists for these targets\b/i,
]

/** A URL as it sits in text, a JSON string or a markdown link. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}`\\|^]+/g

/** Whether a call is one that can open a pull request. Cheap: decided before any output is read. */
export function isPullRequestCreation(call: Pick<PullRequestToolCall, 'name' | 'command' | 'input'>): boolean {
  const name = typeof call.name === 'string' ? call.name.trim() : ''
  if (name && CREATE_TOOL_NAME.test(name)) return true
  const command = typeof call.command === 'string' ? call.command : toolCommandOf(call.input)
  return command !== null && CREATE_COMMANDS.some((pattern) => pattern.test(command))
}

/** The pull request this call opened, or null. */
export function readOpenedPullRequest(call: PullRequestToolCall): OpenedPullRequest | null {
  if (call.failed === true || !isPullRequestCreation(call)) return null
  const command = typeof call.command === 'string' ? call.command : toolCommandOf(call.input)
  if (command !== null && !CREATE_TOOL_NAME.test(call.name.trim()) && !endsWithCreation(command)) return null
  const text = outputText(call.output)
  if (!text || ALREADY_EXISTS.some((pattern) => pattern.test(text))) return null
  if (text.length <= PULL_REQUEST_OUTPUT_SCAN_CHARS) return firstPullRequestIn(text, false)
  // Read at BOTH ends, separately: `gh` prints the URL last, an MCP server's
  // JSON names it near the top. The head is a cut string, so a URL running to
  // its very end may be half a URL (`/pull/1` of `/pull/1234`) and is not
  // believed; a cut at the start of the tail leaves nothing that begins
  // `https://`.
  const half = PULL_REQUEST_OUTPUT_SCAN_CHARS / 2
  return firstPullRequestIn(text.slice(0, half), true) ?? firstPullRequestIn(text.slice(-half), false)
}

/** Whether the last command of a shell chain is one that creates a pull request. */
function endsWithCreation(command: string): boolean {
  const last = shellChainCommands(command).at(-1)
  return last !== undefined && CREATE_COMMANDS.some((pattern) => pattern.test(last))
}

/**
 * The commands of a chain, split where the shell would run the next one (`&&`,
 * `||`, `;`, `&`, a newline) and nowhere inside quotes, `$(…)` or `(…)`. A
 * pipe stays inside its command: what it prints is still that command's. A
 * here-document's body is left out, so `--body-file - <<EOF` does not end the
 * chain on its last line. Close enough to a shell for this question; one it
 * cannot follow reads as a single command.
 */
function shellChainCommands(command: string): string[] {
  const text = withoutHereDocBodies(command)
  const commands: string[] = []
  const stack: Array<'sq' | 'dq' | 'sub'> = []
  let current = ''
  const push = () => {
    if (current.trim()) commands.push(current.trim())
    current = ''
  }
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    const next = text[index + 1]
    const top = stack.at(-1)
    if (top === 'sq') {
      if (char === "'") stack.pop()
      current += char
      continue
    }
    if (char === '\\') {
      current += char + (next ?? '')
      index += 1
      continue
    }
    if (top === 'dq') {
      if (char === '"') stack.pop()
      else if (char === '$' && next === '(') {
        stack.push('sub')
        current += char + next
        index += 1
        continue
      }
      current += char
      continue
    }
    if (char === "'") stack.push('sq')
    else if (char === '"') stack.push('dq')
    else if (char === '(') stack.push('sub')
    else if (char === ')' && top === 'sub') stack.pop()
    else if (stack.length === 0) {
      if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
        push()
        index += 1
        continue
      }
      if (char === ';' || char === '\n' || (char === '&' && next !== '>' && text[index - 1] !== '>')) {
        push()
        continue
      }
    }
    current += char
  }
  push()
  return commands
}

/** The command with every here-document's body taken out, its operator line kept. */
function withoutHereDocBodies(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    kept.push(line)
    const opened = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line)
    if (!opened) continue
    const delimiter = opened[2]
    while (index + 1 < lines.length && lines[index + 1]!.trim() !== delimiter) index += 1
    index += 1
  }
  return kept.join('\n')
}

/**
 * The shell command a tool's input names, under every spelling the agent CLIs
 * use: a string on `command` (Claude Code, Grok, Kimi, a chat's normalised
 * command), an argv array (`['bash', '-lc', 'gh pr create …']`), or `cmd` /
 * `script`. Anything else is no command.
 */
export function toolCommandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const record = input as Record<string, unknown>
  for (const candidate of [record.command, record.cmd, record.script]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
    if (Array.isArray(candidate)) {
      const parts = candidate.filter((part): part is string => typeof part === 'string')
      if (parts.length > 0) return parts.join(' ')
    }
  }
  return null
}

/**
 * A result as text. A string is itself; anything else (Claude's `{ stdout,
 * stderr }`, an MCP result's `content` parts and `structuredContent`) is its
 * JSON, whose escapes end a URL where the string held it.
 */
export function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (output === null || output === undefined) return ''
  try {
    return JSON.stringify(output) ?? ''
  } catch {
    return ''
  }
}

function firstPullRequestIn(text: string, mustEndInside: boolean): OpenedPullRequest | null {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const raw = match[0].replace(/[.,;:!?]+$/, '')
    if (raw.length > MAX_URL_LENGTH) continue
    if (mustEndInside && (match.index ?? 0) + match[0].length >= text.length) continue
    const classified = classifyPullRequestUrl(raw)
    if (classified) return { url: classified.url, forge: classified.forge }
  }
  return null
}
