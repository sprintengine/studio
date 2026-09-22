import React from 'react'
import type { AgentCli, CliPermissionPreset, WorkspaceSkill } from '../../../../../shared/electron-api'
import type {
  FleetBrowse,
  FleetCheckoutRequest,
  FleetConnection,
  FleetWorkspace,
  FleetWorkspaceCheckout,
} from '../../../../../shared/tailnet-fleet'
import type { TailnetScope } from '../../../../../shared/tailnet'
import { sameRepository, type RepositoryIdentity } from '../../../../../shared/repository-identity'
import { folderIdentityKey, useFolderRepositoryIdentities } from '../useFolderRepositoryIdentities'
import { FolderTypeIcon, RemoteMachineGlyph } from '../../AppIcons'
import { FolderIdentityIcon } from '../FolderIdentityIcon'
import { useProjectColor, useProjectColors } from '../../../hooks/useProjectColors'
import { projectColorKey, resolveProjectColor, type ProjectColor } from '../../../utils/projectColor'
import { resolveSkillMentionPrefix, renderSkillMention } from '../../../../../shared/skill-invocation'
import { useWorkspaceStore } from '../../../store/workspaceStore'
import { ATTACHABLE_IMAGE_TYPES } from '../../../../../shared/conversation-attachments'
import {
  dataTransferHasFiles,
  filesFromDataTransfer,
  imageFilesFromDataTransfer,
  readFileAsBase64,
} from '../../../utils/imageFileTransfer'
import { ComposerAttachmentStrip } from '../../panels/ComposerAttachmentStrip'
import { basename } from '../../../utils/paths'
import { resolveWorkspaceWorktree } from '../../../utils/workspaceWorktree'
import {
  CardButton,
  ChipButton,
  CliModelPopoverSurface,
  CloseIconButton,
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  MENU_DIVIDER_CLASS,
  MENU_LIST_CLASS,
  Input,
  InlineSkillPicker,
  MenuItem,
  MenuOption,
  Popover,
  PrimaryButton,
  Textarea,
  setModelPermissionPreset,
  StarGlyph,
  Tooltip,
  TruncatedText,
  useModelPermissionPreset,
  type InlineSkillPickerHandle,
} from '../../ui'
import { CheckIcon } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import { ExtensionIcon } from '../../ui/ExtensionIcon'
import { mcpIconSlug } from '../../ui/mcpIconSlug'
import SprintEngineFrond from '../../brand/SprintEngineFrond'
import { CliInstallCta } from '../cliInstallRoute'
import {
  agentPermissionOptions,
  menuRadioRowKeyDown,
  nearestRemotePermissionPreset,
  REMOTE_PERMISSION_PRESETS,
  REMOTE_PRESET_DISABLED_REASONS,
} from './agentSpawnShared'
import { SpawnPermissionFooter } from './spawnFooter'
import { ProjectScopePicker } from './ProjectScopePicker'
import { remoteProjectOfWorkspace, remoteProjectsOf, type RemoteProject } from './remoteProjects'
import { type ProjectCloneRequest, type ProjectCloneResult } from './ProjectSourceMenu'
import { mergeDraftConnectors, readNewChatDraft, writeNewChatDraft, type NewChatDraftImage } from './newChatDraft'
import { showToast } from '../../../store/toastStore'
import { SkillsAndMcpsPicker } from './SkillsAndMcpsPicker'
import { launchCommandLineKey, launchPreviewRequest, type LaunchCommandLineState } from './launchCommandLine'
import { drawSuggestions, newSuggestionSeed, type SuggestionEntry } from './suggestionBank'
import { FEATURE_FLAGS } from '../../../featureFlags'
import {
  rowMatchesSelection,
  useAgentComposer,
  type AgentComposerConfirm,
  type AgentComposerConnector,
  type AgentComposerSelection,
} from './useAgentComposer'

export type NewAgentLaunch = AgentComposerConfirm & {
  /** The agent's startup prompt. Empty means "start with nothing typed". */
  prompt: string
}

/** One choosable project scope: a folder some open workspace lives in. */
export type NewAgentProjectOption = { path: string; label: string }

export type NewAgentPanelProps = {
  workspaceId: string
  /** Development gate for the unfinished conversation runtime. */
  conversationModeEnabled?: boolean
  conversationAvailable: boolean
  /**
   * Ask the host to load the conversation provider catalog. `conversationAvailable`
   * stays false until it has, so a surface that never asks can never offer the
   * row — which is exactly what happened while the catalog was loaded by the top
   * bar's menu alone.
   */
  onRequestConversationCatalog?: () => void
  /**
   * Where this launch lands when it is NOT the active workspace's own folder —
   * the New chat door, which creates a solo workspace in a project you pick. The
   * scope line becomes the picker when `projectOptions` come with it.
   */
  folderPath?: string | null
  projectOptions?: NewAgentProjectOption[]
  onSelectProject?: (path: string) => void
  onBrowseProject?: () => void
  initialSelection: AgentComposerSelection
  /** The app-wide default a model row nobody has set still resolves to; the
   *  picker's footer writes per-row, so this is a fallback, never what it edits. */
  permissionPreset: CliPermissionPreset
  debugMode: boolean
  onChangeDebugMode: (next: boolean) => void
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
   * Door-only (remote-sessions-ux / new-chat-on-a-remote-machine): start the
   * chat on a paired machine instead of this one. Present = the panel offers
   * the machine dropdown (This device first, paired machines after — one
   * dropdown, no separate Local/Remote switch; owner ruling 2026-09-03) and
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
}

/** What a remote launch carries: the target, and the launch identity. */
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
  /**
   * Where the chat runs there (checkout-and-branch-on-remote-create): the
   * workspace's current checkout, or a fresh worktree branched from `baseRef`.
   */
  checkout: FleetCheckoutRequest
  /**
   * The branch the chat is on, as far as the panel knows before the create:
   * the remote's current branch for its checkout; for a worktree the branch
   * is minted there and comes back with the create instead.
   */
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
  | { state: 'has'; workspace: FleetWorkspace }
  | { state: 'lacks'; reason: string }
  | { state: 'unreachable'; reason: string }

/** A machine's last browse, stamped so a stale or failed one is asked again. */
type MachineBrowseEntry = 'loading' | { browse: FleetBrowse; at: number }
const MACHINE_BROWSE_HOLD_MS = 30_000

function browseOf(entry: MachineBrowseEntry | undefined): FleetBrowse | 'loading' | undefined {
  return entry === 'loading' || entry === undefined ? entry : entry.browse
}

function machineBrowseStale(entry: MachineBrowseEntry | undefined, now = Date.now()): boolean {
  if (entry === undefined) return true
  if (entry === 'loading') return false
  return !entry.browse.reachable || entry.browse.unauthorized || now - entry.at > MACHINE_BROWSE_HOLD_MS
}

