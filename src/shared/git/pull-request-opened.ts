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
// agent on the same branch; neither of them opened it.
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
  const text = outputText(call.output)
  if (!text || /\balready exists\b/i.test(text)) return null
  if (text.length <= PULL_REQUEST_OUTPUT_SCAN_CHARS) return firstPullRequestIn(text, false)
  // Read at BOTH ends, separately: `gh` prints the URL last, an MCP server's
  // JSON names it near the top. The head is a cut string, so a URL running to
  // its very end may be half a URL (`/pull/1` of `/pull/1234`) and is not
  // believed; a cut at the start of the tail leaves nothing that begins
  // `https://`.
  const half = PULL_REQUEST_OUTPUT_SCAN_CHARS / 2
  return firstPullRequestIn(text.slice(0, half), true) ?? firstPullRequestIn(text.slice(-half), false)
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
