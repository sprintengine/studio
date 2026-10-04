import { parseMachinePath } from '../../../../../shared/machine-paths'
import React from 'react'
import type { AgentCli, CliPermissionPreset, WorkspaceSkill } from '../../../../../shared/electron-api'
import type {
  MeshBrowse,
  MeshConnection,
  MeshWorkspace,
  MeshWorkspaceCheckout,
} from '../../../../../shared/tailnet-mesh'
import { sameRepository, type RepositoryIdentity } from '../../../../../shared/repository-identity'
import { folderIdentityKey, useFolderRepositoryIdentities } from '../useFolderRepositoryIdentities'
import { ExtensionsGlyph, FolderTypeIcon, GitBranchGlyph, RemoteMachineGlyph } from '../../AppIcons'
import {
  distroOfHostId,
  hostIdForFolder,
  hostIdToRecord,
  isWslHostId,
  LOCAL_HOST_ID,
  type ExecutionHostId,
  type ExecutionHostSummary,
} from '../../../../../shared/execution-host'
import { distroOfUncPath } from '../../../../../shared/host-paths'
import type { AgentCliAvailabilityMap } from '../../../../../shared/electron-api'
import { useExecutionHosts } from '../../../hooks/useExecutionHosts'
import type { SshEnvironmentSummary } from '../../../../../shared/ssh-environments'
import { useSshMachines } from '../../settings/SshMachinesSection'
import { FolderIdentityIcon } from '../FolderIdentityIcon'
import { useProjectColor, useProjectColors } from '../../../hooks/useProjectColors'
import { projectColorKey, resolveProjectColor, type ProjectColor } from '../../../utils/projectColor'
import { resolveSkillMentionPrefix, renderSkillMention } from '../../../../../shared/skill-invocation'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import {
  dataTransferHasDroppableFiles,
  imageFilesFromDataTransfer,
  pastedImagePaths,
  pathsForPathlessFiles,
  quotePromptPath as quotePath,
  readFileAsBase64,
  readPastedImagePaths,
  sortDroppedFiles,
  sortFiles,
  type DroppedFiles,
} from '../../../utils/imageFileTransfer'
import { ComposerAttachmentStrip } from '../../panels/ComposerAttachmentStrip'
import { basename } from '../../../utils/paths'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import {
  CardButton,
  ChipButton,
  CloseIconButton,
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  HiddenFileInput,
  MachineGlyph,
  MENU_LIST_CLASS,
  Input,
  EmptyState,
  GhostButton,
  InlineSkillPicker,
  LinkButton,
  MenuOption,
  Popover,
  SendButton,
  SendGlyph,
  Textarea,
  StarGlyph,
  Tooltip,
  useCliPermissionMode,
  useCliPermissionPreset,
  type InlineSkillPickerHandle,
} from '../../ui'
import { AttachmentChip } from '../../ui/AttachmentChip'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import { MENU_GROUP_LABEL_CLASS } from '../../ui/menuClasses'
import type { MachineRef } from '../../../../../shared/machine-identity'
import { hostMachineRef, sshMachineRef, useMachineIdentity } from '../../../hooks/useMachineIdentity'
import { CliInstallCta } from '../cliInstallRoute'
import { menuRadioRowKeyDown } from './agentSpawnShared'
import { SpawnPermissionFooter } from './spawnFooter'
import { EnginePickerChip } from './enginePicker'
import { ProjectScopePicker } from './ProjectScopePicker'
import { remoteProjectOfWorkspace, remoteProjectsOf, type RemoteProject } from './remoteProjects'
import { type ProjectCloneRequest, type ProjectCloneResult } from './ProjectSourceMenu'
import { mergeDraftConnectors, readNewChatDraft, writeNewChatDraft, type NewChatDraftImage } from './newChatDraft'
import { showToast } from '../../../store/toastStore'
import { launchCommandLineKey, launchPreviewRequest, type LaunchCommandLineState } from './launchCommandLine'
import { drawSuggestions, newSuggestionSeed, type SuggestionEntry } from './suggestionBank'
import { WorktreeChip } from './WorktreeChip'
import { ScheduleFailureTray, ScheduleTag } from './schedule/SchedulePicker'
import { StartAsGlyph, startAsLabel, type StartAs } from './ComposerOptionsMenu'
import { ComposerPlusMenu } from './ComposerPlusMenu'
import { ComposerStrip } from './ComposerStrip'
import { FrontTruncatedText } from '../../ui/FrontTruncatedText'
import { ScheduledRuns } from './schedule/ScheduledRuns'
import type { ScheduledRunEntry } from '../../../utils/scheduledAgentRuns'
import { ExtensionNameChip } from './ExtensionNameChip'
import { EXTENSION_IDEAS, EXTENSION_IDEAS_FIRST, type ExtensionIdea } from './extensionIdeas'
import {
  EXTENSION_BUILDER_SKILL_ID,
  extensionIdProblem,
  type ExtensionScaffoldTargetState,
} from '../../../../../shared/extension-scaffold'
import { ScheduleSlashPicker, type ScheduleSlashPickerHandle } from './schedule/ScheduleSlashPicker'
import { localTimeZone } from './schedule/scheduleEditor'
import { rememberSchedule } from './schedule/recentSchedules'
import { selectModuleEnabled } from '../../../modules'
import {
  DEFAULT_SCHEDULED_AGENT_CRON,
  type ScheduledAgentDraft,
  type ScheduledAgentView,
} from '../../../../../shared/scheduled-agents'
import { CONVERSATION_DEFAULT_MODEL_ID, conversationProviderForCli } from '../../../../../shared/conversation-harness'
import {
  rowMatchesSelection,
  useAgentComposer,
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
} from './useAgentComposer'
import { clientSupports } from '../../../clientCapabilities'

export type NewAgentLaunch = AgentComposerConfirm & {
  /** The agent's startup prompt. Empty means "start with nothing typed". */
  prompt: string
  /**
   * The machine on this computer the new chat runs on (the door's dropdown):
   * absent where the surface offers no choice (the tab strip's "+", which
   * spawns into a workspace whose machine is already fixed).
   */
  hostId?: ExecutionHostId
  /**
   * Extension mode: the extension's name. The host makes `<project>/<id>` from
   * the SDK's template first, and the chat starts in that folder rather than
   * the project.
   */
  extension?: { id: string }
  /**
   * A chat on an SSH machine (phase 8): its label, and the folder on it the
   * chat runs in, as that machine spells it. A chat only: the machine's server
   * runs no terminals.
   */
  environment?: { kind: 'ssh'; id: string; label: string; folder: string }
}

/**
 * A chat on one side of the Windows ↔ WSL line in a folder on the other:
 * supported, never blocked (decisions R73 and R88), but every file its agents
 * touch crosses the line, which is much slower than either side's own disk.
 * One short line saying so, and which machine is fast, and nothing else.
 *
 *   - a WSL machine on a Windows drive: "On C: — slow from Ubuntu. Run on
 *     This PC for full speed." Shown only where the distribution's chats run
 *     on its Studio server (phase 7), so a machine whose switch is off sees
 *     New chat as it was;
 *   - This PC in a folder inside a distribution: "In Ubuntu — slow from
 *     Windows. Run on WSL: Ubuntu for full speed."
 */
export function slowFolderHint(
  hostId: ExecutionHostId,
  folder: string | null | undefined,
  chatServerOn: boolean,
): string | null {
  if (!folder) return null
  const distro = distroOfHostId(hostId)
  const drive = /^([A-Za-z]):[\\/]/u.exec(folder)
  if (distro && drive) {
    return chatServerOn ? `On ${drive[1].toUpperCase()}: — slow from ${distro}. Run on This PC for full speed.` : null
  }
  const folderDistro = hostId === LOCAL_HOST_ID ? distroOfUncPath(folder) : null
  if (folderDistro) return `In ${folderDistro} — slow from Windows. Run on WSL: ${folderDistro} for full speed.`
  return null
}

/** One choosable project scope: a folder some open workspace lives in. */
export type NewAgentProjectOption = { path: string; label: string }

export type NewAgentPanelProps = {
  workspaceId: string
  /** Development gate for the chat agent runtime. */
  conversationModeEnabled?: boolean
  /** False where the workspace cannot host a chat agent (a module's workspace type). */
  conversationWorkspaceSupported?: boolean
  forceSelection?: AgentComposerSelection | null
  /**
   * Where this launch lands when it is NOT the active workspace's own folder —
   * the New chat door, which creates a solo workspace in a project you pick. The
   * scope line becomes the picker when `projectOptions` come with it.
   */
  folderPath?: string | null
  projectOptions?: NewAgentProjectOption[]
  onSelectProject?: (path: string) => void
  /** Browse for a folder; `hostId` is the machine the dropdown stands on, so a WSL one opens in its home. */
  onBrowseProject?: (hostId?: ExecutionHostId) => void
  initialSelection: AgentComposerSelection
  /** The app-wide default a model row nobody has set still resolves to; the
   *  picker's footer writes per-row, so this is a fallback, never what it edits. */
  permissionPreset: CliPermissionPreset
  /** Host performs the spawn and retypes this tab into the agent's terminal. */
  onLaunch: (launch: NewAgentLaunch) => void
  /** MCP servers picked before the panel opened (a connector's own "New chat"); still removable. */
  initialMcpServers?: AgentComposerConnector[] | null
  /** Cancel. Nothing was created, so there is nothing else to undo. */
  onClose: () => void
  /**
   * Draw a close control on the surface itself. The tab host does not need one
   * — its tab has an `×` — but the New chat door has no tab, and without this
   * the surface has no way out at all.
   */
  showCloseButton?: boolean
  /**
   * Door-only (remote-sessions-ux / new-chat-on-a-remote-machine): start a
   * chat agent on a paired machine instead of this one. Present = the panel
   * offers the machine dropdown (This device first, paired machines after —
   * one dropdown, no separate Local/Remote switch; owner ruling 2026-09-03) and
   * routes a remote launch here instead of `onLaunch`.
   */
  onLaunchRemote?: (launch: RemoteNewChatLaunch) => Promise<void>
  /**
   * Door-only: clone a repository for the project selector's Import-from-Git
   * source. The HOST runs the clone so a finish after the selector closed
   * still adopts the project; absent, the panel clones for itself.
   */
  onCloneProject?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
  /**
   * Door-only (new-chat-survives-back-and-forward): the window's parked-draft
   * key. Present, the surface seeds its prompt, images, engine row, skills and
   * MCP picks from the draft parked under it and writes every change back, so
   * stepping off the door and back (Back/Forward, a sidebar click) loses
   * nothing. The HOST clears the draft when the chat starts or the panel is
   * closed on purpose; this surface only ever writes. The tab-strip host
   * passes none and keeps its per-tab state.
   */
  draftKey?: string
  /**
   * Door-only: open switched to Scheduled agent (the clock beside New chat).
   * The switch itself is offered wherever the door is and the Scheduled
   * agents module is on.
   */
  initialMode?: NewAgentPanelMode
  /**
   * Door-only: the scheduled agent this panel edits, opened from its row in
   * the sidebar's Scheduled section. The panel opens on its prompt, schedule, machine, engine, skills,
   * MCP servers and worktree, and its primary action saves rather than
   * creates. Absent, the panel creates.
   */
  editingScheduledAgent?: ScheduledAgentView | null
  /** Told once a scheduled agent was created or saved, with the record main returned. */
  onScheduled?: (agent: ScheduledAgentView) => void
  /** The edited scheduled agent's recent runs, newest first: the chats its runs started. */
  scheduledRuns?: readonly ScheduledRunEntry[]
  /** Open one of those runs' chats. */
  onOpenScheduledRun?: (workspaceId: string) => void
}

/**
 * What the door starts: a chat now, a scheduled agent that starts one each
 * time its schedule comes round, or an extension — a new project made inside
 * the chosen one, and a chat in it with the extension-builder skill.
 */
export type NewAgentPanelMode = 'chat' | 'scheduled' | 'extension'

/**
 * What a remote launch carries: the target, and the launch identity. It is
 * always a chat agent, which runs in that machine's conversation runtime and is
 * followed from here; terminals do not cross the tailnet.
 */
export type RemoteNewChatLaunch = {
  connectionId: string
  machineName: string
  remoteWorkspaceId: string
  remoteWorkspaceName: string
  /** The project's folder on that machine, as the gateway disclosed it. */
  remoteWorkspaceRoot: string | null
  prompt: string
  cli?: AgentCli
  cliModel?: string | null
  permissionPreset: CliPermissionPreset
  /** The branch the workspace's checkout is on over there, as the panel read it before the create. */
  branch: string | null
  /** Which repository the remote workspace is, as its machine served it (one-project-across-machines). */
  remoteRepository: RepositoryIdentity | null
}

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
type MachineBrowseEntry = 'loading' | { browse: MeshBrowse; at: number }
const MACHINE_BROWSE_HOLD_MS = 30_000

