import { getGitRepoRoot } from './git'
import { runGit } from './git-utils'
import {
  parseRemoteFetchUrls,
  pickPrimaryRemote,
  repositoryIdentityFromRemote,
  type RepositoryIdentity,
} from '../shared/repository-identity'

// The main-side half of one-project-across-machines (MC-2406): which
// repository a folder is a clone of, as its primary remote names it.
//
// Read on demand and cached briefly, because the two readers — the sidebar's
// grouping and the gateway's `workspace.list` projection — both ask about
// every workspace folder at once, and a remote URL changes about never.
// Not a watcher: a person who edits `.git/config` sees the new identity on
// the next read after the hold lapses, which is soon enough for a grouping.

const HOLD_MS = 60_000
// A folder on a spun-down volume must not hang every `workspace.list` behind
// it: past this, the identity is "not known" and cached as such for the hold.
const READ_TIMEOUT_MS = 3_000
// A read that did not complete (timed out, git threw) is not "no remote":
// it is retried after a short pause rather than held for the full minute.
const RETRY_AFTER_FAILURE_MS = 10_000

type Held = { at: number; identity: RepositoryIdentity | null }
const held = new Map<string, Held>()
const inFlight = new Map<string, Promise<RepositoryIdentity | null>>()

function keyOf(folderPath: string): string {
  return folderPath.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * The repository a folder belongs to, or null: not a repository, no remote,
 * or git unavailable. Never throws — an identity that cannot be read is an
 * absent identity, and the folder groups by its path as it always has.
 */
export async function readRepositoryIdentity(
  folderPath: string,
  options: { now?: () => number } = {}
): Promise<RepositoryIdentity | null> {
  const trimmed = folderPath.trim()
  if (!trimmed) return null
  const key = keyOf(trimmed)
  const now = options.now ?? Date.now
  const cached = held.get(key)
  if (cached && now() - cached.at < HOLD_MS) return cached.identity
  const pending = inFlight.get(key)
  if (pending) return pending
  const TIMED_OUT = Symbol('timed-out')
  const read = (async (): Promise<{ identity: RepositoryIdentity | null; settled: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), READ_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      const answer = await Promise.race([
        (async () => {
          const root = await getGitRepoRoot(trimmed)
          if (!root) return null
          const stdout = await runGit(root, ['remote', '-v'])
          const primary = pickPrimaryRemote(parseRemoteFetchUrls(stdout))
          return primary ? repositoryIdentityFromRemote(primary.remoteUrl) : null
        })(),
        timeout,
      ])
      return answer === TIMED_OUT ? { identity: null, settled: false } : { identity: answer, settled: true }
    } catch {
      return { identity: null, settled: false }
    } finally {
      if (timer) clearTimeout(timer)
    }
  })()
  inFlight.set(key, read.then((outcome) => outcome.identity))
  try {
    const outcome = await read
    held.set(key, { at: outcome.settled ? now() : now() - HOLD_MS + RETRY_AFTER_FAILURE_MS, identity: outcome.identity })
    return outcome.identity
  } finally {
    inFlight.delete(key)
  }
}