/** Which of a machine's workspaces is the repository in hand, if any. */
export function machineCopyOf(browse: FleetBrowse, identity: RepositoryIdentity | null): FleetWorkspace | null {
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
  machine: FleetConnection,
  browse: FleetBrowse | 'loading' | undefined,
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
  connection: FleetConnection
  /** What `workspace.list` served: the machine's open CHATS, not its projects. */
  workspaces: FleetWorkspace[] | null
  /** Those chats folded into the folders they stand in — the list the chip offers. */
  projects: RemoteProject[] | null
  error: string | null
  picked: RemoteProject | null
  /** The scopes the machine reports NOW (the browse refreshes them), for the worktree gate. */
  scopes: TailnetScope[]
  /** The picked project's checkout facts; null until read, or unreadable (see `checkoutError`). */
  checkout: FleetWorkspaceCheckout | null
  checkoutError: string | null
}

/**
 * Why a fresh worktree cannot be asked for on this target, or null when it
 * can. A worktree is minted by `agent.launch`, which the gateway serves on
 * `workspace:operate` — a pairing without it is refused there, so the option
 * dims here with that reason rather than letting a launch travel to a refusal.
 */
export function remoteWorktreeDisabledReason(target: {
  connection: { machineName: string }
  scopes: readonly TailnetScope[]
  checkout: FleetWorkspaceCheckout | null
  checkoutError: string | null
}): string | null {
  if (!target.scopes.includes('workspace:operate')) {
    return `This pairing may not create worktrees on ${target.connection.machineName} — it needs the workspace:operate scope.`
  }
  if (target.checkoutError) return target.checkoutError
  // Not yet read is not yet allowed: the base to fork from comes off this
  // read, and a remote whose build predates `workspace.checkout` fails it —
  // which is exactly the build whose agent.launch would ignore the base ref.
  if (!target.checkout) return `Reading the checkout on ${target.connection.machineName}…`
  if (!target.checkout.git) return `That project is not a git repository on ${target.connection.machineName}.`
  if (!effectiveBaseRefOf(target.checkout)) return `No branch to fork from on ${target.connection.machineName}.`
  return null
}

/**
 * The base ref a remote worktree launch forks from: the checkout's own branch,
 * else the trunk. Null when the remote has nothing to fork from (a detached
 * checkout with no trunk), which is a disabled worktree row rather than a fork
 * of an arbitrary commit.
 *
 * It took a `picked` override until 2026-09-11, when the scope line's base-ref
 * picker went with the rest of the duplicated worktree controls. A remote fork
 * now starts where the project stands over there — the same promise the local
 * worktree row makes about this disk — so there is nothing to override with.
 */
function effectiveBaseRefOf(checkout: FleetWorkspaceCheckout | null): string | null {
  if (!checkout?.git) return null
  return checkout.branch ?? checkout.defaultBranch ?? null
}

// The greeting rotates per tab open. No exclamation marks and no "we" (the copy
// voice bans both); the name is the first token of the signed-in display name,
// and every line reads correctly without it — a signed-out person gets the same
// welcome, not a prompt to sign in.
const GREETINGS: ReadonlyArray<(name: string | null) => string> = [
  (name) => (name ? `What's up, ${name}?` : "What's up?"),
  (name) => (name ? `What's next, ${name}?` : "What's next?"),
  (name) => (name ? `Ready when you are, ${name}.` : 'Ready when you are.'),
  (name) => (name ? `Where do you want to start, ${name}?` : 'Where do you want to start?'),
]

// The machine picked last, for THIS session only (never persisted): reopening
// New chat keeps the target a person just used, while a fresh app start opens
// on This device — a remote is never preselected on first open.
let lastPickedMachineId: string | null = null

/** Test seam: forget the session's remembered machine. */
export function resetRememberedMachineForTests(): void {
  lastPickedMachineId = null
}

// This device first, then paired machines alphabetically — a list that
// reorders as pairings come and go is one nobody can learn.
export function sortMachines(machines: FleetConnection[]): FleetConnection[] {
  return [...machines].sort((a, b) => a.machineName.localeCompare(b.machineName, undefined, { sensitivity: 'base' }))
}

