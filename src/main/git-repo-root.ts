import { isWslHostId } from '../shared/execution-host'
import { getGitRepoRoot } from './git'
import { withGitHost } from './git-run'
import { hostRegistry } from './hosts/host-registry'

// The repository a folder is in, asked of the right machine. Its own module,
// free of Electron, because the Studio server answers it too (the chat view's
// repo root over the protocol) and the git panel's IPC stays with the shell.

/**
 * `hostId` names the machine whose git answers, for a caller that knows it
 * before any workspace does (a New chat on a WSL machine, see withGitHost).
 */
export const scopedHost = (hostId: unknown) =>
  isWslHostId(typeof hostId === 'string' ? hostId : null) ? hostRegistry().get(hostId as string) : null

/** The repository a folder is in, asked of the machine `hostId` names: the IPC's answer, and the Studio RPC's. */
export function gitRepoRootFor(folderPath: string, hostId?: unknown): Promise<string | null> {
  return withGitHost(scopedHost(hostId), () => getGitRepoRoot(folderPath))
}
