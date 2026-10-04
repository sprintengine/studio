import { normalizeExecutionHostId } from '../shared/execution-host'
import { getGitRepoRoot } from './git'
import { withGitHost } from './git-run'
import { hostRegistry } from './hosts/host-registry'

// The repository a folder is in, asked of the right machine. Its own module,
// free of Electron, because the Studio server answers it too (the chat view's
// repo root over the protocol) and the git panel's IPC stays with the shell.

/**
 * `hostId` names the machine whose git answers, for a caller that knows it
 * before any workspace does (a New chat, see withGitHost). This PC counts as
 * a choice too: a chat there in a folder inside a distribution makes its
 * worktree with this machine's git, not the distribution's. Nothing named
 * leaves the resolver to decide.
 */
export const scopedHost = (hostId: unknown) => {
  const id = normalizeExecutionHostId(hostId)
  return id ? hostRegistry().get(id) : null
}

/** The repository a folder is in, asked of the machine `hostId` names: the IPC's answer, and the Studio RPC's. */
export function gitRepoRootFor(folderPath: string, hostId?: unknown): Promise<string | null> {
  return withGitHost(scopedHost(hostId), () => getGitRepoRoot(folderPath))
}