function browseOf(entry: MachineBrowseEntry | undefined): MeshBrowse | 'loading' | undefined {
  return entry === 'loading' || entry === undefined ? entry : entry.browse
}

function machineBrowseStale(entry: MachineBrowseEntry | undefined, now = Date.now()): boolean {
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

type RemoteTargetState = {
  connection: MeshConnection
  /** What `workspace.list` served: the machine's open CHATS, not its projects. */
  workspaces: MeshWorkspace[] | null
  /** Those chats folded into the folders they stand in — the list the chip offers. */
  projects: RemoteProject[] | null
  error: string | null
  picked: RemoteProject | null
  /** The picked project's checkout facts, for the branch the launch names; null until read, or unreadable. */
  checkout: MeshWorkspaceCheckout | null
}

// The machine picked last, for THIS session only (never persisted): reopening
// New chat keeps the target a person just used, while a fresh app start opens
// on This device — a remote is never preselected on first open.
let lastPickedMachineId: string | null = null
// The same, for a machine on this computer (a WSL distribution). Null follows
// the folder: a folder inside a distribution defaults to it, anything else
// here.
let lastPickedHostId: ExecutionHostId | null = null
// The SSH machine picked last, and the folder typed for each, for this session.
let lastPickedSshId: string | null = null
const lastSshFolders = new Map<string, string>()

/** Test seam: forget the session's remembered machine. */
export function resetRememberedMachineForTests(): void {
  lastPickedMachineId = null
  lastPickedHostId = null
  lastPickedSshId = null
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

// A scheduled agent keeps its skills by id and name; the composer's chips
// want the skill as the inventory lists it, and the id and name are what they
// show and what the run attaches.
function scheduledSkill(skill: { id: string; name: string }): WorkspaceSkill {
  return { id: skill.id, name: skill.name, source: 'custom', harnesses: [], installState: 'installed' }
}

// The skill an extension's chat opens with, as its chip shows it. Removing the
// chip is how the door goes back to a plain New chat.
const NO_SCHEDULED_RUNS: readonly ScheduledRunEntry[] = []

const EXTENSION_BUILDER_CHIP = scheduledSkill({ id: EXTENSION_BUILDER_SKILL_ID, name: 'extension-builder' })

// `/schedule` at the end of the prompt, and whatever follows it on that line.
const SCHEDULE_COMMAND = /(?:^|\s)\/schedule(?:[ \t]+([^\n]*))?$/u

/**
 * The launch surface: New chat, and the tab strip's "+".
 *
 * One composer, and nothing above it (owner ruling 2026-10-04): no mark, no
 * greeting, no switch between a chat and a scheduled agent. The box holds the
 * prompt and one row of quiet controls — the "+" that opens how the launch
 * starts and what it starts with, a tag beside it for each choice that is not
 * the default, the model, and a small round send. Tucked under the box, one
 * piece with it, is the context strip: the machine, the project, and the
 * worktree and branch, which say where the launch runs.
 *
 * Nothing here creates anything: `onLaunch` hands the host a confirm plus the
 * prompt, and the host retypes this tab into the agent's terminal.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationModeEnabled = true,
  conversationWorkspaceSupported = true,
  forceSelection,
  folderPath,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onLaunch,
  initialMcpServers,
  onClose,
  showCloseButton = false,
  onLaunchRemote,
  onCloneProject,
  draftKey,
  initialMode = 'chat',
  editingScheduledAgent = null,
  onScheduled,
  scheduledRuns = NO_SCHEDULED_RUNS,
  onOpenScheduledRun,
}: NewAgentPanelProps) {
  // The parked draft, read once at mount: what the door held when the person
  // last stepped off it. An explicit connector attachment leads the draft's
  // own picks (a connector "New chat" over a parked draft adds, never doubles).
  const [draft] = React.useState(() => (draftKey ? readNewChatDraft(draftKey) : null))
  // A scheduled agent being edited opens on everything it was made with, and
  // stays a scheduled agent: there is no switching it to a chat.
  const editing = editingScheduledAgent
  const [mode, setMode] = React.useState<NewAgentPanelMode>(editing ? 'scheduled' : initialMode)
  const extensionMode = mode === 'extension'
  const [cron, setCron] = React.useState(() => editing?.schedule.cron ?? DEFAULT_SCHEDULED_AGENT_CRON)
  // Written in this computer's zone: the scheduler runs here, on its clock.
  const [scheduleTimezone] = React.useState(() => editing?.schedule.timezone ?? localTimeZone())
  const scheduledAgentsEnabled = useWorkspaceStore((s) =>
    selectModuleEnabled(s.appSettings.modules, 'scheduled-agents'),
  )
  // The machines on THIS computer (this one, and the WSL distributions turned
  // on in Settings ▸ Machines). Offered only where a launch creates its
  // workspace — the door — because a workspace's machine is fixed once it
  // exists. One entry on macOS and Linux, which draws exactly what it drew.
  const hostChoosable = Boolean(onBrowseProject || onSelectProject)
  const { listing: hostListing } = useExecutionHosts()
  const localHosts: ExecutionHostSummary[] = hostChoosable ? (hostListing?.hosts ?? []) : []
  const [pickedHostId, setPickedHostId] = React.useState<ExecutionHostId | null>(() =>
    editing ? editing.hostId : lastPickedHostId,
  )
  const scopeFolder = folderPath !== undefined ? folderPath : null
  // The machine chosen in this door, and the folder it was chosen for. It
  // wins over the folder's own default (a folder inside Ubuntu on This PC, a
  // `C:\` folder on WSL) until the folder changes; a scheduled agent being
  // edited opens on the machine it was saved with.
  const [chosenHost, setChosenHost] = React.useState<{ hostId: ExecutionHostId; folder: string | null } | null>(() =>
    editing?.hostId ? { hostId: editing.hostId, folder: folderPath ?? null } : null,
  )
  // A remembered pick counts only while that machine is still offered: one
  // turned off in Settings, or gone from WSL, falls back to this machine
  // rather than launching somewhere the dropdown no longer shows.
  const stillOffered = (id: ExecutionHostId | null): boolean =>
    id === LOCAL_HOST_ID || (id !== null && localHosts.some((host) => host.id === id && host.state !== 'unavailable'))
  const chosenForFolder =
    chosenHost && chosenHost.folder === scopeFolder && stillOffered(chosenHost.hostId) ? chosenHost.hostId : null
  const hostId: ExecutionHostId = hostChoosable
    ? defaultNewChatHostId(scopeFolder, stillOffered(pickedHostId) ? pickedHostId : null, chosenForFolder)
    : LOCAL_HOST_ID
  const pickLocalHost = (next: ExecutionHostId): void => {
    const remembered = next === LOCAL_HOST_ID ? null : next
    lastPickedHostId = remembered
    setPickedHostId(remembered)
    setChosenHost({ hostId: next, folder: scopeFolder })
    pickSsh(null)
  }
  // SSH machines (phase 8): offered where a launch creates its workspace, as
  // the machines on this computer are. A chat there runs in a folder on that
  // machine, typed here; nothing on this computer is browsed for it.
  const { machines: sshMachinesAll } = useSshMachines(
    hostChoosable && window.api?.sshMachinesEnabled ? window.api : null,
  )
  const sshMachines = hostChoosable && !editing ? sshMachinesAll : []
  const [pickedSshId, setPickedSshId] = React.useState<string | null>(() => (editing ? null : lastPickedSshId))
  const pickedSsh = sshMachines.find((machine) => machine.id === pickedSshId) ?? null
  const [sshFolder, setSshFolder] = React.useState(() => (pickedSshId ? (lastSshFolders.get(pickedSshId) ?? '') : ''))
  const pickSsh = (id: string | null): void => {
    lastPickedSshId = id
    setPickedSshId(id)
    setSshFolder(id ? (lastSshFolders.get(id) ?? '') : '')
  }
  const sshFolderProblem =
    pickedSsh && !/^\/[^\0\n]*$/u.test(sshFolder.trim())
      ? `Type the folder's full path on ${pickedSsh.label}, such as /home/dev/repo.`
      : null
  // Which agent CLIs the chosen WSL machine has: its own probe, one process
  // for the lot, asked when the machine is picked — never on focus. This
  // machine's answer stays the store's, exactly as before.
  const hostSettings = useWorkspaceStore((s) => s.appSettings.hosts)
  const catalogIds = useWorkspaceStore((s) => s.pluginCatalogEntries.map((entry) => entry.id).join('\u0000'))
  const [hostAvailability, setHostAvailability] = React.useState<{
    hostId: ExecutionHostId
    map: AgentCliAvailabilityMap
    status: 'loading' | 'ready' | 'error'
  } | null>(null)
  React.useEffect(() => {
    if (!isWslHostId(hostId) || typeof window.api.pluginsDetectAvailability !== 'function') {
      setHostAvailability(null)
      return
    }
    let cancelled = false
    setHostAvailability({ hostId, map: {}, status: 'loading' })
    const commands = hostSettings?.[hostId]?.cliCommands ?? {}
    const cliRuntimes = Object.fromEntries(
      catalogIds
        .split('\u0000')
        .filter(Boolean)
        .map((cli) => [cli, { command: commands[cli] ?? '', hostId }]),
    )
    void window.api
      .pluginsDetectAvailability({ cliRuntimes })
      .then((result) => {
        if (cancelled) return
        setHostAvailability(
          result.ok ? { hostId, map: result.availability, status: 'ready' } : { hostId, map: {}, status: 'error' },
        )
      })
      .catch(() => {
        if (!cancelled) setHostAvailability({ hostId, map: {}, status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [hostId, hostSettings, catalogIds])
  const composer = useAgentComposer({
    ...(hostAvailability && hostAvailability.hostId === hostId
      ? { availability: { map: hostAvailability.map, status: hostAvailability.status } }
      : {}),
    showTerminal: true,
    conversationAvailable: conversationModeEnabled,
    // A scheduled agent's runs are chats: a terminal needs someone at it. An
    // extension is built in a chat too, with its skill attached.
    initialSelection:
      editing || initialMode === 'scheduled' || initialMode === 'extension'
        ? { kind: 'conversation' }
        : (forceSelection ?? draft?.selection ?? initialSelection),
    initialMcpServers: editing
      ? editing.mcpServers
      : draft
        ? mergeDraftConnectors(initialMcpServers, draft.mcpServers)
        : initialMcpServers,
    initialSkills: editing
      ? editing.skills.map(scheduledSkill)
      : initialMode === 'extension'
        ? [EXTENSION_BUILDER_CHIP]
        : draft?.skills,
    initialWorktreeName: editing ? (editing.worktree?.name ?? null) : null,
    // The engine a parked draft was made on, when whoever made it stored none —
    // a card's `Go` picker, which must not move this door's remembered engine
    // on its way past (item 2473). The panel opens standing on that row and
    // launches it; the first row picked here retires it.
    initialEngine: editing ? { cli: editing.cli, model: editing.cliModel, reasoning: null } : (draft?.engine ?? null),
  })
  const { selection } = composer
  const setLastNewChatAgent = useWorkspaceStore((s) => s.setLastNewChatAgent)
  const isChatLaunch = selection.kind === 'conversation'

  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  // An explicit scope wins: skills, the worktree probe and the scope line all
  // have to describe the folder the agent will actually run in.
  const workspaceRoot = folderPath !== undefined ? folderPath : activeWorkspaceRoot
  const driveAdvisory = slowFolderHint(
    hostId,
    workspaceRoot,
    hostListing?.hosts.some((host) => host.id === hostId && host.chatServer?.on === true) ?? false,
  )
  // Picks were installed and synced into ONE project; a change of project
  // after picking would launch the agent somewhere they are not.
  const pickedForRoot = React.useRef(workspaceRoot)
  React.useEffect(() => {
    if (pickedForRoot.current === workspaceRoot) return
    pickedForRoot.current = workspaceRoot
    // The builder skill is not a pick: the scaffold puts it in the new
    // project, wherever that is, so it stays with the extension.
    composer.setSkills(extensionMode ? [EXTENSION_BUILDER_CHIP] : [])
    composer.setMcpServers([])
  }, [composer, extensionMode, workspaceRoot])
  // Removing the builder chip is leaving extension mode: the door is a plain
  // New chat again, with the project it was on.
  const builderAttached = composer.skills.some((skill) => skill.id === EXTENSION_BUILDER_SKILL_ID)
  React.useEffect(() => {
    if (extensionMode && !builderAttached) setMode('chat')
  }, [builderAttached, extensionMode])
  // The PROJECT, not the workspace: a solo-chat workspace is called things like
  // "new chat panel", which says nothing about where the agent will run. The
  // folder it opens in is the fact worth showing, so a wrong-project spawn is
  // visible before it happens.
  const projectLabel = React.useMemo(() => {
    const folder = workspaceRoot?.trim()
    if (!folder) return null
    return projectOptions?.find((option) => option.path === folder)?.label ?? basename(folder) ?? folder
  }, [projectOptions, workspaceRoot])
  // Can this surface change where the agent runs? True when the host gave us
  // any way to — a folder browser, or projects to switch between. Deliberately
  // NOT a function of whether a project is currently chosen: see the scope line
  // below for why that inversion is the bug this replaces.
  const canChooseProject =
    Boolean(onBrowseProject) || Boolean(onSelectProject && projectOptions && projectOptions.length > 0)
  // The machine dimension (remote-sessions-ux / new-chat-on-a-remote-machine).
  // One dropdown: This device is the default entry, paired machines follow. A
  // remote target swaps the project choice for the machine's own workspaces
  // (fetched over the audited mesh client) and routes the launch remotely.
  // What runs there is always a chat agent, in that machine's own conversation
  // runtime, followed from here: terminals do not cross the tailnet, so a
  // terminal agent or a bare terminal is this machine's only. Picking a machine
  // turns the launch into a chat; picking Agent or Terminal after that returns
  // it to This device rather than lying about where it would run.
  const [remoteMachines, setRemoteMachines] = React.useState<MeshConnection[]>([])
  const [remoteTarget, setRemoteTarget] = React.useState<RemoteTargetState | null>(null)
  // What each paired machine holds, read once per machine per door open
  // (one-project-across-machines): the machine dropdown says which machines
  // have the project in hand, and a pick that keeps the project reads its
  // workspace off this rather than asking the machine again.
  const [machineBrowses, setMachineBrowses] = React.useState<Map<string, MachineBrowseEntry>>(() => new Map())
  const browseMachine = React.useCallback((connection: MeshConnection): Promise<MeshBrowse> => {
    setMachineBrowses((current) => {
      const existing = current.get(connection.id)
      return existing && existing !== 'loading' ? current : new Map(current).set(connection.id, 'loading')
    })
    return window.api
      .meshBrowse(connection.id)
      .then((browse) => {
        setMachineBrowses((current) => new Map(current).set(connection.id, { browse, at: Date.now() }))
        return browse
      })
      .catch((error: unknown) => {
        const failed: MeshBrowse = {
          connectionId: connection.id,
          reachable: false,
          unreachableReason: error instanceof Error ? error.message : String(error),
          unauthorized: false,
          scopes: connection.scopes,
          workspaces: [],
          gaps: [],
        }
        setMachineBrowses((current) => new Map(current).set(connection.id, { browse: failed, at: Date.now() }))
        return failed
      })
  }, [])
  // The identity in hand, readable at the moment a browse RESOLVES rather
  // than when the pick was made: the remembered machine is picked as soon as
  // the machine list arrives, usually before the local folder's identity has
  // been read, and a `keep` captured then would be null.
  const activeIdentityRef = React.useRef<RepositoryIdentity | null>(null)
  // One launch at a time: the remote create waits on a real CLI starting on
  // another machine, and a second Enter during that window must read as
  // "starting", never as a second agent.
  const [remoteLaunching, setRemoteLaunching] = React.useState(false)
  const remoteCapable = Boolean(onLaunchRemote)
  // The remembered machine is applied once, when the list first arrives.
  const rememberedApplied = React.useRef(false)
  React.useEffect(() => {
    if (!remoteCapable) return
    let cancelled = false
    const load = (): void => {
      void window.api
        .meshListConnections()
        .then((connections) => {
          if (cancelled) return
          const sorted = sortMachines(connections)
          setRemoteMachines(sorted)
          if (!rememberedApplied.current) {
            rememberedApplied.current = true
            const remembered = lastPickedMachineId ? sorted.find((machine) => machine.id === lastPickedMachineId) : null
            if (remembered) pickRemoteMachineRef.current(remembered)
          }
        })
        .catch(() => {})
    }
    load()
    // A machine paired or forgotten while the door is open shows up live.
    const unsubscribe =
      typeof window.api.onMeshEvent === 'function'
        ? window.api.onMeshEvent((event) => {
            if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') load()
          })
        : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [remoteCapable])
  // Chat agent is offered only where the workspace can host one; without it
  // there is nothing a paired machine could run for this launch.
  const chatAvailable =
    conversationWorkspaceSupported && composer.visibleRows.some((row) => row.kind === 'conversation')
  const remoteSelectable = remoteCapable && chatAvailable && selection.kind !== 'terminal'
  // Scheduling is the door's, and needs a chat to start: a run happens with
  // nobody at it, which a terminal cannot do.
  const scheduleOffered = hostChoosable && scheduledAgentsEnabled && chatAvailable && !extensionMode
  const scheduled = mode === 'scheduled' && (scheduleOffered || editing !== null)
  // Both run as a chat: a scheduled agent's runs have nobody at them, and an
  // extension is built with its skill in a conversation.
  const chatOnly = scheduled || extensionMode
  React.useEffect(() => {
    if (chatOnly && composer.selection.kind !== 'conversation') composer.setSelection({ kind: 'conversation' })
  }, [composer, chatOnly])
  // An extension is made on this computer: the scaffold writes to its disk.
  const remoteChosenAway = !remoteSelectable || selection.kind !== 'conversation' || chatOnly
  React.useEffect(() => {
    if (remoteChosenAway) setRemoteTarget(null)
  }, [remoteChosenAway])
  // A scheduled agent runs on this computer, so the machine list drops the SSH
  // machines while scheduling; one picked before must go with them, or the
  // strip would keep asking for a folder on that machine while the agent is
  // saved for the project here.
  const sshPickedWhileScheduled = scheduled && pickedSshId !== null
  React.useEffect(() => {
    if (sshPickedWhileScheduled) pickSsh(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sshPickedWhileScheduled])
  // The project in hand, as an identity the next machine can be searched for:
  // the local folder's repository, or the remote project's as its machine
  // served it. Null when nothing is chosen or the folder has no remote.
  const localIdentities = useFolderRepositoryIdentities(
    React.useMemo(
      () => [workspaceRoot, ...(projectOptions ?? []).map((option) => option.path)],
      [projectOptions, workspaceRoot],
    ),
  )
  const localIdentity = workspaceRoot ? (localIdentities.get(folderIdentityKey(workspaceRoot)) ?? null) : null
  const activeIdentity: RepositoryIdentity | null = remoteTarget
    ? (remoteTarget.picked?.repository ?? null)
    : localIdentity
  activeIdentityRef.current = activeIdentity
  // The colour the scope line wears (owner ruling 2026-09-09, backlog item
  // `one-colour-per-project-on-the-folder-glyph`, decision 7). The owner's
  // words were "I keep opening up a new chat and forgetting to pick the
  // project", so the point of the hue here is not decoration: it is that a
  // chosen project and no project stop looking alike.
  //
  // The key is the project's, not the folder's or the machine's — decision 3, a
  // project is a repository. So the local scope resolves through the folder's
  // repository identity and a picked remote project through the one its machine
  // served, and the same repository on two machines therefore lands on ONE key
  // and one hue. The machine is a glyph on this line, never a second colour.
  //
  // A remote project with NO identity has no key at all, and deliberately does
  // not fall back to its path the way a local folder does. That path is a path
  // on ANOTHER machine's disk and says nothing about which repository it holds,
  // so a colour derived from it could disagree with this disk's clone of the
  // same repository — one project in two colours, the exact failure decision 3
  // exists to prevent. An older peer that does not report identities and a
  // folder that is not a repository both arrive here with `repository: null`,
  // and both get the plain glyph instead.
  const remotePicked = remoteTarget?.picked ?? null
  const scopeProjectKey = remoteTarget
    ? remotePicked?.repository
      ? projectColorKey({ folderPath: null, repository: remotePicked.repository })
      : null
    : projectColorKey({ folderPath: workspaceRoot, repository: localIdentity })
  // The hue waits for the folder's identity to be READ. A folder with a remote
  // keys as `repo:…` and one without as `folder:…`, and the hue is hashed from
  // the key, so painting while the read is in flight would show the folder's
  // hue and then the repository's. The identities hook says "not asked yet" by
  // absence and "asked, and no remote" by a stored null, so absence is
  // precisely the thing to wait on. Until then the glyph is plain, which is
  // what an unknown project should look like anyway.
  //
  // A remote target needs no such wait: its key is a repository key or nothing,
  // and both are settled the moment the machine answered.
  const localIdentityRead = !workspaceRoot?.trim() || localIdentities.has(folderIdentityKey(workspaceRoot))
  const scopeProjectColor = useProjectColor(remoteTarget || localIdentityRead ? scopeProjectKey : null)
  const pickRemoteMachine = (
    connection: MeshConnection | null,
    keep: RepositoryIdentity | null = activeIdentity,
  ): void => {
    lastPickedMachineId = connection?.id ?? null
    if (!connection) {
      // Back to This device with a project in hand: keep it when a local clone
      // of the same repository is open here (changing the machine keeps the
      // project when it exists there); otherwise the line returns
      // to the folder it was scoped to before, as it always did. The folder
      // the door is already scoped to wins when it is that repository.
      const scopedIsTwin = Boolean(
        keep && workspaceRoot && sameRepository(localIdentities.get(folderIdentityKey(workspaceRoot)), keep),
      )
      const twin =
        keep && !scopedIsTwin
          ? (projectOptions ?? []).find((option) =>
              sameRepository(localIdentities.get(folderIdentityKey(option.path)), keep),
            )
          : null
      if (twin && onSelectProject && twin.path !== workspaceRoot) onSelectProject(twin.path)
      setRemoteTarget(null)
      return
    }
    // A paired machine runs chat agents only, so choosing one is choosing a
    // chat — and where no chat can be hosted, there is nothing to choose.
    if (!chatAvailable) return
    if (composer.selection.kind !== 'conversation') composer.setSelection({ kind: 'conversation' })
    setRemoteTarget({
      connection,
      workspaces: null,
      projects: null,
      error: null,
      picked: null,
      checkout: null,
    })
    void browseMachine(connection).then((browse) => {
      setRemoteTarget((current) => {
        if (current?.connection.id !== connection.id) return current
        if (!browse.reachable) {
          return {
            ...current,
            workspaces: [],
            projects: [],
            error: browse.unreachableReason ?? 'That machine is not answering.',
          }
        }
        if (browse.unauthorized) {
          return {
            ...current,
            workspaces: [],
            projects: [],
            error: 'That machine refused this pairing — re-pair from Settings → Remote.',
          }
        }
        // A gap is a DIFFERENT statement from an empty list: a pairing
        // without workspace:read genuinely cannot list workspaces, and
        // "no workspaces on that machine" would be false (the MeshGap
        // contract). Say the real reason instead.
        const workspaceGap = browse.gaps.find((gap) => gap.part === 'workspaces')
        if (browse.workspaces.length === 0 && workspaceGap) {
          return { ...current, workspaces: [], projects: [], error: workspaceGap.message }
        }
        // The machine's chats folded into the folders they stand in
        // (`remoteProjects`). What `workspace.list` serves is one entry per
        // open CONVERSATION over there, and this chip is choosing a project
        // — so three chats in one checkout are one row, not three.
        const projects = remoteProjectsOf(browse.workspaces)
        // An explicit choice, not the first row: a project picked by list
        // order is a launch into the wrong repo waiting to happen. Two
        // exceptions: a machine with exactly one project, where there is
        // nothing to choose, and the machine's copy of the project already
        // in hand (one-project-across-machines) — switching the machine
        // keeps the project.
        const copy = machineCopyOf(browse, keep ?? activeIdentityRef.current)
        const kept = copy ? remoteProjectOfWorkspace(projects, browse.workspaces, copy.id) : null
        return {
          ...current,
          workspaces: browse.workspaces,
          projects,
          // A choice already made meanwhile is never overwritten by a late answer.
          picked: current.picked ?? kept ?? (projects.length === 1 ? projects[0]! : null),
        }
      })
    })
  }
  const pickRemoteMachineRef = React.useRef(pickRemoteMachine)
  pickRemoteMachineRef.current = pickRemoteMachine
  // The picked project's checkout facts (checkout-and-branch-on-remote-create),
  // read over `workspace.checkout` the moment a project is chosen — keyed on
  // the machine and the project, so a re-pick re-reads and a browse settling
  // does not. A refusal (a read-only pairing, a machine gone quiet) leaves the
  // branch unnamed rather than guessed.
  const remoteConnectionId = remoteTarget?.connection.id ?? null
  // `workspace.checkout` is keyed by workspace id, and a project's seat is one
  // of the chats standing in it — every chat in a folder answers for the folder.
  const remotePickedId = remoteTarget?.picked?.workspaceId ?? null
  React.useEffect(() => {
    if (!remoteConnectionId || !remotePickedId) return
    let cancelled = false
    void window.api
      .meshWorkspaceCheckout(remoteConnectionId, remotePickedId)
      .then((result) => {
        if (cancelled) return
        setRemoteTarget((current) => {
          if (current?.connection.id !== remoteConnectionId || current.picked?.workspaceId !== remotePickedId)
            return current
          return { ...current, checkout: result.ok ? result.checkout : null }
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [remoteConnectionId, remotePickedId])
  const activeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.branch ?? null) : null
  })
  // A branch belongs to the workspace's own checkout; a chat scoped to another
  // project is not on it, and printing it there would be a lie.
  const branch = folderPath !== undefined && folderPath !== activeWorkspaceRoot ? null : activeBranch
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)

  const [prompt, setPrompt] = React.useState(() => editing?.prompt ?? draft?.prompt ?? '')
  const [enginePopoverOpen, setEnginePopoverOpen] = React.useState(false)
  // The hidden file input the "+" menu's Attach files row clicks. The menu
  // and the skills picker it opens over the same "+" are `ComposerPlusMenu`.
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [workspaceIsGitRepo, setWorkspaceIsGitRepo] = React.useState(false)
  const [seed] = React.useState(() => newSuggestionSeed())
  const promptRef = React.useRef<HTMLTextAreaElement>(null)

  // ── Images pasted or dropped into the prompt box ──────────────────────────
  // The prompt becomes text — retyped into a CLI agent's terminal, or a
  // conversation's first message — so an image travels as a file path the agent
  // opens itself, the same shape as a drop onto a running terminal. A file
  // dropped from the OS already has a path; a pasted screenshot (or an image
  // dragged out of a browser) exists only as bytes and is saved to a temp file
  // first. Either way the box shows the image, not the path: the thumbnail is
  // the attachment, and its path joins the prompt only at launch.
  const [dropActive, setDropActive] = React.useState(false)
  const dragDepthRef = React.useRef(0)
  const [attachNote, setAttachNote] = React.useState<string | null>(null)
  const [images, setImages] = React.useState<PromptImage[]>(() => draft?.images ?? [])
  const [attachingCount, setAttachingCount] = React.useState(0)

  // Write-through to the parked draft: every change the person makes is safe
  // the moment it is made, so an unmount from any direction loses nothing.
  React.useEffect(() => {
    if (!draftKey) return
    writeNewChatDraft(draftKey, {
      prompt,
      images,
      selection,
      // Written back as it stands, which is null from the moment the person
      // picks an engine of their own: parking a retired one would reinstate it
      // on the next visit.
      engine: composer.openingEngine,
      skills: composer.skills,
      mcpServers: composer.mcpServers,
    })
  }, [draftKey, prompt, images, selection, composer.openingEngine, composer.skills, composer.mcpServers])

  const insertPromptPath = (dropped: string) => {
    // A file from the SSH machine this chat starts on is typed as that
    // machine spells it: the agent runs there, not on this computer.
    const onMachine = pickedSsh ? parseMachinePath(dropped) : null
    const path = onMachine && onMachine.id === pickedSsh?.id ? onMachine.path : dropped
    setPrompt((current) =>
      current.length === 0 || /\s$/.test(current) ? `${current}${quotePath(path)} ` : `${current} ${quotePath(path)} `,
    )
    promptRef.current?.focus()
  }

  // A drop, whatever it carries: every file with a path is typed as its path,
  // the way a drop onto a terminal would be; images attach; a file with no path
  // is uploaded where the shell can (a browser) and typed as the server's path,
  // and is otherwise refused with a message rather than swallowed. Files picked
  // through "Attach files" are taken the same way.
  const dropFiles = (data: DataTransfer) => takeFiles(sortDroppedFiles(data, true))
  const takeFiles = ({ paths, images, pathless }: DroppedFiles) => {
    for (const path of paths) insertPromptPath(path)
    if (images.length > 0) void attachDroppedFiles(images)
    else setAttachNote(null)
    // No path here: a browser uploads them and types the server's paths.
    if (pathless.length > 0)
      void pathsForPathlessFiles(pathless).then(({ paths: uploaded, message }) => {
        for (const path of uploaded) insertPromptPath(path)
        if (message && images.length === 0) setAttachNote(message)
      })
    promptRef.current?.focus()
  }

  const attachDroppedFiles = async (files: File[]) => {
    setAttachNote(null)
    for (const file of files) {
      const existingPath = window.api.getPathForFile(file)
      setAttachingCount((count) => count + 1)
      try {
        const { mediaType, dataBase64 } = await readFileAsBase64(file)
        const path = existingPath || (await window.api.saveDroppedImage({ mediaType, dataBase64 }))
        setImages((current) => [
          ...current,
          {
            id: `${Date.now()}-${current.length}-${file.name}`,
            mediaType,
            dataBase64,
            byteLength: file.size,
            ...(file.name ? { name: file.name } : {}),
            path,
          },
        ])
      } catch (error) {
        // Shown verbatim under the box.
        setAttachNote(error instanceof Error ? error.message : 'Could not attach that image.')
      } finally {
        setAttachingCount((count) => count - 1)
      }
    }
    promptRef.current?.focus()
  }

  // A paste that is only paths to images outside the project attaches those
  // images, read now: the file may be a screenshot's temporary copy the system
  // clears minutes later, and the copy saved here is the one the prompt names
  // at launch. One that cannot be read goes back in as the text it was, with
  // the reason.
  const attachPastedPaths = async (paths: string[], text: string, selectionStart: number, selectionEnd: number) => {
    setAttachNote(null)
    setAttachingCount((count) => count + paths.length)
    let read: Awaited<ReturnType<typeof readPastedImagePaths>>
    try {
      read = await readPastedImagePaths(paths)
    } finally {
      setAttachingCount((count) => count - paths.length)
    }
    if (read.ok) {
      await attachDroppedFiles(read.files)
      return
    }
    setPrompt((current) => current.slice(0, selectionStart) + text + current.slice(selectionEnd))
    setAttachNote(read.message)
    promptRef.current?.focus()
  }

  const removeImage = (id: string) => setImages((current) => current.filter((image) => image.id !== id))

  // A plain shell launches no CLI, so it wears no CLI chip. A chat agent is a
  // CLI too — the same one, driven as a chat — so it wears the same chip and
  // opens the same picker, with the rail narrowed to the CLIs that have a chat
  // runtime (`composer.optionsFor`).
  const launchCli: AgentCli | null = selection.kind === 'terminal' ? null : composer.selectionCli
  const pickerOptions = composer.optionsFor(selection)
  // No installed CLI can run as a chat: the Chat agent choice has nothing to
  // start, and says so with the install route rather than a dead chip.
  const chatUnavailable = isChatLaunch && composer.catalogStatus === 'ready' && pickerOptions.length === 0
  // Only a terminal launch runs a command line, so only it has one to preview.
  const commandCli: AgentCli | null = selection.kind === 'general' ? launchCli : null
  const engineNames = composer.engineNamesFor(selection)
  const model = launchCli ? composer.modelForSelection(selection, launchCli) : undefined
  const reasoning = launchCli ? composer.reasoningForSelection(selection, launchCli) : undefined
  // Permissions are a property of the CLI (owner ruling 2026-09-24): the preset
  // this launch runs on is the one stored for the picked runtime, whichever of
  // its models is picked, and the host's `permissionPreset` is only the
  // app-wide default a CLI nobody has set still resolves to. A terminal or a
  // conversation has no CLI and no permission flag, so it simply reads the
  // fallback and shows no control.
  //
  // A remote machine takes the same preset (owner ruling 2026-09-27: every
  // surface may spawn in bypass), and it travels explicitly, so the agent over
  // there runs on the choice this launcher shows rather than on that machine's
  // own default. Everything the surface says about permissions — the chip, the
  // command-line preview, what the launch carries — reads THIS, never the prop.
  const effectivePreset = useCliPermissionPreset(launchCli, permissionPreset)
  // The CLI's own mode chosen beside it (Claude Code's Accept edits), which the
  // preview renders. A scheduled agent and a launch on another machine carry
  // the preset alone, and run its own mode.
  const effectiveMode = useCliPermissionMode(launchCli)

  // ── The skill trigger ────────────────────────────────────────────────────
  // A chat carries skills as attachments rather than a typed invocation, so the
  // CLI's mention syntax is a terminal launch's alone.
  const skillIntegration = React.useMemo(() => {
    if (!commandCli) return undefined
    return pluginCatalogEntries.find((entry) => entry.id === commandCli)?.skillIntegration
  }, [commandCli, pluginCatalogEntries])
  const mentionPrefix = resolveSkillMentionPrefix(skillIntegration)

  // `/schedule every weekday at 9`: the schedule said where the cursor is.
  // Offered wherever scheduling is, from a chat launch too — picking a
  // schedule is what switches the door to Scheduled agent.
  const [slashDismissed, setSlashDismissed] = React.useState(false)
  const slashRef = React.useRef<ScheduleSlashPickerHandle | null>(null)
  const slashQuery = React.useMemo(() => {
    if (!scheduleOffered || editing || slashDismissed) return null
    const match = SCHEDULE_COMMAND.exec(prompt)
    return match ? (match[1] ?? '') : null
  }, [editing, prompt, scheduleOffered, slashDismissed])
  // A dismissal holds for that `/schedule`, not for the next one typed.
  React.useEffect(() => {
    if (slashDismissed && !SCHEDULE_COMMAND.test(prompt)) setSlashDismissed(false)
  }, [prompt, slashDismissed])
  const applySlashSchedule = React.useCallback((picked: { cron: string }) => {
    setPrompt((current) => current.replace(SCHEDULE_COMMAND, '').trimEnd())
    setMode('scheduled')
    setCron(picked.cron)
    promptRef.current?.focus()
  }, [])

  const [mentionDismissed, setMentionDismissed] = React.useState(false)
  const mentionRef = React.useRef<InlineSkillPickerHandle | null>(null)
  const mentionQuery = React.useMemo(() => {
    if (!mentionPrefix || mentionDismissed || slashQuery !== null) return null
    const match = new RegExp(`(?:^|\\s)\\${mentionPrefix}([^\\s]*)$`).exec(prompt)
    return match ? match[1] : null
  }, [mentionDismissed, mentionPrefix, prompt, slashQuery])

  const applySkillMention = (skill: WorkspaceSkill) => {
    const mention = renderSkillMention(skillIntegration, skill.id)
    if (!mention || !mentionPrefix) return
    setPrompt((current) => current.replace(new RegExp(`\\${mentionPrefix}[^\\s]*$`), `${mention} `))
    setMentionDismissed(true)
    promptRef.current?.focus()
  }

  // Switching CLIs re-renders mentions already typed in the new one's form.
  const previousPrefix = React.useRef(mentionPrefix)
  React.useEffect(() => {
    const before = previousPrefix.current
    previousPrefix.current = mentionPrefix
    if (!before || !mentionPrefix || before === mentionPrefix) return
    setPrompt((current) =>
      current.replace(new RegExp(`(^|\\s)\\${before}([A-Za-z0-9._-]+)`, 'g'), `$1${mentionPrefix}$2`),
    )
  }, [mentionPrefix])

  // Worktree is offered only inside a git repo: absent, not disabled.
  React.useEffect(() => {
    let cancelled = false
    if (!workspaceRoot) {
      setWorkspaceIsGitRepo(false)
      return
    }
    void window.api
      .getGitRepoRoot(workspaceRoot)
      .then((root) => {
        if (!cancelled) setWorkspaceIsGitRepo(Boolean(root))
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIsGitRepo(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceRoot])

  // ── What a launch would run, for Start's hover ───────────────────────────
  const [commandLine, setCommandLine] = React.useState<LaunchCommandLineState>({ status: 'idle' })
  const previewInput = React.useMemo(
    () => ({
      cli: commandCli,
      model,
      reasoning,
      permissionPreset: effectivePreset,
      ...(effectiveMode ? { permissionMode: effectiveMode } : {}),
      runtime: commandCli
        ? isWslHostId(hostId)
          ? { command: hostSettings?.[hostId]?.cliCommands[commandCli] ?? '', hostId }
          : cliRuntimes?.[commandCli]
        : undefined,
    }),
    [cliRuntimes, commandCli, effectiveMode, effectivePreset, hostId, hostSettings, model, reasoning],
  )
  const previewKey = launchCommandLineKey(previewInput)
  React.useEffect(() => {
    const request = launchPreviewRequest(previewInput)
    if (!request) {
      setCommandLine({ status: 'idle' })
      return
    }
    let cancelled = false
    void window.api
      .agentLaunchPreview(request)
      .then((result) => {
        if (cancelled) return
        setCommandLine(
          result.ok ? { status: 'ready', preview: result.preview } : { status: 'error', message: result.message },
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setCommandLine({
          status: 'error',
          message: error instanceof Error ? error.message : 'Could not read this agent’s launch command.',
        })
      })
    return () => {
      cancelled = true
    }
    // previewKey is previewInput's identity; the object would re-run every render.
  }, [previewKey])

  const suggestions = React.useMemo(() => drawSuggestions(seed), [seed])

  // ── Extension ─────────────────────────────────────────────────────────────
  // The name is the folder made inside the project and the module id. What is
  // at `<project>/<name>` is asked as it is typed, so a name already taken by
  // something else is said before the press: an empty folder is filled, an
  // extension there is carried on, anything else is never written over.
  const [extensionName, setExtensionName] = React.useState('')
  const [allIdeas, setAllIdeas] = React.useState(false)
  const extensionNameProblem = extensionName === '' ? null : extensionIdProblem(extensionName)
  const [extensionTarget, setExtensionTarget] = React.useState<{
    key: string
    state: ExtensionScaffoldTargetState
  } | null>(null)
  const extensionTargetKey =
    extensionMode && workspaceRoot && extensionName && !extensionNameProblem
      ? `${workspaceRoot}\u0000${extensionName}`
      : null
  React.useEffect(() => {
    if (!extensionTargetKey || !workspaceRoot || typeof window.api.extensionScaffoldTarget !== 'function') return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.api
        .extensionScaffoldTarget({ parentDir: workspaceRoot, id: extensionName })
        .then((target) => {
          if (!cancelled && target) setExtensionTarget({ key: extensionTargetKey, state: target.state })
        })
        .catch(() => undefined)
    }, 150)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // extensionTargetKey is (workspaceRoot, extensionName); listing them too would ask twice.
  }, [extensionTargetKey])
  const extensionTargetState = extensionTarget?.key === extensionTargetKey ? extensionTarget.state : null
  const extensionNote = extensionNameProblem
    ? extensionNameProblem
    : extensionTargetState === 'taken'
      ? `${projectLabel ?? 'The project'} already has a ${extensionName} folder. Choose another name.`
      : extensionTargetState === 'no_parent'
        ? 'That project folder is not there any more. Choose another project.'
        : null
  // Everything the extension needs before ⏎: a project to make it in, a name
  // that is free (or an extension to carry on), and something to build.
  const extensionReady =
    !extensionMode ||
    (Boolean(workspaceRoot?.trim()) &&
      extensionName !== '' &&
      !extensionNameProblem &&
      (extensionTargetState === 'free' || extensionTargetState === 'extension') &&
      prompt.trim() !== '')
  const pickIdea = (idea: ExtensionIdea): void => {
    setPrompt(idea.prompt)
    window.requestAnimationFrame(() => {
      const field = promptRef.current
      if (!field) return
      field.focus()
      field.setSelectionRange(idea.prompt.length, idea.prompt.length)
    })
  }
  // Every chat runtime runs on a WSL machine as well as on this one, so the
  // machine never keeps a chat from starting (owner ruling 2026-10-01).
  const canLaunch =
    composer.visibleRows.some((row) => rowMatchesSelection(row, selection)) &&
    (!isChatLaunch || (conversationWorkspaceSupported && pickerOptions.length > 0))

  // ── Scheduling ────────────────────────────────────────────────────────────
  // What a scheduled agent is made of is exactly what this launch would start
  // now — the machine, project, CLI, model, preset, skills, MCP servers and
  // worktree on screen — plus the schedule in the tray. Main owns the list;
  // the door closes on the card it lands as.
  const [scheduleBusy, setScheduleBusy] = React.useState(false)
  // Why the last run did not start, until the person has seen it here.
  const [lastRunFailure, setLastRunFailure] = React.useState<string | null>(() =>
    editing?.lastRun && !editing.lastRun.ok && (editing.lastFailureSeenAt ?? 0) < editing.lastRun.at
      ? editing.lastRun.message
      : null,
  )
  const editingId = editing?.id ?? null
  React.useEffect(() => {
    if (editingId && lastRunFailure) void window.api.markScheduledAgentFailureSeen(editingId).catch(() => {})
    // Once, on open: seeing it here is what the card's "Failed" was waiting for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const schedule = async (text: string) => {
    if (!canLaunch || scheduleBusy) return
    const folder = workspaceRoot?.trim()
    if (!folder) {
      showToast({
        tone: 'warn',
        title: 'Choose a project',
        description: 'A scheduled agent starts its chats in a project.',
      })
      return
    }
    const body = [text.trim(), ...images.map((image) => quotePath(image.path))].filter(Boolean).join(' ')
    if (!body) {
      showToast({
        tone: 'warn',
        title: 'Say what it should do',
        description: 'Each run starts with this prompt, so a scheduled agent needs one.',
      })
      promptRef.current?.focus()
      return
    }
    const confirm = composer.buildConfirm(selection)
    if (confirm.kind !== 'conversation' || !confirm.cli) return
    const draftRecord: ScheduledAgentDraft = {
      prompt: body,
      schedule: { cron, timezone: scheduleTimezone },
      folderPath: folder,
      // This PC is kept only where the folder would say otherwise.
      hostId: hostIdToRecord(hostId, folder) ?? null,
      cli: confirm.cli,
      cliModel: confirm.model ?? null,
      // The preset this launcher shows, recorded, so each run is the launch
      // the person saw rather than whatever the default is by then.
      permissionPreset: effectivePreset,
      skills: (confirm.skills ?? []).map((skill) => ({ id: skill.id, name: skill.name })),
      mcpServers: composer.mcpServers.map((server) => ({ id: server.id, name: server.name })),
      worktree: confirm.worktree ? { name: confirm.worktree.name } : null,
    }
    setScheduleBusy(true)
    try {
      const result = editing
        ? await window.api.updateScheduledAgent(editing.id, draftRecord)
        : await window.api.createScheduledAgent(draftRecord)
      if (!result.ok) {
        showToast({ tone: 'error', title: editing ? 'Not saved' : 'Not scheduled', description: result.message })
        return
      }
      rememberSchedule(cron)
      onScheduled?.(result.agent)
    } catch (error) {
      showToast({
        tone: 'error',
        title: editing ? 'Not saved' : 'Not scheduled',
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setScheduleBusy(false)
    }
  }

  // Run now starts what is saved, not what is on screen: an unsaved edit is
  // still a question, and a run is an answer.
  const runSavedNow = async () => {
    if (!editing) return
    const result = await window.api.runScheduledAgentNow(editing.id).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : String(error),
    }))
    if (!result.ok) {
      showToast({ tone: 'error', title: 'Did not run', description: result.message })
    } else if (!result.run.ok) {
      setLastRunFailure(result.run.message)
    } else {
      setLastRunFailure(null)
      // The run is a chat of its own, started in the background as every run
      // is, so the window stays on this editor; it lands first under Recent
      // runs below as soon as this window hears of it — the place to open it.
      showToast({ tone: 'good', title: 'Started', description: 'Its chat is first under Recent runs, below.' })
    }
  }

  const launch = (text: string) => {
    if (!canLaunch || !extensionReady) return
    if (scheduled) {
      void schedule(text)
      return
    }
    if (pickedSsh) {
      if (sshFolderProblem) {
        showToast({ tone: 'warn', title: 'Which folder?', description: sshFolderProblem })
        return
      }
      const confirm = composer.buildConfirm(selection)
      if (confirm.kind === 'conversation') {
        const providerId = confirm.cli ? conversationProviderForCli(confirm.cli) : null
        if (!providerId) return
        confirm.provider = {
          providerId,
          modelId: confirm.model ?? CONVERSATION_DEFAULT_MODEL_ID,
          modelLabel: engineNames.modelLabel ?? engineNames.cliLabel,
        }
      }
      if (images.length > 0) {
        showToast({
          tone: 'warn',
          title: 'That chat cannot travel yet',
          description: `Remove the attached images to start on ${pickedSsh.label}; they are files on this computer.`,
        })
        return
      }
      const folder = sshFolder.trim().replace(/(.)\/+$/u, '$1')
      lastSshFolders.set(pickedSsh.id, folder)
      onLaunch({
        ...confirm,
        prompt: text.trim(),
        environment: { kind: 'ssh', id: pickedSsh.id, label: pickedSsh.label, folder },
      })
      return
    }
    if (remoteTarget) {
      if (!remoteTarget.picked || !onLaunchRemote || remoteLaunching) return
      const confirm = composer.buildConfirm(selection)
      if (confirm.kind !== 'conversation') return
      // A chat's skills are this machine's and its images are local files;
      // neither has a way over yet, so their chips refuse rather than vanish.
      const stranded = [
        confirm.skills?.length ? 'the skills' : null,
        images.length > 0 ? 'the attached images' : null,
      ].filter((entry): entry is string => entry !== null)
      if (stranded.length > 0) {
        showToast({
          tone: 'warn',
          title: 'That chat cannot travel yet',
          description: `Remove ${stranded.join(' and ')} to start on ${remoteTarget.connection.machineName}, or start it on This device.`,
        })
        return
      }
      setRemoteLaunching(true)
      onLaunchRemote({
        connectionId: remoteTarget.connection.id,
        machineName: remoteTarget.connection.machineName,
        remoteWorkspaceId: remoteTarget.picked.workspaceId,
        remoteWorkspaceName: remoteTarget.picked.name,
        remoteWorkspaceRoot: remoteTarget.picked.folderPath,
        prompt: text.trim(),
        cli: confirm.cli,
        cliModel: confirm.model ?? null,
        permissionPreset: effectivePreset,
        branch: remoteTarget.checkout?.branch ?? null,
        remoteRepository: remoteTarget.picked.repository,
      })
        .finally(() => setRemoteLaunching(false))
        // The host reports its own failures as toasts; a throw past its catch
        // (an add-workspace fault) must not surface as an unhandled rejection.
        .catch(() => {})
      return
    }
    // The attached images ride along as paths after the text, quoted only when
    // the path needs it — the terminal drop idiom.
    const prompt = [text.trim(), ...images.map((image) => quotePath(image.path))].filter(Boolean).join(' ')
    const confirm = composer.buildConfirm(selection)
    if (confirm.kind === 'conversation') {
      // The picker's CLI and model, mapped onto the conversation provider that
      // drives that CLI as a chat. The CLI's own default row asks for no model.
      const providerId = confirm.cli ? conversationProviderForCli(confirm.cli) : null
      if (!providerId) return
      confirm.provider = {
        providerId,
        modelId: confirm.model ?? CONVERSATION_DEFAULT_MODEL_ID,
        modelLabel: engineNames.modelLabel ?? engineNames.cliLabel,
      }
    }
    onLaunch({
      ...confirm,
      prompt,
      ...(hostChoosable ? { hostId } : {}),
      ...(extensionMode ? { extension: { id: extensionName } } : {}),
    })
  }

  React.useEffect(() => {
    if (!canLaunch || (composer.noAgentCliInstalled && localHosts.length <= 1)) return
    const id = requestAnimationFrame(() => promptRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [canLaunch, composer.noAgentCliInstalled, localHosts.length])

  // Escape cancels from anywhere on the surface — the prompt is where focus
  // starts, but a person who has tabbed to a chip must not be trapped. The
  // `defaultPrevented` guard is the topmost-surface contract: an open popover or
  // the skill type-ahead handles its own Escape first, and only when nothing
  // did does this close.
  //
  // Not while painted over: the door host parks this surface when a door
  // opens, but a first-run auto-open can mount it UNDER a door that is already
  // up, inert. An Escape meant for that door must not close this on purpose
  // (and take its parked draft with it).
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (rootRef.current?.closest('[inert], [aria-hidden="true"]')) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onPromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // The Enter that commits an input method's composition belongs to the
    // input method: it picks the characters, it does not send them half-typed.
    if (event.nativeEvent.isComposing) return
    if (slashQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (slashRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        // Enter with nothing to pick is not a launch: the words after
        // `/schedule` are not the prompt.
        event.preventDefault()
        slashRef.current?.pickActive()
        return
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (mentionQuery !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (mentionRef.current?.moveSelection(event.key === 'ArrowDown' ? 1 : -1)) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Enter' && !event.shiftKey) {
        if (mentionRef.current?.pickActive()) {
          event.preventDefault()
          return
        }
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      launch(prompt)
    }
    // Escape is not handled here: the window listener above owns cancel, so it
    // works from every control on the surface rather than only this field.
  }

  // A plain shell runs nothing on its behalf: there is no prompt to give it and
  // no suggested task to start it with. Saying so beats a field that silently
  // drops what was typed.
  const isTerminalLaunch = selection.kind === 'terminal'
  // The skills picker is where skills are offered; the inline `$`/`/`
  // type-ahead still works, it just no longer needs advertising. A plain shell
  // takes no prompt: nothing types a command into it for you.
  const placeholder = isTerminalLaunch
    ? 'A shell opens with nothing typed'
    : scheduled
      ? 'What each run should do…'
      : extensionMode
        ? 'Describe the extension…'
        : selection.kind === 'general'
          ? 'Describe the task. It runs in a terminal you can take over.'
          : 'Describe the task…'
  // No agent CLI at all, or (for a chat agent) none with a chat runtime: the
  // same install route either way, because installing a CLI is the answer to
  // both.
  const terminalUnavailable = (composer.noAgentCliInstalled && localHosts.length <= 1) || chatUnavailable

  // ── The "+" menu ──────────────────────────────────────────────────────────
  // How the launch starts. A conversation wherever the workspace can host one;
  // a terminal agent and a plain shell wherever this client runs terminals,
  // except for an extension (built in a chat, with its skill) and a scheduled
  // agent being edited (it stays one).
  const offeredKinds = React.useMemo(() => {
    const kinds = new Set<StartAs>()
    if (chatAvailable) kinds.add('conversation')
    if (!extensionMode && !editing && clientSupports('terminals')) {
      kinds.add('general')
      kinds.add('terminal')
    }
    return kinds
  }, [chatAvailable, editing, extensionMode])
  const startAs = (kind: StartAs): void => {
    // A scheduled agent's runs are chats: a terminal needs someone at it, so
    // choosing one stops scheduling rather than lying about what would run.
    if (kind !== 'conversation' && mode === 'scheduled' && !editing) setMode('chat')
    const next: AgentComposerSelection = { kind } as AgentComposerSelection
    composer.setSelection(next)
    setLastNewChatAgent(next)
  }
  // What the launch reads skills and MCP servers through: nothing for a plain shell.
  const skillsOffered = selection.kind !== 'terminal'
  const scheduleOption =
    scheduleOffered || editing
      ? {
          on: scheduled,
          disabled: editing
            ? 'A scheduled agent stays one'
            : selection.kind !== 'conversation'
              ? 'Only a conversation can run on a schedule'
              : null,
          onToggle: () => setMode(scheduled ? 'chat' : 'scheduled'),
        }
      : undefined

  // ── The context strip ─────────────────────────────────────────────────────
  // Where the launch runs: the machine, the project, the worktree and the
  // branch. It replaces the machine · project line that sat above the box and
  // the Worktree chip that sat on its row (owner ruling 2026-10-04).
  const machinePickerShown =
    (remoteSelectable && remoteMachines.length > 0) || localHosts.length > 1 || sshMachines.length > 0
  // Worktree is offered only inside a git repository on this machine, for an
  // agent: absent, not disabled. A paired machine's chat has no checkout here
  // to fork, and an extension's folder is new.
  const worktreeOffered = !extensionMode && selection.kind !== 'terminal' && !remoteTarget && workspaceIsGitRepo
  // The branch the launch starts from: the remote project's as its machine
  // read it, else this checkout's. An SSH machine's folder is typed, not read.
  const stripBranch = remoteTarget ? (remoteTarget.checkout?.branch ?? null) : pickedSsh ? null : branch
  const projectControl = pickedSsh ? (
    <Input
      aria-label={`Folder on ${pickedSsh.label}`}
      value={sshFolder}
      onChange={(event) => setSshFolder(event.target.value)}
      placeholder={`Folder on ${pickedSsh.label}, such as /home/dev/repo`}
      size="sm"
      variant="well"
      fullWidth={false}
      className="w-72 max-w-full font-mono"
    />
  ) : remoteTarget ? (
    <RemoteProjectPicker
      target={remoteTarget}
      color={scopeProjectColor}
      onPick={(project) => {
        setRemoteTarget((current) => (current ? { ...current, picked: project, checkout: null } : current))
      }}
    />
  ) : canChooseProject ? (
    <ProjectScopePicker
      label={projectLabel ?? 'Choose a project'}
      // The branch has its own place on the strip.
      branch={null}
      options={projectOptions ?? []}
      selectedPath={workspaceRoot}
      onSelect={(path) => onSelectProject?.(path)}
      onBrowse={onBrowseProject ? () => onBrowseProject(hostId) : undefined}
      onClone={onCloneProject}
      // The hue, resolved here because only this component holds the
      // repository identity behind the folder; the identity map goes with it
      // so the rows IN the list wear their own colours too, read from the map
      // this panel already asked main for rather than a second round of the
      // same IPC.
      color={scopeProjectColor}
      unfiled={!workspaceRoot?.trim()}
      identities={localIdentities}
    />
  ) : projectLabel ? (
    // The tab strip's "+": the project is a fact rather than a choice, so this
    // is a line and not a control — but it is the same line, and it wears the
    // same glyph in the same hue. Every state of the strip carries the colour,
    // or the colour stops being how you tell one project from another.
    <span
      data-project-line="true"
      className="inline-flex h-control-xs min-w-0 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
    >
      <FolderIdentityIcon folderPath={workspaceRoot} className="icon-xs shrink-0" color={scopeProjectColor} />
      <span className="min-w-0 truncate">{projectLabel}</span>
    </span>
  ) : null
  const stripShown = machinePickerShown || projectControl !== null || worktreeOffered || Boolean(stripBranch)

  const sendTip =
    selection.kind === 'terminal'
      ? 'Opens a shell in this folder'
      : extensionMode
        ? `Makes ${extensionName || 'the extension'} in ${projectLabel ?? 'the project'} and starts ${engineNames.cliLabel} there`
        : isChatLaunch
          ? `Starts ${engineNames.cliLabel} as a chat`
          : commandLine.status === 'ready'
            ? commandLine.preview.display
            : commandLine.status === 'error'
              ? commandLine.message
              : 'Reading this agent’s launch command…'

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 pb-8 pt-8"
    >
      {showCloseButton ? (
        <div className="absolute right-3 top-3">
          <CloseIconButton onClick={onClose} aria-label="Cancel" />
        </div>
      ) : null}
      {/* Centred in the pane while it fits, and scrolling from the top when it
          does not: auto margins in a column collapse to nothing once the
          content outgrows it. */}
      <div className="@container m-auto flex w-full max-w-[680px] flex-col">
        {/* No mark and no greeting above the box (owner ruling 2026-10-04):
            the composer is the page. An extension keeps its question, which
            says what the box is for when it is not the usual task. */}
        {extensionMode ? (
          <div className="mb-5 text-center">
            <ExtensionsGlyph className="icon-lg mx-auto text-[color:var(--text-strong)]" />
            <h1 className="mt-2.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
              What should your extension do?
            </h1>
          </div>
        ) : null}

        {terminalUnavailable ? (
          <EmptyState
            density="list"
            title={
              chatUnavailable
                ? 'No agent CLI on this machine can run as a chat.'
                : 'No agent CLI is installed on this machine.'
            }
            body={
              chatUnavailable
                ? 'Install one with a chat runtime to start a chat agent here.'
                : 'Install one to start an agent here.'
            }
            action={<CliInstallCta />}
          />
        ) : null}
        {/* Why the last run of the scheduled agent being edited did not
            start, in the tray behind the box, until the person has seen it. */}
        {scheduled && lastRunFailure && !terminalUnavailable ? (
          <ScheduleFailureTray failure={lastRunFailure} onDismiss={() => setLastRunFailure(null)} />
        ) : null}
        <div
          // The box owns the visible border while the textarea inside it is the
          // tab stop, so the product's one focus ring lands on the box keyed to
          // the textarea's own focus (`FOCUS_RING_WITHIN_TEXTAREA_CLASS`) — not
          // an accent border swap on `focus-within`, which lit the box for the
          // row's buttons too and was a second focus idiom. Positioned, so it
          // paints over the strip tucked under its lower edge.
          className={`relative ${terminalUnavailable ? 'hidden' : ''} ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_TEXTAREA_CLASS} ${
            dropActive ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-default)]'
          }`}
          data-new-chat-composer="true"
          onDragEnter={(event) => {
            if (isTerminalLaunch || !dataTransferHasDroppableFiles(event.dataTransfer)) return
            dragDepthRef.current += 1
            setDropActive(true)
          }}
          onDragOver={(event) => {
            // Claiming the drag is what stops the window from navigating to the
            // dropped file, so it has to happen on every dragover.
            if (isTerminalLaunch || !dataTransferHasDroppableFiles(event.dataTransfer)) return
            event.preventDefault()
          }}
          onDragLeave={(event) => {
            if (isTerminalLaunch || !dataTransferHasDroppableFiles(event.dataTransfer)) return
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setDropActive(false)
          }}
          onDrop={(event) => {
            if (isTerminalLaunch || !dataTransferHasDroppableFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepthRef.current = 0
            setDropActive(false)
            dropFiles(event.dataTransfer)
          }}
        >
          {/* Opaque, not a scrim: the field's own text ghosting through the
              drop state reads as a rendering artifact rather than a state. */}
          {dropActive && !isTerminalLaunch ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[var(--sem-radius-composer)] bg-[color:var(--bg-app)] text-meta font-medium text-[color:var(--accent-primary)]">
              Drop to attach
            </div>
          ) : null}
          {slashQuery !== null ? (
            <ScheduleSlashPicker
              ref={slashRef}
              query={slashQuery}
              onPick={applySlashSchedule}
              onDismiss={() => setSlashDismissed(true)}
            />
          ) : null}
          {mentionQuery !== null ? (
            <InlineSkillPicker
              ref={mentionRef}
              workspaceRoot={workspaceRoot}
              pluginId={launchCli}
              query={mentionQuery}
              onPick={applySkillMention}
              onMatchCountChange={(count) => {
                if (count === 0 && mentionQuery.length > 0) setMentionDismissed(true)
              }}
              onDismiss={() => setMentionDismissed(true)}
            />
          ) : null}

          {/* Staged images sit inside the box above the text so the prompt
              reads as one thing — the same strip the chat composer uses. */}
          <ComposerAttachmentStrip
            attachments={images}
            reading={attachingCount}
            onRemove={removeImage}
            className="px-5 pt-4"
          />

          <div className="px-5 pb-1 pt-4">
            {/* Grows with its content (field-sizing: content) from the
                three-row floor to a ceiling, then scrolls — a box that showed
                two lines of a six-line prompt was hiding what the person was
                about to send. `composer` is the kit's hosted multiline field:
                no box of its own, because `COMPOSER_SURFACE_CLASS` around it
                draws the border, the ground and the ring. */}
            <Textarea
              ref={promptRef}
              variant="composer"
              resize="none"
              value={prompt}
              rows={3}
              onPaste={(event) => {
                // A pasted screenshot only exists as a clipboard item; a text
                // paste reports no image and falls through to the default —
                // unless the text is only paths to images outside the project,
                // which attach instead. A chat starting on another machine
                // cannot open this one's project, so there every path attaches.
                const files = imageFilesFromDataTransfer(event.clipboardData)
                if (files.length > 0) {
                  event.preventDefault()
                  void attachDroppedFiles(files)
                  return
                }
                const text = event.clipboardData.getData('text/plain')
                const paths = pastedImagePaths(text, !remoteTarget && workspaceRoot ? [workspaceRoot] : [])
                if (!paths) return
                event.preventDefault()
                const field = event.currentTarget
                void attachPastedPaths(paths, text, field.selectionStart, field.selectionEnd)
              }}
              onChange={(event) => {
                setPrompt(event.currentTarget.value)
                setMentionDismissed(false)
              }}
              onKeyDown={onPromptKeyDown}
              placeholder={placeholder}
              disabled={isTerminalLaunch}
              aria-label="What this agent should do"
              className="max-h-[280px] min-h-[66px] w-full overflow-y-auto font-mono text-body"
            />
          </div>

          {/* The controls, on the box's own ground with no rule above them:
              the "+", a tag for every choice that is not the default, the
              model, and the send. Each control is quiet — the box is the
              surface, and a standing edge on each drew a box in a box. */}
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
            <HiddenFileInput ref={fileInputRef} onFiles={(files) => takeFiles(sortFiles(files, true))} />
            <ComposerPlusMenu
              placement="bottom-start"
              startAs={{ kind: selection.kind, offered: offeredKinds, onStartAs: startAs }}
              onAttach={
                isTerminalLaunch
                  ? undefined
                  : () => {
                      fileInputRef.current?.click()
                    }
              }
              schedule={scheduleOption}
              skills={
                skillsOffered
                  ? {
                      workspaceRoot,
                      // A chat stages skills itself rather than through the
                      // CLI's own skill directory, so the workspace-wide
                      // inventory is its list.
                      pluginId: commandCli,
                      skills: composer.skills,
                      onSkillsChange: composer.setSkills,
                      mcpServers: composer.mcpServers,
                      onMcpServersChange: composer.setMcpServers,
                    }
                  : undefined
              }
            />

            {/* The tags: each choice the "+" made that is not the default. */}
            {scheduled ? (
              <ScheduleTag
                cron={cron}
                timezone={scheduleTimezone}
                onChange={setCron}
                onRemove={editing ? undefined : () => setMode('chat')}
              />
            ) : null}
            {selection.kind !== 'conversation' ? (
              chatAvailable ? (
                <AttachmentChip
                  glyph={<StartAsGlyph kind={selection.kind} className="icon-xs shrink-0" />}
                  label={startAsLabel(selection.kind)}
                  removeLabel={`Start as a conversation instead of ${startAsLabel(selection.kind).toLowerCase()}`}
                  onRemove={() => startAs('conversation')}
                />
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--bg-selected)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
                  <StartAsGlyph kind={selection.kind} className="icon-xs shrink-0" />
                  {startAsLabel(selection.kind)}
                </span>
              )
            ) : null}
            {/* An extension's folder is new, so there is nothing to fork: its
                name is a tag of its own, in the extension violet. It is a field
                the launch cannot start without. */}
            {extensionMode ? (
              <ExtensionNameChip name={extensionName} onChange={setExtensionName} invalid={extensionNote !== null} />
            ) : null}
            {/* Every skill and MCP server picked is a tag; the "+" opens the
                picker for more. A terminal launches nothing that reads one. */}
            {skillsOffered ? (
              <>
                {composer.skills.map((skill) => (
                  <AttachmentChip
                    key={`skill-${skill.id}`}
                    glyph={<StarGlyph filled className="icon-xs text-[color:var(--accent-primary)]" />}
                    label={skill.name}
                    removeLabel={`Remove skill ${skill.name}`}
                    onRemove={() => composer.setSkills(composer.skills.filter((entry) => entry.id !== skill.id))}
                  />
                ))}
                {composer.mcpServers.map((server) => (
                  <AttachmentChip
                    key={`mcp-${server.id}`}
                    glyph={
                      <ExtensionIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={13} />
                    }
                    label={server.name}
                    removeLabel={`Remove MCP server ${server.name}`}
                    onRemove={() =>
                      composer.setMcpServers(composer.mcpServers.filter((entry) => entry.id !== server.id))
                    }
                  />
                ))}
              </>
            ) : null}

            <span className="flex-1" />

            {/* Engine: the CLI's own mark, then the model. A plain shell runs
                no CLI, so it has none. */}
            {launchCli ? (
              <EnginePickerChip
                cli={launchCli}
                options={pickerOptions}
                model={model}
                reasoning={reasoning}
                open={enginePopoverOpen}
                onOpenChange={setEnginePopoverOpen}
                onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
                onSelectModel={(cli, next) => composer.setEngineModel(selection, cli, next)}
                onSelectReasoning={(cli, next) => composer.setEngineReasoning(selection, cli, next)}
                // Permissions live in the picker rather than on a chip beside
                // it (owner, 2026-09-05). A preset is a property of the runtime
                // the row names — each CLI spells bypass its own way — so it is
                // chosen where the runtime is, remembered once per CLI for all
                // of its models, and sits on the picker's one trailing row
                // beside the effort control.
                permissions={(cli) => (
                  <SpawnPermissionFooter
                    cli={cli}
                    fallback={permissionPreset}
                    launch={isChatLaunch ? 'chat' : 'terminal'}
                  />
                )}
              />
            ) : null}

            {/* Run now starts what is saved; only a scheduled agent that exists
                has anything saved to run. */}
            {scheduled && editing ? (
              <GhostButton size="xs" onClick={() => void runSavedNow()}>
                Run now
              </GhostButton>
            ) : null}

            {/* The send: a small round accent button with an up arrow (owner
                ruling 2026-10-04). A scheduled agent is made, not started, so
                its send says so in a word. The invocation rides the tooltip:
                the one moment someone asks "what am I about to run?". */}
            <Tooltip
              content={
                scheduled
                  ? editing
                    ? 'Save the prompt, schedule and settings'
                    : `Starts a new ${engineNames.cliLabel} chat with this prompt each time the schedule comes round`
                  : sendTip
              }
              placement="top"
              multiline
            >
              {scheduled ? (
                <SendButton
                  size="sm"
                  onClick={() => launch(prompt)}
                  disabled={!canLaunch}
                  busy={scheduleBusy}
                  aria-keyshortcuts="Enter"
                  className="shrink-0 gap-1.5 pl-3 pr-2.5"
                >
                  {editing ? 'Save' : 'Schedule'}
                  <SendGlyph className="icon-sm" />
                </SendButton>
              ) : (
                <SendButton
                  size="sm"
                  onClick={() => launch(prompt)}
                  disabled={!canLaunch || !extensionReady}
                  aria-label={isTerminalLaunch ? 'Open terminal' : 'Start agent'}
                  aria-keyshortcuts="Enter"
                  className="w-control-sm shrink-0 px-0"
                >
                  <SendGlyph className="icon-sm" />
                </SendButton>
              )}
            </Tooltip>
          </div>
        </div>

        {/* The context strip, tucked under the box and one piece with it:
            rounded at the bottom only, inset from the box's sides, its top
            hidden under the box's lower edge (owner ruling 2026-10-04). */}
        {stripShown && !terminalUnavailable ? (
          <ComposerStrip>
            {/* One machine dropdown, this computer first (owner ruling
                2026-09-03 — no separate Local/Remote switch). Shown whenever
                there is another machine to pick. */}
            {machinePickerShown ? (
              <MachineScopePicker
                // A scheduled agent runs on this computer or one of its WSL
                // distributions: the scheduler is this computer's, and a paired
                // machine's chat would need its own.
                machines={remoteSelectable && !chatOnly ? remoteMachines : []}
                selected={remoteTarget?.connection ?? null}
                onSelect={(connection) => {
                  pickSsh(null)
                  pickRemoteMachine(connection)
                }}
                sshMachines={scheduled ? [] : sshMachines}
                selectedSshId={pickedSsh?.id ?? null}
                onSelectSsh={(id) => {
                  pickRemoteMachine(null)
                  pickSsh(id)
                }}
                localHosts={localHosts}
                selectedHostId={hostId}
                onSelectHost={(next) => {
                  pickRemoteMachine(null)
                  pickLocalHost(next)
                }}
                hostDisabledReason={(host) => {
                  // Any folder runs on the machine picked (owner ruling
                  // 2026-10-03): This PC opens a folder inside a distribution
                  // over its share, more slowly, and the hint under the strip
                  // says so. Only another distribution cannot reach it.
                  const refused = hostRefusesFolder(host.id, scopeFolder)
                  if (refused) return refused
                  if (host.state === 'unavailable') return host.reason ?? 'Not available.'
                  return null
                }}
                availability={(machine) =>
                  machineAvailabilityOf(machine, browseOf(machineBrowses.get(machine.id)), activeIdentity)
                }
                // With a project in hand, opening the list asks every machine
                // what it holds — once, then again when the answer is old or
                // was "not answering" (a machine asleep at the first open must
                // be pickable once it wakes). Without a project there is
                // nothing to filter by, and the list is the plain one.
                onOpen={() => {
                  if (!activeIdentity) return
                  for (const machine of remoteMachines) {
                    if (machineBrowseStale(machineBrowses.get(machine.id))) void browseMachine(machine)
                  }
                }}
                projectName={activeIdentity?.name ?? null}
              />
            ) : null}
            {projectControl}
            {/* Worktree, then the branch it is cut from (or the launch runs
                on): off until turned on or named. Set apart from the project
                by the strip's spacing alone, with no rule between. */}
            {worktreeOffered ? <WorktreeChip name={composer.worktreeName} onChange={composer.setWorktreeName} /> : null}
            {stripBranch ? (
              // The one item on the strip that may shrink: it gives its front
              // away first, so the end of the name — the part that says what
              // the branch is for — is what stays.
              <span
                className="inline-flex h-control-xs min-w-0 flex-1 items-center gap-1.5 px-2 text-meta text-[color:var(--text-subtle)]"
                data-composer-branch={stripBranch}
              >
                <GitBranchGlyph className="icon-xs shrink-0" />
                {worktreeOffered && composer.worktreeName !== null ? <span className="shrink-0">from</span> : null}
                <FrontTruncatedText text={stripBranch} className="font-mono" />
              </span>
            ) : null}
          </ComposerStrip>
        ) : null}
        {driveAdvisory ? (
          <p className="mt-2 px-6 text-meta leading-5 text-[color:var(--text-muted)]">{driveAdvisory}</p>
        ) : null}

        {attachNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--tone-error)]">
            {attachNote}
          </p>
        ) : null}
        {extensionMode && extensionNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--tone-error)]">
            {extensionNote}
          </p>
        ) : extensionMode && extensionTargetState === 'extension' ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {extensionName} is already an extension in {projectLabel ?? 'this project'}: the chat opens it to carry on.
          </p>
        ) : null}

        {/* Extension mode's cards fill the box and start nothing: the words
            are the person's to change, and the chat needs a name first. */}
        {extensionMode && !terminalUnavailable ? (
          <section aria-label="Extension ideas" className="mt-6">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <h2 className="m-0 text-meta font-medium text-[color:var(--text-subtle)]">Start from an idea</h2>
              <LinkButton ink="quiet" onClick={() => setAllIdeas((current) => !current)}>
                {allIdeas ? 'Show fewer' : `Show all ${EXTENSION_IDEAS.length}`}
              </LinkButton>
            </div>
            <div className="grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
              {(allIdeas ? EXTENSION_IDEAS : EXTENSION_IDEAS.slice(0, EXTENSION_IDEAS_FIRST)).map((idea) => (
                <ExtensionIdeaCard key={idea.id} idea={idea} onPick={() => pickIdea(idea)} />
              ))}
            </div>
          </section>
        ) : null}
        {editing && scheduled && onOpenScheduledRun ? (
          <ScheduledRuns runs={scheduledRuns} onOpen={onOpenScheduledRun} />
        ) : null}
        {terminalUnavailable || isTerminalLaunch || scheduled || extensionMode ? null : (
          <div className="mt-6 grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
            {suggestions.map((entry) => (
              <SuggestionCard
                key={entry.id}
                entry={entry}
                disabled={!canLaunch}
                onLaunch={() => launch(entry.prompt)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────

function ChevronGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--text-subtle)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="m4 6.5 4 3.5 4-3.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/**
 * A machine's mark in a menu row's leading slot, or the empty slot the width of
 * one for this computer, which wears none (owner ruling 2026-10-04).
 */
function MachineSlot({ machine, className = 'icon-xs shrink-0' }: { machine: MachineRef; className?: string }) {
  const identity = useMachineIdentity(machine)
  return identity ? (
    <MachineGlyph identity={identity} className={className} />
  ) : (
    <span aria-hidden="true" className={className} />
  )
}

/** The trigger's mark: the picked machine's, and nothing for this computer. */
function TriggerMachineMark({ machine }: { machine: MachineRef }) {
  const identity = useMachineIdentity(machine)
  return identity ? <MachineGlyph identity={identity} /> : null
}

/**
 * The machine dropdown (remote-sessions-ux / new-chat-on-a-remote-machine):
 * This device is the first entry and the default; every other machine follows
 * wearing its own mark — its kind's drawing in its colour (owner ruling
 * 2026-10-04) — under "Other machines". One dropdown — the owner rejected a
 * separate Local/Remote switch as redundant.
 *
 * On Windows the machines on THIS computer lead it (owner decision
 * 2026-09-24): "This PC (Windows)", then each WSL distribution turned on in
 * Settings ▸ Machines ("WSL: Ubuntu", the default one marked), then a divider
 * and the paired machines. With one machine here (macOS, Linux, or Windows
 * with no distribution turned on) the first row is the "This device" it
 * always was.
 */
function MachineScopePicker({
  machines,
  selected,
  onSelect,
  sshMachines = [],
  selectedSshId = null,
  onSelectSsh,
  localHosts = [],
  selectedHostId = LOCAL_HOST_ID,
  onSelectHost,
  hostDisabledReason,
  availability,
  onOpen,
  projectName,
}: {
  machines: MeshConnection[]
  selected: MeshConnection | null
  onSelect: (connection: MeshConnection | null) => void
  /** This computer's machines, this one first. One entry (or none) draws the plain "This device" row. */
  localHosts?: ExecutionHostSummary[]
  selectedHostId?: ExecutionHostId
  onSelectHost?: (hostId: ExecutionHostId) => void
  /** Why a machine here cannot be picked right now, or null. */
  hostDisabledReason?: (host: ExecutionHostSummary) => string | null
  /** Whether each machine holds the project in hand (one-project-across-machines); `none` lists it plainly. */
  availability?: (machine: MeshConnection) => MachineAvailability
  onOpen?: () => void
  /** The project in hand, named in the dimmed rows' reasons and the list's heading. */
  projectName?: string | null
  /** SSH machines (phase 8), after this computer's: each its own Studio server. */
  sshMachines?: SshEnvironmentSummary[]
  selectedSshId?: string | null
  onSelectSsh?: (id: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const selectedSsh = sshMachines.find((machine) => machine.id === selectedSshId) ?? null
  const availabilityOf = (machine: MeshConnection): MachineAvailability => availability?.(machine) ?? { state: 'none' }
  const chosen = (machine: MeshConnection): boolean => {
    const state = availabilityOf(machine).state
    return state !== 'lacks' && state !== 'unreachable'
  }
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-machine-option="true"]', activate)
  const hostRows = localHosts.length > 1 ? localHosts : []
  const selectedHost = selected || selectedSsh ? null : (hostRows.find((host) => host.id === selectedHostId) ?? null)
  // The machine the trigger names, as its mark knows it. This computer has none.
  const selectedRef: MachineRef = selected
    ? { kind: 'paired', name: selected.machineName }
    : selectedSsh
      ? sshMachineRef(selectedSsh)
      : hostMachineRef(selectedHost?.id ?? null)
  const localSelected =
    selected === null && selectedSsh === null && (hostRows.length === 0 || selectedHostId === LOCAL_HOST_ID)
  // This machine can be ruled out too: a folder inside a distribution runs there.
  const localReason = hostRows[0] ? (hostDisabledReason?.(hostRows[0]) ?? null) : null
  const activateLocal = (): void => {
    if (localReason) return
    if (hostRows.length > 0) onSelectHost?.(LOCAL_HOST_ID)
    else onSelect(null)
    setOpen(false)
  }
  const focusChecked = React.useCallback((surface: HTMLElement) => {
    const target =
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"][aria-checked="true"]:not([disabled])') ??
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"]:not([disabled])')
    target?.focus()
    if (target && document.activeElement !== target) {
      requestAnimationFrame(() => {
        if (surface.isConnected) target.focus()
      })
    }
  }, [])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen?.()
      }}
      ariaLabel="Machine this chat runs on"
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The kit's quiet chip, the context strip's control (owner ruling
        // 2026-10-04): the machine's own mark, its name and the caret.
        <ChipButton ref={ref} variant="raised" onClick={togglePopover} data-machine-trigger="true" {...triggerProps}>
          <TriggerMachineMark machine={selectedRef} />
          {selected
            ? selected.machineName
            : selectedSsh
              ? selectedSsh.label
              : selectedHost && hostRows.length > 0
                ? selectedHost.label
                : 'This device'}
          <ChevronGlyph />
        </ChipButton>
      )}
    >
      {/* The surface is the menu; these are its rows. The leading slot is
          all-or-nothing per the menu spec, so This device renders an empty slot
          the width of the machine glyph rather than sliding its label left. */}
      <MenuOption
        role="menuitemradio"
        selected={localSelected}
        stacked={Boolean(localReason)}
        disabled={Boolean(localReason)}
        data-machine-option="true"
        tabIndex={localSelected ? 0 : -1}
        onKeyDown={(event) => rowKey(event, activateLocal)}
        onClick={activateLocal}
        icon={<span aria-hidden="true" className="icon-xs shrink-0" />}
      >
        {localReason ? (
          <>
            <span className="block truncate text-body font-medium">{hostRows[0]?.label}</span>
            <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{localReason}</span>
          </>
        ) : (
          (hostRows[0]?.label ?? 'This device')
        )}
      </MenuOption>
      {hostRows
        .filter((host) => host.id !== LOCAL_HOST_ID)
        .map((host) => {
          const reason = hostDisabledReason?.(host) ?? null
          const isSelected = selected === null && host.id === selectedHostId
          const activate = () => {
            if (reason) return
            onSelectHost?.(host.id)
            setOpen(false)
          }
          return (
            <MenuOption
              key={host.id}
              role="menuitemradio"
              selected={isSelected}
              stacked={Boolean(reason)}
              disabled={Boolean(reason)}
              data-machine-option="true"
              data-machine-host={host.id}
              tabIndex={isSelected ? 0 : -1}
              onKeyDown={(event) => rowKey(event, activate)}
              onClick={activate}
              icon={
                <MachineSlot
                  machine={hostMachineRef(host.id)}
                  className={`icon-xs shrink-0${reason ? ' mt-0.5' : ''}`}
                />
              }
              trailing={
                !reason && host.isDefaultDistro ? (
                  <span className="shrink-0 text-micro text-[color:var(--text-disabled)]">default</span>
                ) : null
              }
            >
              <span className={reason ? 'block truncate text-body font-medium' : 'block truncate'}>{host.label}</span>
              {reason ? (
                <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{reason}</span>
              ) : null}
            </MenuOption>
          )
        })}
      {/* Every machine not on this computer, under the one mark that means
          "another machine" in general. */}
      {sshMachines.length > 0 || machines.length > 0 ? (
        <div className={`${MENU_GROUP_LABEL_CLASS} flex items-center gap-1.5 pb-1 pt-2`}>
          <RemoteMachineGlyph className="icon-xs shrink-0" />
          Other machines
        </div>
      ) : null}
      {sshMachines.map((machine) => {
        // A machine Studio cannot run on, or whose server this app cannot
        // speak to, is listed with why, and cannot be picked.
        const reason = machine.state === 'unsupported' || machine.state === 'version-blocked' ? machine.stateText : null
        const isSelected = selected === null && machine.id === selectedSshId
        const hint = reason ?? (machine.state === 'connected' ? null : machine.stateText)
        const activate = () => {
          if (reason) return
          onSelectSsh?.(machine.id)
          setOpen(false)
        }
        return (
          <MenuOption
            key={machine.id}
            role="menuitemradio"
            selected={isSelected}
            stacked={Boolean(hint)}
            disabled={Boolean(reason)}
            data-machine-option="true"
            data-machine-ssh={machine.id}
            tabIndex={isSelected ? 0 : -1}
            onKeyDown={(event) => rowKey(event, activate)}
            onClick={activate}
            icon={
              <MachineSlot machine={sshMachineRef(machine)} className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`} />
            }
          >
            <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>{machine.label}</span>
            {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
          </MenuOption>
        )
      })}
      {machines.map((machine) => {
        const state = availabilityOf(machine)
        const pickable = chosen(machine)
        const activate = () => {
          if (!pickable) return
          onSelect(machine)
          setOpen(false)
        }
        // With a project in hand the row says whether the machine has it:
        // a copy's name when it does, the reason when it does not (dimmed,
        // kept in the list — the menu spec's rule for a row that cannot be
        // chosen). With none, the row is the plain machine line it always was.
        const hint =
          state.state === 'has'
            ? `Has ${projectName ?? 'the project'}${state.workspace.folderPath ? ` at ${state.workspace.folderPath}` : ''}`
            : state.state === 'lacks' || state.state === 'unreachable'
              ? state.reason
              : state.state === 'loading'
                ? 'Asking what it holds…'
                : null
        return (
          <MenuOption
            key={machine.id}
            role="menuitemradio"
            selected={selected?.id === machine.id}
            stacked={Boolean(hint)}
            disabled={!pickable}
            data-machine-option="true"
            data-machine-availability={state.state}
            tabIndex={selected?.id === machine.id ? 0 : -1}
            onKeyDown={(event) => rowKey(event, activate)}
            onClick={activate}
            icon={
              <MachineSlot
                machine={{ kind: 'paired', name: machine.machineName }}
                className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`}
              />
            }
            trailing={
              hint ? null : (
                <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">
                  {machine.endpoint}
                </span>
              )
            }
          >
            <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>
              {machine.machineName}
            </span>
            {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
          </MenuOption>
        )
      })}
    </Popover>
  )
}

/**
 * A remote machine's projects: its workspaces, served over the mesh client.
 * Loading and unreachable states are said plainly — a machine that does not
 * answer keeps its entry with the reason, never a silent empty list.
 */
function RemoteProjectPicker({
  target,
  color,
  onPick,
}: {
  target: RemoteTargetState
  /**
   * The picked project's hue — the SAME hue the local clone of that repository
   * wears here (decision 3: a project is a repository, and the machine is a
   * glyph on the line rather than a second colour). Null until a project is
   * picked, and null for a picked project whose machine could not say which
   * repository it is: that one keeps the plain solid glyph rather than being
   * keyed by a path on someone else's disk.
   */
  color: ProjectColor | null
  onPick: (project: RemoteProject) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  // Each row's own hue, out of the same store the local list reads. A remote
  // project carries the repository its machine read, so the row for this
  // disk's project is the colour it is here — which is how a person picks the
  // right one out of a machine holding a dozen.
  const projectColors = useProjectColors()
  const colorOfProject = (project: RemoteProject): ProjectColor | null =>
    project.repository
      ? resolveProjectColor(projectColors, projectColorKey({ folderPath: null, repository: project.repository }))
      : null
  const needle = query.trim().toLowerCase()
  const visibleProjects =
    target.projects === null
      ? null
      : needle
        ? target.projects.filter(
            (project) =>
              project.name.toLowerCase().includes(needle) || project.folderPath.toLowerCase().includes(needle),
          )
        : target.projects
  const label = target.error
    ? 'Unavailable'
    : target.projects === null
      ? 'Loading…'
      : (target.picked?.name ?? 'Choose a project')
  // Dashed says one thing and only one: there is no folder here, so there is no
  // project (decision 6). That is true of "Choose a project" — the machine
  // answered and nothing has been picked — and false of "Loading…" and
  // "Unavailable", which are open questions rather than an answer of "none". A
  // dash on those would report an unfiled chat where there is a machine that
  // has not spoken yet, so they keep the plain solid glyph.
  const unfiled = !target.picked && target.projects !== null && !target.error
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Project on ${target.connection.machineName}`}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        // The same stable hook the local chip carries: the two never render
        // together, so a pass looking for "the project control on the scope
        // line" finds whichever one is there.
        <ChipButton ref={ref} variant="raised" onClick={togglePopover} data-project-trigger="true" {...triggerProps}>
          {/* The bare glyph, not `FolderIdentityIcon`: a logo is detected by
              reading THIS disk, and the folder is on another machine. */}
          <FolderTypeIcon className="icon-xs shrink-0" color={color} unfiled={unfiled} />
          {label}
          <ChevronGlyph />
        </ChipButton>
      )}
    >
      <>
        {target.projects !== null && target.projects.length > 0 && !target.error ? (
          // The same search-first shape the local selector opens on, with the
          // same words: the list is projects either way, so the placeholder
          // says so rather than naming the machine the chip beside it names.
          <div className="px-1.5 pb-1">
            <Input
              type="text"
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search projects…"
              aria-label={`Search projects on ${target.connection.machineName}`}
            />
          </div>
        ) : null}
        {target.error ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--tone-error)]">{target.error}</div>
        ) : visibleProjects === null ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">Loading projects…</div>
        ) : visibleProjects.length === 0 ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
            {needle ? 'No matching projects.' : 'No projects open on that machine.'}
          </div>
        ) : (
          visibleProjects.map((project) => (
            <MenuOption
              key={project.key}
              role="menuitemradio"
              selected={target.picked?.key === project.key}
              stacked
              onClick={() => {
                onPick(project)
                setOpen(false)
              }}
              icon={<FolderTypeIcon className="mt-0.5 icon-xs shrink-0" color={colorOfProject(project)} />}
            >
              {/* The FOLDER's name and the folder's path — the same two lines
                  the local list gives a project. What stands in it is the
                  machine's business, not a second name for the row. */}
              <span className="block truncate text-body font-medium">{project.name}</span>
              <span className="block truncate font-mono text-micro text-[color:var(--text-subtle)]">
                {project.folderPath}
              </span>
            </MenuOption>
          ))
        )}
      </>
    </Popover>
  )
}

// An image staged on the prompt: the chat composer's attachment shape (so the
// shared strip renders it) plus the file path that stands in for it once the
// prompt becomes text.
type PromptImage = NewChatDraftImage

function SuggestionCard({
  entry,
  disabled,
  onLaunch,
}: {
  entry: SuggestionEntry
  disabled: boolean
  onLaunch: () => void
}) {
  return (
    // The kit's tile: a block button whose content is a composition rather than
    // a label. `bordered` keeps the hairline at rest, so hover moves the ground
    // and nothing else — a grid that reflows under the pointer is the defect
    // the tile spec rules out. The inset stays with the caller, because a
    // tile's padding is a composition decision.
    <CardButton variant="bordered" onClick={onLaunch} disabled={disabled} className="px-3 py-2.5">
      <div className="text-body font-medium text-[color:var(--text-strong)]">{entry.title}</div>
      <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{entry.description}</p>
      <span className="mt-1.5 inline-block self-start rounded border border-[color:var(--border-default)] px-1.5 text-micro text-[color:var(--text-subtle)]">
        {entry.outcome}
      </span>
    </CardButton>
  )
}

function ExtensionIdeaCard({ idea, onPick }: { idea: ExtensionIdea; onPick: () => void }) {
  return (
    // The suggestion tile's shape; the surface it adds leads, because the cards
    // together are a map of what an extension can be.
    <CardButton variant="bordered" onClick={onPick} className="px-3 py-2.5">
      <span className="text-micro text-[color:var(--text-subtle)]">{idea.surface}</span>
      <div className="mt-0.5 text-body font-medium text-[color:var(--text-strong)]">{idea.title}</div>
      <p className="mt-0.5 text-meta leading-5 text-[color:var(--text-muted)]">{idea.description}</p>
    </CardButton>
  )
}
