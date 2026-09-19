import type { RepositoryIdentity } from '../../../../../shared/repository-identity'
import type { FleetWorkspace } from '../../../../../shared/tailnet-fleet'

// The New-chat machine picker's project list, folded out of what a paired
// machine actually serves.
//
// `workspace.list` reports that machine's open WORKSPACES, and a workspace in
// this app is a conversation — so the raw list is "every chat open over there",
// which is what the remote project chip was drawing: eight rows named after
// eight chats, three of them the same folder. A project is a FOLDER, and the
// picker is choosing where a new chat runs, so the folder is the unit.
//
// Folded by folder path and not by repository, deliberately. Two chats on one
// machine can share a repository and NOT share a folder — a worktree chat is a
// clone of its project by `canonicalKey` and a different checkout on disk — and
// the id this list carries is the one `workspace.checkout` is asked with and
// the folder a launch lands in. Merging those would pick one of the two folders
// arbitrarily and run the chat in whichever won.

/** One project on a paired machine: a folder, and the chats standing in it. */
export type RemoteProject = {
  /** Stable across reads: the normalised folder path. */
  key: string
  /** The folder's own name — what the sidebar would call the project here. */
  name: string
  folderPath: string
  /** The repository the machine read off the folder, for the row's hue. Null when it could not. */
  repository: RepositoryIdentity | null
  /**
   * The workspace this project is asked about with — `workspace.checkout` is
   * keyed by workspace id, and every chat in one folder answers for the folder.
   * Chosen by lowest id so a re-read does not move it.
   */
  workspaceId: string
  /** The machine's open chats in this folder. */
  conversationCount: number
}

function normalizeFolder(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/u, '')
}

/** The folder's last segment, the way the sidebar names a project. */
function folderName(folderPath: string): string {
  const normalized = normalizeFolder(folderPath)
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash === -1) return normalized
  return normalized.slice(lastSlash + 1) || normalized
}

/**
 * The machine's projects, in name order.
 *
 * A workspace with no folder is not a project and is dropped: there is nowhere
 * for a new chat to run in it, and a "No folder" row in a list whose only job
 * is picking a folder is a row that cannot be chosen.
 */
export function remoteProjectsOf(workspaces: readonly FleetWorkspace[]): RemoteProject[] {
  const byFolder = new Map<string, RemoteProject>()
  for (const workspace of workspaces) {
    const folderPath = workspace.folderPath?.trim()
    if (!folderPath) continue
    const key = normalizeFolder(folderPath).toLowerCase()
    const existing = byFolder.get(key)
    if (!existing) {
      byFolder.set(key, {
        key,
        name: folderName(folderPath),
        folderPath,
        repository: workspace.repository,
        workspaceId: workspace.id,
        conversationCount: 1,
      })
      continue
    }
    existing.conversationCount += 1
    // Lowest id wins the seat, so the project keeps asking about the same
    // workspace across reads. The repository is taken from whichever chat
    // could answer — a machine that read the remote for one chat in a folder
    // read it for the folder.
    if (workspace.id < existing.workspaceId) existing.workspaceId = workspace.id
    if (!existing.repository && workspace.repository) existing.repository = workspace.repository
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name) || a.folderPath.localeCompare(b.folderPath))
}

/** The project a picked workspace id belongs to, or null when the read no longer holds it. */
export function remoteProjectOfWorkspace(
  projects: readonly RemoteProject[],
  workspaces: readonly FleetWorkspace[],
  workspaceId: string,
): RemoteProject | null {
  const workspace = workspaces.find((entry) => entry.id === workspaceId)
  const folderPath = workspace?.folderPath?.trim()
  if (!folderPath) return null
  const key = normalizeFolder(folderPath).toLowerCase()
  return projects.find((project) => project.key === key) ?? null
}