/**
 * The launch surface behind the tab strip's "+" (v2).
 *
 * One column: who is being greeted, what to do, how it runs, and what to start
 * with. The box sits on the terminal's own ground and carries a `❯`, because it
 * becomes that terminal in place.
 *
 * The control row shows only what a launch usually changes — engine and access —
 * plus the two attachments people reach for. Everything rarer (worktree, debug)
 * lives behind `⋯` and rises onto the row as a chip once set, so the row is a
 * picture of this launch rather than a panel of every knob.
 *
 * Nothing here creates anything: `onLaunch` hands the host a confirm plus the
 * prompt, and the host retypes this tab into the agent's terminal.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationModeEnabled = FEATURE_FLAGS.conversationMode,
  conversationAvailable,
  onRequestConversationCatalog,
  folderPath,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  debugMode,
  onChangeDebugMode,
  onLaunch,
  initialMcpServers,
  onClose,
  showCloseButton = false,
  onLaunchRemote,
  onCloneProject,
  draftKey,
}: NewAgentPanelProps) {
  // The parked draft, read once at mount: what the door held when the person
  // last stepped off it. An explicit connector attachment leads the draft's
  // own picks (a connector "New chat" over a parked draft adds, never doubles).
  const [draft] = React.useState(() => (draftKey ? readNewChatDraft(draftKey) : null))
  const composer = useAgentComposer({
    showTerminal: true,
    conversationAvailable: conversationModeEnabled && conversationAvailable,
    initialSelection: draft?.selection ?? initialSelection,
    initialMcpServers: draft ? mergeDraftConnectors(initialMcpServers, draft.mcpServers) : initialMcpServers,
    initialSkills: draft?.skills,
    // The engine a parked draft was made on, when whoever made it stored none —
    // a card's `Go` picker, which must not move this door's remembered engine
    // on its way past (item 2473). The panel opens standing on that row and
    // launches it; the first row picked here retires it.
    initialEngine: draft?.engine ?? null,
  })
  const { selection } = composer

  const activeWorkspaceRoot = useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === workspaceId)?.folderPath ?? null,
  )
  // An explicit scope wins: skills, the worktree probe and the scope line all
  // have to describe the folder the agent will actually run in.
  const workspaceRoot = folderPath !== undefined ? folderPath : activeWorkspaceRoot
  // Picks were installed and synced into ONE project; a change of project
  // after picking would launch the agent somewhere they are not.
  const pickedForRoot = React.useRef(workspaceRoot)
  React.useEffect(() => {
    if (pickedForRoot.current === workspaceRoot) return
    pickedForRoot.current = workspaceRoot
    composer.setSkills([])
    composer.setMcpServers([])
  }, [composer, workspaceRoot])
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
  // (fetched over the audited fleet client) and routes the launch remotely.
  // Terminal and conversation launches are this machine's only — picking
  // either resets the target rather than lying about where they would run.
  const [remoteMachines, setRemoteMachines] = React.useState<FleetConnection[]>([])
  const [remoteTarget, setRemoteTarget] = React.useState<RemoteTargetState | null>(null)
  // What each paired machine holds, read once per machine per door open
  // (one-project-across-machines): the machine dropdown says which machines
  // have the project in hand, and a pick that keeps the project reads its
  // workspace off this rather than asking the machine again.
  const [machineBrowses, setMachineBrowses] = React.useState<Map<string, MachineBrowseEntry>>(() => new Map())
  const browseMachine = React.useCallback((connection: FleetConnection): Promise<FleetBrowse> => {
    setMachineBrowses((current) => {
      const existing = current.get(connection.id)
      return existing && existing !== 'loading' ? current : new Map(current).set(connection.id, 'loading')
    })
    return window.api
      .fleetBrowse(connection.id)
      .then((browse) => {
        setMachineBrowses((current) => new Map(current).set(connection.id, { browse, at: Date.now() }))
        return browse
      })
      .catch((error: unknown) => {
        const failed: FleetBrowse = {
          connectionId: connection.id,
          reachable: false,
          unreachableReason: error instanceof Error ? error.message : String(error),
          unauthorized: false,
          scopes: connection.scopes,
          terminalAccess: 'none',
          workspaces: [],
          terminals: [],
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
  // A note the panel writes when it moves a choice on the person's behalf —
  // a preset the remote cannot take, say. Shown under the box, not toasted.
  const [remoteNote, setRemoteNote] = React.useState<string | null>(null)
  const remoteCapable = Boolean(onLaunchRemote)
  // The remembered machine is applied once, when the list first arrives.
  const rememberedApplied = React.useRef(false)
  React.useEffect(() => {
    if (!remoteCapable) return
    let cancelled = false
    const load = (): void => {
      void window.api
        .fleetListConnections()
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
      typeof window.api.onFleetEvent === 'function'
        ? window.api.onFleetEvent((event) => {
            if (event.kind === 'machine-paired' || event.kind === 'machine-forgotten') load()
          })
        : null
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [remoteCapable])
  const remoteSelectable = remoteCapable && selection.kind !== 'terminal' && selection.kind !== 'conversation'
  React.useEffect(() => {
    if (!remoteSelectable) setRemoteTarget(null)
  }, [remoteSelectable])
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
    connection: FleetConnection | null,
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
    setRemoteTarget({
      connection,
      workspaces: null,
      projects: null,
      error: null,
      picked: null,
      scopes: connection.scopes,
      checkout: null,
      checkoutError: null,
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
        // "no workspaces on that machine" would be false (the FleetGap
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
          scopes: browse.scopes,
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
  // A remote target takes exactly what its gateway accepts (manual, auto).
  // The moment one is picked, a preset it would refuse — or silently replace
  // with the other machine's default — moves to the nearest supported one and
  // says so; the unsupported rows stay listed, dimmed, with the reason.
  const remotePresetReasons = remoteTarget ? REMOTE_PRESET_DISABLED_REASONS : undefined
  const remoteMachineName = remoteTarget?.connection.machineName ?? null
  React.useEffect(() => {
    if (!remoteTarget) setRemoteNote(null)
  }, [remoteTarget])
  // The picked project's checkout facts (checkout-and-branch-on-remote-create),
  // read over `workspace.checkout` the moment a project is chosen — keyed on
  // the machine and the project, so a re-pick re-reads and a browse settling
  // does not. A refusal (a read-only pairing, a machine gone quiet) is kept
  // as the reason the worktree option dims with, never as an empty branch list.
  const remoteConnectionId = remoteTarget?.connection.id ?? null
  // `workspace.checkout` is keyed by workspace id, and a project's seat is one
  // of the chats standing in it — every chat in a folder answers for the folder.
  const remotePickedId = remoteTarget?.picked?.workspaceId ?? null
  React.useEffect(() => {
    if (!remoteConnectionId || !remotePickedId) return
    let cancelled = false
    void window.api
      .fleetWorkspaceCheckout(remoteConnectionId, remotePickedId)
      .then((result) => {
        if (cancelled) return
        setRemoteTarget((current) => {
          if (current?.connection.id !== remoteConnectionId || current.picked?.workspaceId !== remotePickedId)
            return current
          if (!result.ok) return { ...current, checkout: null, checkoutError: result.message }
          return { ...current, checkout: result.checkout, checkoutError: null }
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setRemoteTarget((current) =>
          current?.connection.id === remoteConnectionId && current.picked?.workspaceId === remotePickedId
            ? { ...current, checkout: null, checkoutError: error instanceof Error ? error.message : String(error) }
            : current,
        )
      })
    return () => {
      cancelled = true
    }
  }, [remoteConnectionId, remotePickedId])
  // The ⋯ worktree row is the ONLY worktree control now, local or remote
  // (owner, 2026-09-11), so picking a machine no longer clears it. A worktree
  // asked for on a remote target travels as `FleetCheckoutRequest.name` — the
  // same branch name the local spawn mints its worktree on — and the gate
  // below is what stops one being asked for where the pairing cannot make it.
  const activeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? (resolveWorkspaceWorktree(ws)?.branch ?? null) : null
  })
  // A branch belongs to the workspace's own checkout; a chat scoped to another
  // project is not on it, and printing it there would be a lie.
  const branch = folderPath !== undefined && folderPath !== activeWorkspaceRoot ? null : activeBranch
  const pluginCatalogEntries = useWorkspaceStore((s) => s.pluginCatalogEntries)
  const cliRuntimes = useWorkspaceStore((s) => s.appSettings.cliRuntimes)
  const displayName = useWorkspaceStore((s) => s.authState.user?.displayName ?? null)
  const openSettingsOverlay = useWorkspaceStore((s) => s.openSettingsOverlay)

  const [prompt, setPrompt] = React.useState(() => draft?.prompt ?? '')
  const [enginePopoverOpen, setEnginePopoverOpen] = React.useState(false)
  const [moreOpen, setMoreOpen] = React.useState(false)
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

  const insertPromptPath = (path: string) => {
    setPrompt((current) =>
      current.length === 0 || /\s$/.test(current) ? `${current}${quotePath(path)} ` : `${current} ${quotePath(path)} `,
    )
    promptRef.current?.focus()
  }

  const attachDroppedFiles = async (files: File[]) => {
    setAttachNote(null)
    for (const file of files) {
      const existingPath = window.api.getPathForFile(file)
      const isImage = (ATTACHABLE_IMAGE_TYPES as readonly string[]).includes(file.type)
      // A non-image with a path is a path: it goes into the prompt as text, the
      // way a drop onto a terminal would. One with no path falls through to the
      // save, which refuses it with a message rather than silently swallowing it.
      if (existingPath && !isImage) {
        insertPromptPath(existingPath)
        continue
      }
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

  const removeImage = (id: string) => setImages((current) => current.filter((image) => image.id !== id))

  // The name is a greeting, not an identity claim: an email local-part reads
  // worse than no name at all, so only a real display name is used.
  const firstName = React.useMemo(() => {
    const token = (displayName ?? '').trim().split(/\s+/)[0] ?? ''
    return token.length > 0 ? token : null
  }, [displayName])
  // Held for the life of the tab — a re-render must not re-greet.
  const [greetingIndex] = React.useState(() => Math.floor(Math.random() * GREETINGS.length))
  const greeting = GREETINGS[greetingIndex % GREETINGS.length](firstName)

  // Neither a plain shell nor a conversation agent launches a CLI, so neither
  // may wear a CLI's chip, its flags, or its command line.
  const launchCli: AgentCli | null =
    selection.kind === 'terminal' || selection.kind === 'conversation' ? null : composer.selectionCli
  const engineNames = composer.engineNamesFor(selection)
  const model = launchCli ? composer.modelForSelection(selection, launchCli) : undefined
  const reasoning = launchCli ? composer.reasoningForSelection(selection, launchCli) : undefined
  // Permissions are a property of the ROW (owner, 2026-09-05): the preset this
  // launch runs on is the one stored against the picked model, and the host's
  // `permissionPreset` is only the app-wide default a row nobody has set still
  // resolves to. Everything the surface says about permissions — the
  // command-line preview, the remote coercion, what the launch carries — reads
  // THIS, never the prop. A terminal or a conversation has no row and no
  // permission flag, so it simply reads the fallback and shows no control.
  const effectivePreset = useModelPermissionPreset(launchCli, model ?? null, permissionPreset)
  // A remote machine cannot take every preset. The moment one is picked, a
  // preset it would refuse — or silently replace with its own default — moves
  // to the nearest supported one and says so. It lives here, below the row
  // derivations, because what it coerces is the PICKED ROW's preset.
  React.useEffect(() => {
    // Keyed on the MACHINE, not the target object: the browse resolving
    // replaces the object, and the move must happen once per pick.
    if (!remoteMachineName) return
    if (REMOTE_PERMISSION_PRESETS.has(effectivePreset)) return
    const next = nearestRemotePermissionPreset(effectivePreset)
    const from =
      agentPermissionOptions(launchCli).find((option) => option.value === effectivePreset)?.label ?? effectivePreset
    const to = agentPermissionOptions(launchCli).find((option) => option.value === next)?.label ?? next
    // The move is written against the ROW the machine refused it for, so
    // picking a local model back does not inherit the remote's narrowing.
    setModelPermissionPreset(launchCli, model ?? null, next)
    setRemoteNote(`Switched permissions from ${from} to ${to}: ${from} is not available on ${remoteMachineName}.`)
  }, [effectivePreset, launchCli, model, remoteMachineName])

  // ── The skill trigger ────────────────────────────────────────────────────
  const skillIntegration = React.useMemo(() => {
    if (!launchCli) return undefined
    return pluginCatalogEntries.find((entry) => entry.id === launchCli)?.skillIntegration
  }, [launchCli, pluginCatalogEntries])
  const mentionPrefix = resolveSkillMentionPrefix(skillIntegration)

  const [mentionDismissed, setMentionDismissed] = React.useState(false)
  const mentionRef = React.useRef<InlineSkillPickerHandle | null>(null)
  const mentionQuery = React.useMemo(() => {
    if (!mentionPrefix || mentionDismissed) return null
    const match = new RegExp(`(?:^|\\s)\\${mentionPrefix}([^\\s]*)$`).exec(prompt)
    return match ? match[1] : null
  }, [mentionDismissed, mentionPrefix, prompt])

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
      cli: launchCli,
      model,
      reasoning,
      permissionPreset: effectivePreset,
      runtime: launchCli ? cliRuntimes?.[launchCli] : undefined,
    }),
    [cliRuntimes, effectivePreset, launchCli, model, reasoning],
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
  const canLaunch = composer.visibleRows.some((row) => rowMatchesSelection(row, selection))

  const launch = (text: string) => {
    if (!canLaunch) return
    if (remoteTarget) {
      if (!remoteTarget.picked || !onLaunchRemote || remoteLaunching) return
      const confirm = composer.buildConfirm(selection)
      if (confirm.kind !== 'general') return
      // What cannot travel must not be silently dropped while its chip is on
      // screen: skills install locally, MCP servers were synced into the LOCAL
      // workspace config, and debug drives the local state machine.
      // Images too: a local path means nothing on another machine, and there
      // is no upload path to the remote today (uploading them into the remote
      // environment is the future path; until it exists the refusal names them
      // rather than dropping them while their chips stay on screen).
      //
      // The worktree left this list on 2026-09-11: it DOES travel now. The
      // remote mints it, on the branch name the ⋯ row carries, through the same
      // `agent.launch` mutation that already owned remote worktree creation.
      const stranded = [
        confirm.skills?.length ? 'the skills' : null,
        confirm.mcpServers?.length ? 'the MCP servers' : null,
        debugMode ? 'debug mode' : null,
        images.length > 0 ? 'the attached images' : null,
      ].filter((entry): entry is string => entry !== null)
      if (stranded.length > 0) {
        showToast({
          tone: 'warn',
          title: 'That launch cannot travel yet',
          description: `Remove ${stranded.join(', ')} to start on ${remoteTarget.connection.machineName}, or launch on This device.`,
        })
        return
      }
      // Never a value the gateway will refuse after a round-trip: the effect
      // above already moved the choice, and this is the belt to its braces.
      if (!REMOTE_PERMISSION_PRESETS.has(effectivePreset)) return
      // A worktree the gate has since closed on (a scope read that came back
      // narrower, a project that turned out not to be a repo) never travels:
      // the pick falls back to the checkout it can have.
      //
      // The base is the remote checkout's OWN branch, never a branch this
      // machine chose: the local worktree row forks from where the project
      // stands, and a remote fork is the same promise about someone else's
      // disk. `confirm.worktree.name` empty means "name it after the agent",
      // which is the remote's own default when the field is absent.
      const worktreeBlocked = remoteWorktreeDisabledReason(remoteTarget) !== null
      const worktreeName = confirm.worktree?.name.trim()
      const baseRef = confirm.worktree ? effectiveBaseRefOf(remoteTarget.checkout) : null
      const checkout: FleetCheckoutRequest =
        confirm.worktree && !worktreeBlocked && baseRef
          ? { mode: 'worktree', baseRef, ...(worktreeName ? { name: worktreeName } : {}) }
          : { mode: 'current' }
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
        checkout,
        branch: checkout.mode === 'current' ? (remoteTarget.checkout?.branch ?? null) : null,
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
    onLaunch({ ...composer.buildConfirm(selection), prompt })
  }

  React.useEffect(() => {
    const id = requestAnimationFrame(() => promptRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Ask once per open, so a provider configured since last time shows up.
  React.useEffect(() => {
    if (!conversationModeEnabled) return
    onRequestConversationCatalog?.()
  }, [conversationModeEnabled, onRequestConversationCatalog])

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
  // The Skills & MCPs trigger on the row is where skills are offered now; the
  // inline `$`/`/` type-ahead still works, it just no longer needs advertising.
  const placeholder = isTerminalLaunch ? 'A shell opens with nothing typed' : 'Describe the task…'

  if (composer.noAgentCliInstalled) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 py-8">
        <div className="mx-auto w-full max-w-[620px]">
          <h1 className="text-center text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
            No agent CLI is installed on this machine.
          </h1>
          <p className="mt-1 text-center text-body text-[color:var(--text-muted)]">
            Install one to start an agent here.
          </p>
          <div className="mt-5">
            <CliInstallCta />
          </div>
        </div>
      </div>
    )
  }

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
      <div className="@container mx-auto w-full max-w-[620px]">
        <div className="text-center">
          {/* icon-lg is the top of the icon scale and the step the system names for
            empty-state glyphs. There is no larger token, and an off-scale hero
            mark is what made this fill the pane. */}
          <SprintEngineFrond tone="current" className="icon-lg mx-auto text-[color:var(--text-strong)]" />
          <h1 className="mt-2.5 text-title font-semibold tracking-[-0.01em] text-[color:var(--text-strong)]">
            {greeting}
          </h1>
          {/* State, not decoration: where this agent will run.
              Whether this is a PICKER is decided by what the host can do, never
              by what it currently has. Gating on `projectLabel` hid the control
              outright when no project was set, and gating on a non-empty
              `projectOptions` hid it when no other workspace happened to be
              open — so the two moments a person most needs to choose a project
              were the two moments the choice disappeared, taking the Browse
              escape hatch with it. A host that passes no project handlers (the
              tab strip's "+", which spawns into the workspace it was pressed
              in) still gets the plain line, because there its project is a fact
              rather than a choice. */}
          <div className="mt-1 flex items-center justify-center gap-1.5">
            {/* One machine dropdown, This device first (owner ruling 2026-09-03
                — no separate Local/Remote switch). Shown whenever a remote
                launch is possible and a machine is paired; on This device the
                line reads exactly as it always did. */}
            {remoteSelectable && remoteMachines.length > 0 ? (
              <MachineScopePicker
                machines={remoteMachines}
                selected={remoteTarget?.connection ?? null}
                onSelect={(connection) => pickRemoteMachine(connection)}
                availability={(machine) =>
                  machineAvailabilityOf(machine, browseOf(machineBrowses.get(machine.id)), activeIdentity)
                }
                // With a project in hand, opening the list asks every machine
                // what it holds — once, then again when the answer is old or
                // was "not answering" (a machine asleep at the first open
                // must be pickable once it wakes). Without a project there
                // is nothing to filter by, and the list is the plain one.
                onOpen={() => {
                  if (!activeIdentity) return
                  for (const machine of remoteMachines) {
                    if (machineBrowseStale(machineBrowses.get(machine.id))) void browseMachine(machine)
                  }
                }}
                projectName={activeIdentity?.name ?? null}
              />
            ) : null}
            {remoteTarget ? (
              <RemoteProjectPicker
                target={remoteTarget}
                color={scopeProjectColor}
                onPick={(project) => {
                  setRemoteTarget((current) =>
                    current ? { ...current, picked: project, checkout: null, checkoutError: null } : current,
                  )
                }}
              />
            ) : canChooseProject ? (
              <ProjectScopePicker
                label={projectLabel ?? 'Choose a project'}
                branch={branch}
                options={projectOptions ?? []}
                selectedPath={workspaceRoot}
                onSelect={(path) => onSelectProject?.(path)}
                onBrowse={onBrowseProject}
                onClone={onCloneProject}
                // The hue, resolved here because only this component holds the
                // repository identity behind the folder; the identity map goes
                // with it so the rows IN the list wear their own colours too,
                // read from the map this panel already asked main for rather
                // than a second round of the same IPC.
                color={scopeProjectColor}
                unfiled={!workspaceRoot?.trim()}
                identities={localIdentities}
              />
            ) : projectLabel ? (
              // The tab strip's "+": the project is a fact rather than a choice,
              // so this is a line and not a control — but it is the same line,
              // and it wears the same glyph in the same hue. Every state of the
              // scope line carries the colour, or the colour stops being how you
              // tell one project from another.
              <p className="inline-flex items-center gap-1.5 text-meta text-[color:var(--text-subtle)]">
                <FolderIdentityIcon folderPath={workspaceRoot} className="icon-xs shrink-0" color={scopeProjectColor} />
                <span className="min-w-0 truncate">
                  {projectLabel}
                  {branch ? ` · ${branch}` : ''}
                </span>
              </p>
            ) : null}
            {/* The scope line is machine · project, and nothing else (owner,
                2026-09-11). A "Current checkout" chip and a branch segment used
                to grow here the moment a remote project was picked, which put
                the worktree question in TWO places on one surface: up on this
                line for a remote target, and down behind ⋯ for a local one.
                One control now — the ⋯ Worktree row — and it serves both. */}
          </div>
        </div>

        <div
          // The box owns the visible border while the textarea inside it is the
          // tab stop, so the product's one focus ring lands on the box keyed to
          // the textarea's own focus (`FOCUS_RING_WITHIN_TEXTAREA_CLASS`) — not
          // an accent border swap on `focus-within`, which lit the box for the
          // footer's buttons too and was a second focus idiom.
          className={`relative mt-5 px-3 pb-2 pt-2.5 ${COMPOSER_SURFACE_CLASS} ${FOCUS_RING_WITHIN_TEXTAREA_CLASS} ${
            dropActive ? 'border-[color:var(--accent-primary)]' : 'border-[color:var(--border-default)]'
          }`}
          onDragEnter={(event) => {
            if (isTerminalLaunch || !dataTransferHasFiles(event.dataTransfer)) return
            dragDepthRef.current += 1
            setDropActive(true)
          }}
          onDragOver={(event) => {
            // Claiming the drag is what stops the window from navigating to the
            // dropped file, so it has to happen on every dragover.
            if (isTerminalLaunch || !dataTransferHasFiles(event.dataTransfer)) return
            event.preventDefault()
          }}
          onDragLeave={(event) => {
            if (isTerminalLaunch || !dataTransferHasFiles(event.dataTransfer)) return
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setDropActive(false)
          }}
          onDrop={(event) => {
            if (isTerminalLaunch || !dataTransferHasFiles(event.dataTransfer)) return
            event.preventDefault()
            dragDepthRef.current = 0
            setDropActive(false)
            void attachDroppedFiles(filesFromDataTransfer(event.dataTransfer))
          }}
        >
          {/* Opaque, not a scrim: the field's own text ghosting through the
              drop state reads as a rendering artifact rather than a state. */}
          {dropActive && !isTerminalLaunch ? (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[color:var(--bg-app)] text-meta font-medium text-[color:var(--accent-primary)]">
              Drop to attach
            </div>
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
            className="pb-2"
          />

          <div className="flex items-start gap-2">
            {/* The prompt caret as an SVG glyph, not a text character: a
                character picks up the font's rendering and the guard's
                emoji-as-icon rule for a reason. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              className="mt-1 size-icon-sm shrink-0 select-none text-[color:var(--accent-primary)]"
            >
              <path
                d="M5.5 3.5 10 8l-4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {/* Grows with its content (field-sizing: content) from the two-row
                floor to a ceiling, then scrolls — a box that showed two lines
                of a six-line prompt was hiding what the person was about to
                send. Same treatment as the automation editor's prompt field. */}
            {/* `composer` is the kit's hosted multiline field: no box of its
                own, because `COMPOSER_SURFACE_CLASS` around it draws the
                border, the ground and the ring, and `field-sizing-content`
                between the caller's floor and ceiling. */}
            <Textarea
              ref={promptRef}
              variant="composer"
              resize="none"
              value={prompt}
              rows={2}
              onPaste={(event) => {
                // A pasted screenshot only exists as a clipboard item; a text
                // paste reports no image and falls through to the default.
                const files = imageFilesFromDataTransfer(event.clipboardData)
                if (files.length === 0) return
                event.preventDefault()
                void attachDroppedFiles(files)
              }}
              onChange={(event) => {
                setPrompt(event.currentTarget.value)
                setMentionDismissed(false)
              }}
              onKeyDown={onPromptKeyDown}
              placeholder={placeholder}
              disabled={isTerminalLaunch}
              aria-label="What this agent should do"
              className="max-h-[280px] min-h-[44px] flex-1 overflow-y-auto font-mono text-body"
            />
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-[color:var(--border-subtle)] pt-2">
            {/* Engine: the CLI's own mark, then the model. The mark is the
                identity — the word "claude" beside a Claude asterisk was saying
                it twice. */}
            {launchCli ? (
              <Popover
                open={enginePopoverOpen}
                onOpenChange={setEnginePopoverOpen}
                ariaLabel={`Engine: ${engineNames.cliLabel}`}
                popupRole="menu"
                placement="bottom-start"
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  // The kit's chip. `outline` is the variant that stays findable
                  // on a busy strip; the accent-soft ground it used to wear is
                  // gone, because a solid-ish accent on a standing chip is the
                  // budget spent on a state display rather than on the view's
                  // one primary action (principles.md → The accent budget).
                  <ChipButton
                    ref={ref}
                    variant="outline"
                    tone="neutral"
                    onClick={togglePopover}
                    // Named, not left to its contents: the chip is a mark plus a
                    // truncated label, and it is the only way to the model,
                    // effort and permissions the picker holds.
                    aria-label={`Engine: ${engineNames.modelLabel ?? engineNames.cliLabel}`}
                    {...triggerProps}
                  >
                    <CliIcon cli={launchCli} className="icon-xs" />
                    <TruncatedText
                      as="span"
                      text={engineNames.modelLabel ?? engineNames.cliLabel}
                      className="max-w-[150px]"
                    />
                    {reasoning ? <span className="text-[color:var(--text-subtle)]">· {reasoning}</span> : null}
                    <ChevronGlyph />
                  </ChipButton>
                )}
              >
                {/* Reasoning effort is a property OF the model, so it lives in
                    the model's own picker (attached to the selected row, which
                    is where this surface already draws it) rather than as a
                    second control the row has to carry. */}
                <CliModelPopoverSurface
                  ariaLabel="Agent runtime"
                  options={composer.agentCliOptions}
                  currentCli={launchCli}
                  effectiveModelFor={(cli) => composer.modelForSelection(selection, cli)}
                  effectiveReasoningFor={(cli) => composer.reasoningForSelection(selection, cli)}
                  onSelectReasoning={(cli, next) => composer.setEngineReasoning(selection, cli, next)}
                  showReasoning
                  reasoningAriaLabel="Reasoning effort"
                  onSelectCli={(cli) => composer.setEngineCli(selection, cli)}
                  onSelectModel={(cli, next) => composer.setEngineModel(selection, cli, next)}
                  // Permissions live in the picker rather than on a chip beside
                  // it (owner, 2026-09-05). A preset is a property of the runtime
                  // the row names — Claude Code's auto mode is not Codex's
                  // sandbox, and the repo you trust one model in is not the one
                  // you trust the next in — so it is chosen where the model is,
                  // remembered against that row, and sits on the picker's one
                  // trailing row beside the effort control.
                  permissions={(cli, rowModel) => (
                    <SpawnPermissionFooter
                      cli={cli}
                      model={rowModel}
                      fallback={permissionPreset}
                      {...(remotePresetReasons ? { disabledReasons: remotePresetReasons } : {})}
                      onSelect={() => setRemoteNote(null)}
                    />
                  )}
                />
              </Popover>
            ) : null}

            {/* Every pick is a chip; the one trigger opens the picker for more.
                A terminal launches nothing that reads a skill or an MCP. */}
            {selection.kind !== 'terminal' ? (
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
                <SkillsAndMcpsPicker
                  workspaceRoot={workspaceRoot}
                  // A conversation agent is not a CLI: the workspace-wide inventory
                  // is the honest list for it.
                  pluginId={selection.kind === 'conversation' ? null : launchCli}
                  skills={composer.skills}
                  onSkillsChange={composer.setSkills}
                  mcpServers={composer.mcpServers}
                  onMcpServersChange={composer.setMcpServers}
                  placement="bottom-start"
                />
              </>
            ) : null}

            {/* Set rarities rise onto the row; unset ones live behind ⋯. */}
            {composer.worktreeName !== null ? (
              <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)]">
                <BranchGlyph />
                {/* Sized to what is typed, not a fixed field: a chip that
                    reserves 128px for a three-letter branch is what pushed this
                    row onto a second line. */}
                <Input
                  variant="seamless"
                  fullWidth={false}
                  value={composer.worktreeName}
                  onChange={(event) => composer.setWorktreeName(event.currentTarget.value)}
                  placeholder="branch name"
                  aria-label="Worktree name — leave empty to derive from the agent’s name"
                  // `field-sizing-content` in place of the `size` attribute the
                  // kit's `size` prop takes the name of: the box tracks what is
                  // typed rather than a character count guessed per render.
                  className="field-sizing-content min-w-[8ch] max-w-[160px] text-meta"
                />
                <CloseIconButton
                  onClick={() => composer.setWorktreeName(null)}
                  aria-label="Remove worktree"
                  className="-mr-1"
                />
              </span>
            ) : null}
            {debugMode ? (
              <AttachmentChip
                glyph={<DebugGlyph />}
                label="Debug"
                removeLabel="Turn debug mode off"
                onRemove={() => onChangeDebugMode(false)}
              />
            ) : null}

            {/* Always rendered, whatever is selected: this menu is the only way
                to change WHAT is being launched, so hiding it for a terminal
                stranded the surface with no way back to an agent. */}
            {
              <Popover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                ariaLabel="More launch options"
                popupRole="menu"
                placement="bottom-start"
                surfaceClassName={`w-[264px] ${MENU_LIST_CLASS}`}
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <ChipButton
                    ref={ref}
                    variant="outline"
                    aria-label="More launch options"
                    onClick={togglePopover}
                    {...triggerProps}
                  >
                    ⋯
                  </ChipButton>
                )}
              >
                <MoreMenu
                  selection={selection}
                  conversationModeEnabled={conversationModeEnabled}
                  conversationAvailable={conversationAvailable}
                  onSelectKind={(next) => {
                    composer.setSelection(next)
                    setMoreOpen(false)
                  }}
                  onOpenProviderSettings={() => {
                    setMoreOpen(false)
                    openSettingsOverlay({ initialTab: 'agents' })
                  }}
                  worktreeName={composer.worktreeName}
                  onToggleWorktree={() => composer.setWorktreeName(composer.worktreeName === null ? '' : null)}
                  onChangeWorktree={composer.setWorktreeName}
                  // One row for both targets now. A remote one is offered it
                  // once a project is picked — until then there is no checkout
                  // to fork and nothing to say about it — and the reason it
                  // cannot have one dims the row instead of hiding it, which is
                  // the menu spec's rule for a choice that stays true tomorrow.
                  worktreeAvailable={remoteTarget ? remoteTarget.picked !== null : workspaceIsGitRepo}
                  worktreeReason={remoteTarget ? remoteWorktreeDisabledReason(remoteTarget) : null}
                  debugMode={debugMode}
                  onToggleDebug={() => onChangeDebugMode(!debugMode)}
                />
              </Popover>
            }

            <span className="flex-1" />

            {/* The invocation lives on Start's hover: the one moment someone
                asks "what am I about to run?", and it answers with the line
                main renders through the spawn's own argv renderer. */}
            <Tooltip
              content={
                selection.kind === 'terminal'
                  ? 'Opens a shell in this folder'
                  : selection.kind === 'conversation'
                    ? 'Starts a conversation agent — pick its model in the chat'
                    : commandLine.status === 'ready'
                      ? commandLine.preview.display
                      : commandLine.status === 'error'
                        ? commandLine.message
                        : 'Reading this agent’s launch command…'
              }
              placement="top"
              multiline
            >
              {/* The key that starts it, not the word "Start" and not a chat
                  send-arrow: this launches a command, and a circle-arrow is the
                  idiom for posting a message into a thread. The glyph names the
                  keyboard path, so the shortcut stops being invisible, and the
                  accessible name carries the verb for anyone who cannot see it. */}
              {/* The composer's one primary, built from the kit (ruling 9):
                  `PrimaryButton` squared to the `xs` control step, so the
                  send carries the accent fill, the canon disabled treatment
                  and the shared ring rather than a private 28px recipe. */}
              <PrimaryButton
                size="xs"
                onClick={() => launch(prompt)}
                disabled={!canLaunch}
                aria-label="Start agent"
                aria-keyshortcuts="Enter"
                className="aspect-square shrink-0 font-mono"
              >
                <span aria-hidden="true">⏎</span>
              </PrimaryButton>
            </Tooltip>
          </div>
        </div>

        {attachNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--tone-error)]">
            {attachNote}
          </p>
        ) : null}
        {remoteNote ? (
          <p role="status" className="mt-1.5 text-meta leading-5 text-[color:var(--text-muted)]">
            {remoteNote}
          </p>
        ) : null}

        {isTerminalLaunch ? null : (
          <div className="mt-4 grid grid-cols-1 gap-2 @[520px]:grid-cols-2">
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

function BranchGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--accent-primary)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="6" r="1.75" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4.5 5.25v5.5M11.5 7.75c0 2-1.5 3-4 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function DebugGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--accent-primary)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="5" y="5" width="6" height="7" rx="3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2.5 7.5h2.5M11 7.5h2.5M2.5 11h2.5M11 11h2.5M8 2.5V5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * The machine dropdown (remote-sessions-ux / new-chat-on-a-remote-machine):
 * This device is the first entry and the default; paired machines follow with
 * the shared stacked-server mark. One dropdown — the owner rejected a
 * separate Local/Remote switch as redundant.
 */
