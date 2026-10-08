import {
  distroOfHostId,
  hostIdForFolder,
  isWslHostId,
  LOCAL_HOST_ID,
  type ExecutionHostId,
} from '../../../../../shared/execution-host'
import { sameRepository, type RepositoryIdentity } from '../../../../../shared/repository-identity'
import type { MeshBrowse, MeshConnection, MeshWorkspace } from '../../../../../shared/tailnet-mesh'

// New chat's machine dimension, apart from the panel that draws it: which
// paired machine holds the project in hand, which machine on this computer a
// folder runs on, how the machine list is ordered, and the machines picked
// last this session.

/**
 * Whether a paired machine holds the project in hand (one-project-across-
 * machines): the machine dropdown lists each machine with this, so picking
 * one keeps the project instead of asking for it again. `unknown` before the
 * machine has been asked; `none` when there is no project to match.
 */
export type MachineAvailability =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'has'; workspace: MeshWorkspace }
  | { state: 'lacks'; reason: string }
  | { state: 'unreachable'; reason: string }

/** A machine's last browse, stamped so a stale or failed one is asked again. */
export type MachineBrowseEntry = 'loading' | { browse: MeshBrowse; at: number }
const MACHINE_BROWSE_HOLD_MS = 30_000

export function browseOf(entry: MachineBrowseEntry | undefined): MeshBrowse | 'loading' | undefined {
  return entry === 'loading' || entry === undefined ? entry : entry.browse
}

export function machineBrowseStale(entry: MachineBrowseEntry | undefined, now = Date.now()): boolean {
  if (entry === undefined) return true
  if (entry === 'loading') return false
  return !entry.browse.reachable || entry.browse.unauthorized || now - entry.at > MACHINE_BROWSE_HOLD_MS
}

/** Which of a machine's workspaces is the repository in hand, if any. */
export function machineCopyOf(browse: MeshBrowse, identity: RepositoryIdentity | null): MeshWorkspace | null {
  if (!identity) return null
  const copies = browse.workspaces.filter((workspace) => sameRepository(workspace.repository, identity))
  // A plain checkout over a worktree of the same repository (its worktrees
  // share its remote): the copy a person means is the clone, not a branch
  // of it that happens to be open there.
  return (
    copies.find((workspace) => !/\/\.sprintengine-worktrees\//u.test(workspace.folderPath ?? '')) ?? copies[0] ?? null
  )
}

export function machineAvailabilityOf(
  machine: MeshConnection,
  browse: MeshBrowse | 'loading' | undefined,
  identity: RepositoryIdentity | null,
): MachineAvailability {
  if (!identity) return { state: 'none' }
  if (browse === undefined || browse === 'loading') return { state: 'loading' }
  if (!browse.reachable) {
    return { state: 'unreachable', reason: browse.unreachableReason ?? `${machine.machineName} is not answering.` }
  }
  if (browse.unauthorized)
    return {
      state: 'unreachable',
      reason: `${machine.machineName} refused this pairing — re-pair from Settings → Remote.`,
    }
  const copy = machineCopyOf(browse, identity)
  if (copy) return { state: 'has', workspace: copy }
  const gap = browse.gaps.find((entry) => entry.part === 'workspaces')
  if (gap) return { state: 'lacks', reason: gap.message }
  return { state: 'lacks', reason: `No copy of ${identity.name} on ${machine.machineName}.` }
}

// The machines picked last, for THIS session only (never persisted), held in
// one object because the panel that writes them lives in another module.
export const rememberedMachine: {
  // The paired machine: reopening New chat keeps the target a person just
  // used, while a fresh app start opens on This device — a remote is never
  // preselected on first open.
  machineId: string | null
  // The same, for a machine on this computer (a WSL distribution). Null
  // follows the folder: a folder inside a distribution defaults to it,
  // anything else here.
  hostId: ExecutionHostId | null
  // The SSH machine.
  sshId: string | null
} = { machineId: null, hostId: null, sshId: null }
// The folder typed for each SSH machine, for this session.
export const lastSshFolders = new Map<string, string>()

/** Test seam: forget the session's remembered machine. */
export function resetRememberedMachineForTests(): void {
  rememberedMachine.machineId = null
  rememberedMachine.hostId = null
  rememberedMachine.sshId = null
  lastSshFolders.clear()
}

/**
 * The machine a New chat runs on. A machine chosen in this door for the
 * folder in it now wins, whichever side of the Windows ↔ WSL line the folder
 * is on (owner ruling 2026-10-03). With none, the distribution a folder inside
 * WSL lives in, else the machine picked last, else this machine (owner
 * decision 2026-09-24): a pick carried over from another folder stands until
 * the folder names a distribution of its own.
 */
export function defaultNewChatHostId(
  folder: string | null | undefined,
  picked: ExecutionHostId | null,
  chosen: ExecutionHostId | null = null,
): ExecutionHostId {
  return chosen ?? hostIdForFolder(folder) ?? picked ?? LOCAL_HOST_ID
}

/**
 * Why a machine on this computer cannot take a folder, or null when it can.
 * A WSL machine opens its own disk and the Windows drives, and This PC opens
 * every distribution's share, but one distribution cannot open another's.
 */
export function hostRefusesFolder(host: ExecutionHostId, folder: string | null | undefined): string | null {
  const folderHost = hostIdForFolder(folder)
  if (!folderHost || !isWslHostId(host) || host === folderHost) return null
  return `WSL: ${distroOfHostId(host)} cannot open a folder inside ${distroOfHostId(folderHost)}.`
}

// This device first, then paired machines alphabetically — a list that
// reorders as pairings come and go is one nobody can learn.
export function sortMachines(machines: MeshConnection[]): MeshConnection[] {
  return [...machines].sort((a, b) => a.machineName.localeCompare(b.machineName, undefined, { sensitivity: 'base' }))
}
