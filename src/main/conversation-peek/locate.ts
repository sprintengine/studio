import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { pathExists } from '../filesystem-workspace'

/**
 * Find the Claude-family transcript for a session whose hook has not named one.
 *
 * The turn-end hook is the authority, but it only fires at the END of a turn —
 * so a chat that was parked yesterday and an app that has just restarted have
 * no path at all, and that is exactly the chat the peek exists for: the forty
 * you are not in. This module recovers the path the CLI would have written,
 * from facts we already hold.
 *
 * A DERIVED PATH IS A GUESS and is treated as one. It is returned only after it
 * resolves to something on disk, the caller re-runs its own containment on it
 * anyway, and every failure here answers `null` so the card falls back to the
 * live prompts and then to identity alone. Nothing throws.
 *
 * Two rulings, both from probing what is actually on this machine rather than
 * from the shape of one example:
 *
 *  1. The encoded directory is built from the directory the CLI was LAUNCHED
 *     in, not from wherever it is now. Of 17 distinct (directory, row `cwd`)
 *     pairs under `~/.claude/projects`, six disagreed — an agent that runs
 *     `cd design-system` or enters a worktree keeps writing to the folder it
 *     started in. Deriving from the observed cwd would miss all six.
 *  2. Every non-alphanumeric character observed in a real path collapses to
 *     `-`: `/home/dev/projects/multicode/.claude/worktrees/workspace-rail`
 *     is stored as `-home-dev-projects-multicode--claude-worktrees-workspace-rail`
 *     (note the `/.` → `--`), and case is preserved (`…-T-mc-sdk-smoke-hFGiGN`).
 *     The rule below generalises that rather than enumerating separators,
 *     because an unhandled character would silently name the wrong folder.
 *
 * The encoding has changed between Claude Code versions before, so the derived
 * path is only the FAST path: when it misses, the session id — which is
 * globally unique and is the file's own name — is looked up by scanning the
 * project folders, the same ruling the token-usage reader
 * reached for the same reason. That scan is memoised per session so a sweep
 * down a sidebar of forty rows does not become forty directory reads.
 */

export type ClaudeTranscriptLocatorDeps = {
  homeDir?: string
  env?: NodeJS.ProcessEnv
  now?: () => number
}

/**
 * Claude session ids are uuid-shaped and are only ever joined into a path, so
 * the charset is restricted here: a malformed id carrying `..` or a separator
 * can never be interpolated into `join`. Fail-closed, matching the token
 * adapter's rule for the same interpolation.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * How long a MISS is remembered. A Claude session whose transcript does not
 * exist yet (the CLI writes it on the first turn) would otherwise cost a
 * directory read per hover; a few seconds is short enough that the card picks
 * the transcript up almost as soon as it appears.
 */
const MISS_TTL_MS = 10_000

type Located = { path: string } | { missedAt: number }

/**
 * Sessions remembered. Bounded because this map outlives every session it
 * describes: without a ceiling an app left open for a week accumulates one
 * entry per chat ever hovered, for the life of the process. Insertion order is
 * eviction order, and a re-resolve costs one `access`.
 */
const MEMO_ENTRIES = 64

const memo = new Map<string, Located>()

function remember(key: string, value: Located): void {
  memo.delete(key)
  memo.set(key, value)
  while (memo.size > MEMO_ENTRIES) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
}

/** Drops the located-transcript memo. Test seam. */
export function clearClaudeTranscriptLocatorCache(): void {
  memo.clear()
}

/**
 * The transcript for `cliSessionId`, or null when there is not one we can
 * point at. `launchCwd` is the directory the session was spawned in — pass the
 * worktree path when the agent runs in one, never the observed cwd.
 */
export async function locateClaudeTranscript(
  input: { cliSessionId: string; launchCwd?: string | null },
  deps: ClaudeTranscriptLocatorDeps = {},
): Promise<string | null> {
  const { cliSessionId, launchCwd } = input
  if (!cliSessionId || !SESSION_ID_PATTERN.test(cliSessionId)) return null

  const projectsDir = join(resolveClaudeConfigDir(deps.homeDir ?? homedir(), deps.env ?? process.env), 'projects')
  const fileName = `${cliSessionId}.jsonl`
  const memoKey = `${projectsDir} ${cliSessionId}`
  const now = (deps.now ?? Date.now)()

  const remembered = memo.get(memoKey)
  if (remembered) {
    if ('path' in remembered) {
      // Revalidate: a transcript can be deleted, and a stale hit would send the
      // reader after a file that is gone.
      if (await pathExists(remembered.path)) return remembered.path
      memo.delete(memoKey)
    } else if (now - remembered.missedAt < MISS_TTL_MS) {
      return null
    }
  }

  if (launchCwd && launchCwd.startsWith('/') && !launchCwd.includes('\0')) {
    const derived = join(projectsDir, encodeClaudeProjectDir(launchCwd), fileName)
    if (await pathExists(derived)) {
      remember(memoKey, { path: derived })
      return derived
    }
  }

  let entries: Dirent[]
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    remember(memoKey, { missedAt: now })
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(projectsDir, entry.name, fileName)
    if (await pathExists(candidate)) {
      remember(memoKey, { path: candidate })
      return candidate
    }
  }
  remember(memoKey, { missedAt: now })
  return null
}

/**
 * The folder name Claude Code gives a working directory: every character that
 * is not a letter or a digit becomes `-`. See the ruling above for the evidence.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * Where the Claude family keeps its state. `CLAUDE_CONFIG_DIR` wins, taking the
 * first entry of a comma-separated list, exactly as the token-usage adapter
 * resolves it — the two must not disagree about where a session's transcript is.
 */
export function resolveClaudeConfigDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  if (override) {
    const first = override.split(',')[0]?.trim()
    if (first) return first
  }
  return join(homeDir, '.claude')
}