function MachineScopePicker({
  machines,
  selected,
  onSelect,
  availability,
  onOpen,
  projectName,
}: {
  machines: FleetConnection[]
  selected: FleetConnection | null
  onSelect: (connection: FleetConnection | null) => void
  /** Whether each machine holds the project in hand (one-project-across-machines); `none` lists it plainly. */
  availability?: (machine: FleetConnection) => MachineAvailability
  onOpen?: () => void
  /** The project in hand, named in the dimmed rows' reasons and the list's heading. */
  projectName?: string | null
}) {
  const [open, setOpen] = React.useState(false)
  const availabilityOf = (machine: FleetConnection): MachineAvailability => availability?.(machine) ?? { state: 'none' }
  const chosen = (machine: FleetConnection): boolean => {
    const state = availabilityOf(machine).state
    return state !== 'lacks' && state !== 'unreachable'
  }
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-machine-option="true"]', activate)
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
        // The kit's ghost chip: `px-1.5 py-0.5` on the line box, and the
        // `subtle` tone's `--text-default` hover ink, both of which this
        // scope-line trigger already spelled.
        <ChipButton ref={ref} onClick={togglePopover} data-machine-trigger="true" {...triggerProps}>
          {selected ? <RemoteMachineGlyph className="icon-xs shrink-0" /> : null}
          {selected ? selected.machineName : 'This device'}
          <ChevronGlyph />
        </ChipButton>
      )}
    >
      {/* The surface is the menu; these are its rows. The leading slot is
          all-or-nothing per the menu spec, so This device renders an empty slot
          the width of the machine glyph rather than sliding its label left. */}
      <MenuOption
        role="menuitemradio"
        selected={selected === null}
        data-machine-option="true"
        tabIndex={selected === null ? 0 : -1}
        onKeyDown={(event) =>
          rowKey(event, () => {
            onSelect(null)
            setOpen(false)
          })
        }
        onClick={() => {
          onSelect(null)
          setOpen(false)
        }}
        icon={<span aria-hidden="true" className="icon-xs shrink-0" />}
      >
        This device
      </MenuOption>
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
            icon={<RemoteMachineGlyph className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`} />}
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
 * A remote machine's projects: its workspaces, served over the fleet client.
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
        <ChipButton ref={ref} onClick={togglePopover} data-project-trigger="true" {...triggerProps}>
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

/**
 * The ⋯ surface: what a launch rarely changes. Reasoning effort went into the
 * model's own picker, where it is a property of the model rather than a second
 * control the row must carry.
 */
function MoreMenu({
  selection,
  conversationModeEnabled,
  conversationAvailable,
  onSelectKind,
  onOpenProviderSettings,
  worktreeName,
  onToggleWorktree,
  onChangeWorktree,
  worktreeAvailable,
  worktreeReason,
  debugMode,
  onToggleDebug,
}: {
  selection: AgentComposerSelection
  conversationModeEnabled: boolean
  conversationAvailable: boolean
  onSelectKind: (next: AgentComposerSelection) => void
  onOpenProviderSettings: () => void
  worktreeName: string | null
  onToggleWorktree: () => void
  onChangeWorktree: (next: string | null) => void
  worktreeAvailable: boolean
  /**
   * Why this target cannot have a worktree, when it cannot — a pairing without
   * `workspace:operate`, a project that is not a repository, a checkout still
   * being read. The row stays listed and dims with the sentence rather than
   * disappearing: it is a choice that will be true again, not one that does not
   * exist here. Null when the worktree can be asked for.
   */
  worktreeReason?: string | null
  debugMode: boolean
  onToggleDebug: () => void
}) {
  const worktreeRef = React.useRef<HTMLInputElement>(null)

  // The Popover surface is the menu and carries the list class; this is its
  // content, not a second menu.
  return (
    <>
      {/* What is being launched. An agent is the answer nearly every time, so it
          stays the default and lives here rather than on the row — but a plain
          shell and a conversation agent have to be reachable somewhere, and this
          is the surface that starts them. */}
      <MenuRow
        selected={selection.kind !== 'terminal' && selection.kind !== 'conversation'}
        label="Agent"
        hint="A CLI agent, in a terminal"
        onClick={() => onSelectKind({ kind: 'general' })}
      />
      <MenuRow
        selected={selection.kind === 'terminal'}
        label="Terminal"
        hint="A plain shell — no agent"
        onClick={() => onSelectKind({ kind: 'terminal' })}
      />
      {conversationModeEnabled ? (
        <MenuRow
          selected={selection.kind === 'conversation'}
          disabled={!conversationAvailable}
          // "Chat", not "Conversation agent": the trio reads as what you GET —
          // an agent in a terminal, a plain shell, or an agent in a window — and
          // "conversational agent" names the mechanism instead. The app already
          // calls this door New chat and renders it through AgentChatView.
          label="Chat"
          hint={
            conversationAvailable
              ? 'An agent in a chat window — no terminal'
              : 'Needs a model provider — connect one in Settings'
          }
          onClick={() => {
            if (conversationAvailable) onSelectKind({ kind: 'conversation' })
            else onOpenProviderSettings()
          }}
        />
      ) : null}
      <div className={MENU_DIVIDER_CLASS} role="separator" />

      {/* A conversation has no repo checkout of its own, so no worktree. */}
      {worktreeAvailable && selection.kind !== 'conversation' ? (
        <>
          <MenuValueRow
            label="Worktree"
            value={worktreeReason ? 'Unavailable' : worktreeName === null ? 'Off' : worktreeName || 'Named on start'}
            expanded={!worktreeReason && worktreeName !== null}
            disabled={Boolean(worktreeReason)}
            hint={worktreeReason ?? null}
            onClick={() => {
              if (worktreeReason) return
              onToggleWorktree()
              // Opening it puts the caret where the name goes — the click that
              // turns it on is the same click that starts typing.
              if (worktreeName === null) {
                window.requestAnimationFrame(() => worktreeRef.current?.focus())
              }
            }}
          />
          {/* The reveal is the app's "just changed" motion, and it collapses to
              nothing when off rather than reserving the row. */}
          <div
            className={`grid transition-[grid-template-rows,opacity] duration-[var(--motion-normal)] ease-[var(--motion-ease)] ${
              worktreeReason || worktreeName === null ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            }`}
          >
            <div className="overflow-hidden">
              {/* `quiet` is the field a floating surface hosts: a transparent
                  ground and a `border.subtle` hairline, because `bg.field`
                  inside an already-grounded menu reads as a panel nested in a
                  panel. `content` gives the height back to the menu's own
                  rhythm. */}
              <Input
                ref={worktreeRef}
                variant="quiet"
                size="content"
                value={worktreeName ?? ''}
                onChange={(event) => onChangeWorktree(event.currentTarget.value)}
                placeholder="Branch name — blank uses the agent’s"
                aria-label="Worktree branch name"
                aria-hidden={Boolean(worktreeReason) || worktreeName === null}
                tabIndex={worktreeReason || worktreeName === null ? -1 : 0}
                className="mx-2 mb-1 w-[calc(100%-1rem)] text-meta"
              />
            </div>
          </div>
          <div className={MENU_DIVIDER_CLASS} role="separator" />
        </>
      ) : null}

      <MenuRow
        selected={debugMode}
        label="Debug mode"
        // Not about debugging the agent: it hands the agent the debug skill's
        // state machine to find a bug in YOUR software, instrumenting the code
        // and removing every tag before it finishes.
        hint="The agent instruments your code, works the debug loop, then cleans up"
        onClick={onToggleDebug}
      />
    </>
  )
}

function MenuValueRow({
  label,
  value,
  expanded = false,
  disabled = false,
  hint = null,
  onClick,
}: {
  label: string
  value: string
  expanded?: boolean
  /** Listed and dimmed with its `hint`, per the menu spec — never hidden. */
  disabled?: boolean
  /** The one line under the label: why a dimmed row is dimmed. */
  hint?: string | null
  onClick: () => void
}) {
  return (
    // The kit's action row, with `expanded` — the prop that says a row is a
    // DOOR rather than a choice — and the current value plus the chevron in the
    // trailing slot. Full-bleed like its sibling rows (menu spec): the inset
    // rounded fill is the card-in-a-card the spec retires.
    <MenuItem
      onClick={onClick}
      disabled={disabled || undefined}
      expanded={expanded || undefined}
      trailing={
        <>
          <span className="max-w-[110px] shrink-0 truncate text-[color:var(--text-subtle)]">{value}</span>
          <span aria-hidden="true" className="shrink-0 text-micro text-[color:var(--text-disabled)]">
            ›
          </span>
        </>
      }
    >
      {hint ? (
        <>
          <span className="block text-body">{label}</span>
          <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span>
        </>
      ) : (
        label
      )}
    </MenuItem>
  )
}

// An image staged on the prompt: the chat composer's attachment shape (so the
// shared strip renders it) plus the file path that stands in for it once the
// prompt becomes text.
type PromptImage = NewChatDraftImage

// Quoted only when the path needs it, matching the terminal drop idiom.
function quotePath(path: string): string {
  return /\s/.test(path) ? `'${path}'` : path
}

function AttachmentChip({
  glyph,
  label,
  removeLabel,
  onRemove,
}: {
  glyph: React.ReactNode
  label: string
  removeLabel: string
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta font-medium text-[color:var(--text-strong)]">
      {glyph}
      <TruncatedText as="span" text={label} className="max-w-[140px]" />
      <CloseIconButton onClick={onRemove} aria-label={removeLabel} className="-mr-1" />
    </span>
  )
}

function MenuRow({
  selected,
  disabled = false,
  label,
  hint,
  onClick,
}: {
  selected: boolean
  /** Listed but not choosable yet — the hint says what is missing. */
  disabled?: boolean
  label: string
  hint?: string
  onClick: () => void
}) {
  // The menu spec's two row shapes (remote-sessions-ux /
  // selector-menus-premium): full-bleed on the list's own inset — the inset
  // rounded fill this row shipped with is the card-in-a-card the spec retires
  // by name. `aria-disabled`, not `disabled`: a dimmed row here can still
  // route somewhere useful (the Chat row opens provider Settings).
  return (
    <MenuOption
      role="menuitemradio"
      selected={selected}
      stacked={Boolean(hint)}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      trailing={
        selected && !disabled ? (
          <CheckIcon className={`${hint ? 'mt-0.5 ' : ''}icon-xs shrink-0 text-[color:var(--accent-primary)]`} />
        ) : null
      }
    >
      {/* The hint WRAPS rather than truncating. These sentences are the whole
          explanation — "connect one in S…" and "works the…" told nobody
          anything, and a tooltip to recover a sentence the surface had room
          for is a worse answer than two lines. */}
      <span className={hint ? 'block text-body font-medium' : 'block'}>{label}</span>
      {hint ? <span className="block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span> : null}
    </MenuOption>
  )
}

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
