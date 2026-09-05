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
  const read = (async () => {
    try {
      const root = await getGitRepoRoot(trimmed)
      if (!root) return null
      const stdout = await runGit(root, ['remote', '-v'])
      const primary = pickPrimaryRemote(parseRemoteFetchUrls(stdout))
      return primary ? repositoryIdentityFromRemote(primary.remoteUrl) : null
    } catch {
      return null
    }
  })()
  inFlight.set(key, read)
  try {
    const identity = await read
    held.set(key, { at: now(), identity })
    return identity
  } finally {
    inFlight.delete(key)
  }
}

/** Test seam: forget every held identity. */
export function resetRepositoryIdentityCacheForTests(): void {
  held.clear()
  inFlight.clear()
}
