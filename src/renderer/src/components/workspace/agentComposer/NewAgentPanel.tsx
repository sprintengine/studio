import React from 'react'
import type {
  AgentCli,
  SprintEngineCliPermissionPreset,
  WorkspaceSkill,
} from '../../../../../shared/electron-api'
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
import { RemoteMachineGlyph } from '../../AppIcons'
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
  CliModelPopoverSurface,
  CloseIconButton,
  COMPOSER_SURFACE_CLASS,
  FOCUS_RING_CLASS,
  FOCUS_RING_WITHIN_TEXTAREA_CLASS,
  MENU_DIVIDER_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_STACKED_CLASS,
  MENU_LIST_CLASS,
  Input,
  InlineSkillPicker,
  Popover,
  PrimaryButton,
  StarGlyph,
  Tooltip,
  TruncatedText,
  type InlineSkillPickerHandle,
} from '../../ui'
import { CheckIcon } from '../../AppIcons'
import CliIcon from '../../CliIcon'
import { McpBrandIcon, mcpIconSlug } from '../../settings/McpCatalog'
import SprintEngineFrond from '../../brand/SprintEngineFrond'
import { CliInstallCta } from '../cliInstallRoute'
import {
  AGENT_SPAWN_PERMISSION_OPTIONS,
  focusActivePresetRow,
  menuRadioRowKeyDown,
  nearestRemotePermissionPreset,
  PermissionPresetMenuRows,
  REMOTE_PERMISSION_PRESETS,
  REMOTE_PRESET_DISABLED_REASONS,
} from './agentSpawnShared'
import { ProjectSourceMenu, type ProjectCloneRequest, type ProjectCloneResult } from './ProjectSourceMenu'
import { mergeDraftConnectors, readNewChatDraft, writeNewChatDraft, type NewChatDraftImage } from './newChatDraft'
import { resolveDefaultParentPath } from '../newWorkspace/folderCreation'
import { showToast } from '../../../store/toastStore'
import { SkillsAndMcpsPicker } from './SkillsAndMcpsPicker'
import {
  launchCommandLineKey,
  launchPreviewRequest,
  type LaunchCommandLineState,
} from './launchCommandLine'
import { drawSuggestions, newSuggestionSeed, type SuggestionEntry } from './suggestionBank'
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
  permissionPreset: SprintEngineCliPermissionPreset
  onChangePermissionPreset: (preset: SprintEngineCliPermissionPreset) => void
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
  permissionPreset: SprintEngineCliPermissionPreset
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
  return copies.find((workspace) => !/\/\.multicode-worktrees\//u.test(workspace.folderPath ?? '')) ?? copies[0] ?? null
}

export function machineAvailabilityOf(
  machine: FleetConnection,
  browse: FleetBrowse | 'loading' | undefined,
  identity: RepositoryIdentity | null
): MachineAvailability {
  if (!identity) return { state: 'none' }
  if (browse === undefined || browse === 'loading') return { state: 'loading' }
  if (!browse.reachable) {
    return { state: 'unreachable', reason: browse.unreachableReason ?? `${machine.machineName} is not answering.` }
  }
  if (browse.unauthorized) return { state: 'unreachable', reason: `${machine.machineName} refused this pairing — re-pair from Settings → Remote.` }
  const copy = machineCopyOf(browse, identity)
  if (copy) return { state: 'has', workspace: copy }
  const gap = browse.gaps.find((entry) => entry.part === 'workspaces')
  if (gap) return { state: 'lacks', reason: gap.message }
  return { state: 'lacks', reason: `No copy of ${identity.name} on ${machine.machineName}.` }
}

/** The checkout choice the scope line holds for a remote target. */
type RemoteCheckoutChoice = { mode: 'current' } | { mode: 'worktree'; baseRef: string | null }

type RemoteTargetState = {
  connection: FleetConnection
  workspaces: FleetWorkspace[] | null
  error: string | null
  picked: FleetWorkspace | null
  /** The scopes the machine reports NOW (the browse refreshes them), for the worktree gate. */
  scopes: TailnetScope[]
  /** The picked workspace's checkout facts; null until read, or unreadable (see `checkoutError`). */
  checkout: FleetWorkspaceCheckout | null
  checkoutError: string | null
  choice: RemoteCheckoutChoice
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
  if (!effectiveBaseRefOf(target.checkout, null)) return `No branch to fork from on ${target.connection.machineName}.`
  return null
}

/**
 * The one base ref a worktree launch shows AND sends: the person's pick,
 * else the checkout's own branch, else the trunk. Null when the remote has
 * nothing to fork from (a detached checkout with no trunk), which is a
 * disabled worktree row rather than a fork of an arbitrary commit.
 */
export function effectiveBaseRefOf(checkout: FleetWorkspaceCheckout | null, picked: string | null): string | null {
  if (!checkout?.git) return null
  return picked ?? checkout.branch ?? checkout.defaultBranch ?? null
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
 * The launch surface behind the tab strip's "+" (MC-2147, v2).
 *
 * One column: who is being greeted, what to do, how it runs, and what to start
 * with. The box sits on the terminal's own ground and carries a `❯`, because it
 * becomes that terminal in place.
 *
 * The control row shows only what a launch usually changes — engine and access —
 * plus the two attachments people reach for. Everything rarer (role, worktree,
 * reasoning, debug) lives behind `⋯` and rises onto the row as a chip once set,
 * so the row is a picture of this launch rather than a panel of every knob.
 *
 * Nothing here creates anything: `onLaunch` hands the host a confirm plus the
 * prompt, and the host retypes this tab into the agent's terminal.
 */
export default function NewAgentPanel({
  workspaceId,
  conversationAvailable,
  onRequestConversationCatalog,
  folderPath,
  projectOptions,
  onSelectProject,
  onBrowseProject,
  initialSelection,
  permissionPreset,
  onChangePermissionPreset,
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
    conversationAvailable,
    initialSelection: draft?.selection ?? initialSelection,
    initialMcpServers: draft ? mergeDraftConnectors(initialMcpServers, draft.mcpServers) : initialMcpServers,
    initialSkills: draft?.skills,
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
      [projectOptions, workspaceRoot]
    )
  )
  const localIdentity = workspaceRoot ? localIdentities.get(folderIdentityKey(workspaceRoot)) ?? null : null
  const activeIdentity: RepositoryIdentity | null = remoteTarget
    ? remoteTarget.picked?.repository ?? null
    : localIdentity
  activeIdentityRef.current = activeIdentity
  const pickRemoteMachine = (connection: FleetConnection | null, keep: RepositoryIdentity | null = activeIdentity): void => {
    lastPickedMachineId = connection?.id ?? null
    if (!connection) {
      // Back to This device with a project in hand: keep it when a local clone
      // of the same repository is open here (changing the machine keeps the
      // project when it exists there); otherwise the line returns
      // to the folder it was scoped to before, as it always did. The folder
      // the door is already scoped to wins when it is that repository.
      const scopedIsTwin = Boolean(keep && workspaceRoot && sameRepository(localIdentities.get(folderIdentityKey(workspaceRoot)), keep))
      const twin = keep && !scopedIsTwin
        ? (projectOptions ?? []).find((option) => sameRepository(localIdentities.get(folderIdentityKey(option.path)), keep))
        : null
      if (twin && onSelectProject && twin.path !== workspaceRoot) onSelectProject(twin.path)
      setRemoteTarget(null)
      return
    }
    setRemoteTarget({
      connection,
      workspaces: null,
      error: null,
      picked: null,
      scopes: connection.scopes,
      checkout: null,
      checkoutError: null,
      choice: { mode: 'current' },
    })
    void browseMachine(connection)
      .then((browse) => {
        setRemoteTarget((current) => {
          if (current?.connection.id !== connection.id) return current
          if (!browse.reachable) {
            return {
              ...current,
              workspaces: [],
              error: browse.unreachableReason ?? 'That machine is not answering.',
            }
          }
          if (browse.unauthorized) {
            return { ...current, workspaces: [], error: 'That machine refused this pairing — re-pair from Settings → Remote.' }
          }
          // A gap is a DIFFERENT statement from an empty list: a pairing
          // without workspace:read genuinely cannot list workspaces, and
          // "no workspaces on that machine" would be false (the FleetGap
          // contract). Say the real reason instead.
          const workspaceGap = browse.gaps.find((gap) => gap.part === 'workspaces')
          if (browse.workspaces.length === 0 && workspaceGap) {
            return { ...current, workspaces: [], error: workspaceGap.message }
          }
          // An explicit choice, not the first row: a project picked by list
          // order is a launch into the wrong repo waiting to happen. Two
          // exceptions: a machine with exactly one project, where there is
          // nothing to choose, and the machine's copy of the project already
          // in hand (one-project-across-machines) — switching the machine
          // keeps the project.
          const kept = machineCopyOf(browse, keep ?? activeIdentityRef.current)
          return {
            ...current,
            scopes: browse.scopes,
            workspaces: browse.workspaces,
            // A choice already made meanwhile is never overwritten by a late answer.
            picked: current.picked ?? kept ?? (browse.workspaces.length === 1 ? browse.workspaces[0]! : null),
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
    // Keyed on the MACHINE, not the target object: the browse resolving
    // replaces the object, and the move must happen once per pick.
    if (!remoteMachineName) return
    if (REMOTE_PERMISSION_PRESETS.has(permissionPreset)) return
    const next = nearestRemotePermissionPreset(permissionPreset)
    const from = AGENT_SPAWN_PERMISSION_OPTIONS.find((option) => option.value === permissionPreset)?.label ?? permissionPreset
    const to = AGENT_SPAWN_PERMISSION_OPTIONS.find((option) => option.value === next)?.label ?? next
    onChangePermissionPreset(next)
    setRemoteNote(`Switched permissions from ${from} to ${to}: ${from} is not available on ${remoteMachineName}.`)
  }, [onChangePermissionPreset, permissionPreset, remoteMachineName])
  React.useEffect(() => {
    if (!remoteTarget) setRemoteNote(null)
  }, [remoteTarget])
  // The picked project's checkout facts (checkout-and-branch-on-remote-create),
  // read over `workspace.checkout` the moment a project is chosen — keyed on
  // the machine and the project, so a re-pick re-reads and a browse settling
  // does not. A refusal (a read-only pairing, a machine gone quiet) is kept
  // as the reason the worktree option dims with, never as an empty branch list.
  const remoteConnectionId = remoteTarget?.connection.id ?? null
  const remotePickedId = remoteTarget?.picked?.id ?? null
  React.useEffect(() => {
    if (!remoteConnectionId || !remotePickedId) return
    let cancelled = false
    void window.api
      .fleetWorkspaceCheckout(remoteConnectionId, remotePickedId)
      .then((result) => {
        if (cancelled) return
        setRemoteTarget((current) => {
          if (current?.connection.id !== remoteConnectionId || current.picked?.id !== remotePickedId) return current
          if (!result.ok) return { ...current, checkout: null, checkoutError: result.message, choice: { mode: 'current' } }
          // A choice the facts no longer allow falls back here, so the line
          // never says "New worktree" over a launch that would not make one.
          const allowed = remoteWorktreeDisabledReason({ ...current, checkout: result.checkout, checkoutError: null }) === null
          return {
            ...current,
            checkout: result.checkout,
            checkoutError: null,
            choice: allowed ? current.choice : { mode: 'current' },
          }
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setRemoteTarget((current) =>
          current?.connection.id === remoteConnectionId && current.picked?.id === remotePickedId
            ? { ...current, checkout: null, checkoutError: error instanceof Error ? error.message : String(error), choice: { mode: 'current' } }
            : current
        )
      })
    return () => {
      cancelled = true
    }
  }, [remoteConnectionId, remotePickedId])
  // The ⋯ worktree row is the LOCAL checkout's; a remote target carries its
  // own checkout choice in the scope line, so the local one is cleared on
  // the pick rather than left as a chip the launch would then have to refuse.
  React.useEffect(() => {
    if (remoteMachineName) composer.setWorktreeName(null)
    // composer is a stable hook result; keyed on the machine alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteMachineName])
  const activeBranch = useWorkspaceStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    return ws ? resolveWorkspaceWorktree(ws)?.branch ?? null : null
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
  const [accessOpen, setAccessOpen] = React.useState(false)
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
      skills: composer.skills,
      mcpServers: composer.mcpServers,
    })
  }, [draftKey, prompt, images, selection, composer.skills, composer.mcpServers])

  const insertPromptPath = (path: string) => {
    setPrompt((current) =>
      current.length === 0 || /\s$/.test(current) ? `${current}${quotePath(path)} ` : `${current} ${quotePath(path)} `
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
      permissionPreset,
      runtime: launchCli ? cliRuntimes?.[launchCli] : undefined,
    }),
    [cliRuntimes, launchCli, model, permissionPreset, reasoning],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  const suggestions = React.useMemo(() => drawSuggestions(seed), [seed])
  const canLaunch = composer.visibleRows.some((row) => rowMatchesSelection(row, selection))

  const launch = (text: string) => {
    if (!canLaunch) return
    if (remoteTarget) {
      if (!remoteTarget.picked || !onLaunchRemote || remoteLaunching) return
      const confirm = composer.buildConfirm(selection)
      if (confirm.kind !== 'general' && confirm.kind !== 'specialist') return
      // What cannot travel must not be silently dropped while its chip is on
      // screen: skills install locally, MCP servers were synced into the LOCAL
      // workspace config, worktrees branch the LOCAL checkout, debug drives the
      // local state machine, and a specialist's soul brief is composed locally.
      // Images too: a local path means nothing on another machine, and there
      // is no upload path to the remote today (uploading them into the remote
      // environment is the future path; until it exists the refusal names them
      // rather than dropping them while their chips stay on screen).
      const stranded = [
        confirm.kind === 'specialist' ? 'the specialist role' : null,
        confirm.skills?.length ? 'the skills' : null,
        confirm.mcpServers?.length ? 'the MCP servers' : null,
        confirm.worktree ? 'the worktree' : null,
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
      if (!REMOTE_PERMISSION_PRESETS.has(permissionPreset)) return
      // A worktree the gate has since closed on (a scope read that came back
      // narrower, a project that turned out not to be a repo) never travels:
      // the pick falls back to the checkout it can have.
      const worktreeBlocked = remoteWorktreeDisabledReason(remoteTarget) !== null
      const baseRef =
        remoteTarget.choice.mode === 'worktree' ? effectiveBaseRefOf(remoteTarget.checkout, remoteTarget.choice.baseRef) : null
      const checkout: FleetCheckoutRequest =
        remoteTarget.choice.mode === 'worktree' && !worktreeBlocked && baseRef
          ? { mode: 'worktree', baseRef }
          : { mode: 'current' }
      setRemoteLaunching(true)
      onLaunchRemote({
        connectionId: remoteTarget.connection.id,
        machineName: remoteTarget.connection.machineName,
        remoteWorkspaceId: remoteTarget.picked.id,
        remoteWorkspaceName: remoteTarget.picked.name,
        remoteWorkspaceRoot: remoteTarget.picked.folderPath,
        prompt: text.trim(),
        cli: confirm.cli,
        cliModel: confirm.model ?? null,
        permissionPreset,
        checkout,
        branch: checkout.mode === 'current' ? remoteTarget.checkout?.branch ?? null : null,
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
    onRequestConversationCatalog?.()
  }, [onRequestConversationCatalog])

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
  const accessLabel =
    AGENT_SPAWN_PERMISSION_OPTIONS.find((option) => option.value === permissionPreset)?.label ?? 'Permissions'
  const accessShort = accessLabel.split(' ')[0]

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
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col overflow-auto bg-[color:var(--bg-app)] px-6 pb-8 pt-8">
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
                availability={(machine) => machineAvailabilityOf(machine, browseOf(machineBrowses.get(machine.id)), activeIdentity)}
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
              <RemoteProjectPicker target={remoteTarget} onPick={(workspace) => {
                setRemoteTarget((current) =>
                  current ? { ...current, picked: workspace, checkout: null, checkoutError: null, choice: { mode: 'current' } } : current
                )
              }} />
            ) : canChooseProject ? (
              <ProjectScopePicker
                label={projectLabel ?? 'Choose a project'}
                branch={branch}
                options={projectOptions ?? []}
                selectedPath={workspaceRoot}
                onSelect={(path) => onSelectProject?.(path)}
                onBrowse={onBrowseProject}
                onClone={onCloneProject}
              />
            ) : projectLabel ? (
              <p className="text-meta text-[color:var(--text-subtle)]">
                {projectLabel}
                {branch ? ` · ${branch}` : ''}
              </p>
            ) : null}
            {/* machine · project · checkout · branch (checkout-and-branch-on-
                remote-create): the two segments the mockup's run-on strip
                carried, on the scope line the landed shape already uses. They
                exist only once a remote project is picked — the local line
                stays exactly as it was, worktree behind ⋯ and all. */}
            {remoteTarget?.picked ? (
              <>
                <RemoteCheckoutPicker
                  target={remoteTarget}
                  onChoose={(choice) => setRemoteTarget((current) => (current ? { ...current, choice } : current))}
                />
                <RemoteBranchSegment
                  target={remoteTarget}
                  onChooseBase={(baseRef) =>
                    setRemoteTarget((current) =>
                      current && current.choice.mode === 'worktree' ? { ...current, choice: { mode: 'worktree', baseRef } } : current
                    )
                  }
                />
              </>
            ) : null}
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
              className="bottom-full left-0"
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
              <path d="M5.5 3.5 10 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {/* Grows with its content (field-sizing: content) from the two-row
                floor to a ceiling, then scrolls — a box that showed two lines
                of a six-line prompt was hiding what the person was about to
                send. Same treatment as the automation editor's prompt field. */}
            <textarea
              ref={promptRef}
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
              className="field-sizing-content max-h-[280px] min-h-[44px] w-full flex-1 resize-none overflow-y-auto bg-transparent font-mono text-body leading-6 text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)]"
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
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    className={`interactive inline-flex items-center gap-1.5 rounded bg-[color:var(--accent-primary-soft)] px-2 py-0.5 text-meta text-[color:var(--text-strong)] ${FOCUS_RING_CLASS}`}
                    {...triggerProps}
                  >
                    <CliIcon cli={launchCli} className="icon-xs" />
                    <TruncatedText
                      as="span"
                      text={engineNames.modelLabel ?? engineNames.cliLabel}
                      className="max-w-[150px]"
                    />
                    {reasoning ? (
                      <span className="text-[color:var(--text-subtle)]">· {reasoning}</span>
                    ) : null}
                    <ChevronGlyph />
                  </button>
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
                />
              </Popover>
            ) : null}

            {/* Access: one control carrying its value, shield-marked. Bypass is
                the only value that removes a safeguard, so it is the only one
                that changes colour. */}
            {selection.kind === 'terminal' ? null : (
              <Popover
                open={accessOpen}
                onOpenChange={setAccessOpen}
                ariaLabel={`Permissions: ${accessLabel}`}
                popupRole="menu"
                placement="bottom-start"
                // One menu role: the surface IS the list (nesting a second
                // `role="menu"` inside it announced two menus).
                surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
                onOpenAutoFocus={focusActivePresetRow}
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button
                    ref={ref}
                    type="button"
                    onClick={togglePopover}
                    className={`interactive inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-meta ${
                      permissionPreset === 'bypass'
                        ? 'bg-[color:var(--tone-warn-soft)] text-[color:var(--tone-warn-on-tint)]'
                        : 'bg-[color:var(--accent-primary-soft)] text-[color:var(--text-strong)]'
                    } ${FOCUS_RING_CLASS}`}
                    {...triggerProps}
                  >
                    <ShieldGlyph />
                    {accessShort}
                    <ChevronGlyph />
                  </button>
                )}
              >
                {/* The same stacked rows the chat composer's pill opens
                    (agentSpawnShared) — one choice, one rendering. */}
                <PermissionPresetMenuRows
                  value={permissionPreset}
                  disabledReasons={remotePresetReasons}
                  onSelect={(preset) => {
                    onChangePermissionPreset(preset)
                    setRemoteNote(null)
                    setAccessOpen(false)
                  }}
                />
              </Popover>
            )}

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
                    glyph={<McpBrandIcon slug={mcpIconSlug(server.id)} name={server.name} icon={server.icon} size={13} />}
                    label={server.name}
                    removeLabel={`Remove MCP server ${server.name}`}
                    onRemove={() => composer.setMcpServers(composer.mcpServers.filter((entry) => entry.id !== server.id))}
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
                  triggerClassName={GHOST_CHIP_CLASS}
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
                <input
                  value={composer.worktreeName}
                  size={Math.max(composer.worktreeName.length || 12, 3)}
                  onChange={(event) => composer.setWorktreeName(event.currentTarget.value)}
                  placeholder="branch name"
                  aria-label="Worktree name — leave empty to derive from the agent’s name"
                  className="max-w-[160px] bg-transparent text-meta outline-none placeholder:text-[color:var(--text-disabled)]"
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
            {(
              <Popover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                ariaLabel="More launch options"
                popupRole="menu"
                placement="bottom-start"
                surfaceClassName={`w-[264px] ${MENU_LIST_CLASS}`}
                renderTrigger={({ ref, triggerProps, togglePopover }) => (
                  <button
                    ref={ref}
                    type="button"
                    aria-label="More launch options"
                    onClick={togglePopover}
                    className={`${GHOST_CHIP_CLASS} px-2`}
                    {...triggerProps}
                  >
                    ⋯
                  </button>
                )}
              >
                <MoreMenu
                  selection={selection}
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
                  onToggleWorktree={() =>
                    composer.setWorktreeName(composer.worktreeName === null ? '' : null)
                  }
                  onChangeWorktree={composer.setWorktreeName}
                  // A remote target chooses its checkout on the scope line.
                  worktreeAvailable={workspaceIsGitRepo && !remoteTarget}
                  debugMode={debugMode}
                  onToggleDebug={() => onChangeDebugMode(!debugMode)}
                />
              </Popover>
            )}

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
              <SuggestionCard key={entry.id} entry={entry} disabled={!canLaunch} onLaunch={() => launch(entry.prompt)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Pieces ─────────────────────────────────────────────────────────────────

const GHOST_CHIP_CLASS =
  'interactive inline-flex items-center gap-1 rounded border border-dashed border-[color:var(--border-strong)] px-2 py-0.5 text-meta text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] focus-visible:focus-ring'

function ChevronGlyph() {
  return (
    <svg className="icon-xs text-[color:var(--text-subtle)]" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="m4 6.5 4 3.5 4-3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ShieldGlyph() {
  return (
    <svg className="icon-xs" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.8 2.8 4v4c0 2.7 2.2 4.7 5.2 5.4 3-0.7 5.2-2.7 5.2-5.4V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
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
      <path d="M2.5 7.5h2.5M11 7.5h2.5M2.5 11h2.5M11 11h2.5M8 2.5V5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
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
      surface.querySelector<HTMLButtonElement>('[data-machine-option="true"][aria-checked="true"]:not([disabled])')
      ?? surface.querySelector<HTMLButtonElement>('[data-machine-option="true"]:not([disabled])')
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
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          data-machine-trigger="true"
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {selected ? <RemoteMachineGlyph className="icon-xs shrink-0" /> : null}
          {selected ? selected.machineName : 'This device'}
          <ChevronGlyph />
        </button>
      )}
    >
      {/* The surface is the menu; these are its rows. The leading slot is
          all-or-nothing per the menu spec, so This device renders an empty slot
          the width of the machine glyph rather than sliding its label left. */}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={selected === null}
        data-machine-option="true"
        tabIndex={selected === null ? 0 : -1}
        onKeyDown={(event) => rowKey(event, () => { onSelect(null); setOpen(false) })}
        onClick={() => {
          onSelect(null)
          setOpen(false)
        }}
        className={`${MENU_ITEM_CLASS} ${selected === null ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}
      >
        <span aria-hidden="true" className="icon-xs shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">This device</span>
      </button>
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
          <button
            key={machine.id}
            type="button"
            role="menuitemradio"
            aria-checked={selected?.id === machine.id}
            disabled={!pickable}
            data-machine-option="true"
            data-machine-availability={state.state}
            tabIndex={selected?.id === machine.id ? 0 : -1}
            onKeyDown={(event) => rowKey(event, activate)}
            onClick={activate}
            className={`${hint ? MENU_ITEM_STACKED_CLASS : MENU_ITEM_CLASS} ${
              !pickable
                ? 'text-[color:var(--text-disabled)]'
                : selected?.id === machine.id
                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)]'
            }`}
          >
            <RemoteMachineGlyph className={`icon-xs shrink-0${hint ? ' mt-0.5' : ''}`} />
            <span className="min-w-0 flex-1 text-left">
              <span className={hint ? 'block truncate text-body font-medium' : 'block truncate'}>{machine.machineName}</span>
              {hint ? (
                <span className="mt-0.5 block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span>
              ) : null}
            </span>
            {hint ? null : (
              <span className="shrink-0 font-mono text-micro text-[color:var(--text-disabled)]">{machine.endpoint}</span>
            )}
          </button>
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
  onPick,
}: {
  target: RemoteTargetState
  onPick: (workspace: FleetWorkspace) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const needle = query.trim().toLowerCase()
  const visibleWorkspaces =
    target.workspaces === null
      ? null
      : needle
        ? target.workspaces.filter(
            (workspace) =>
              workspace.name.toLowerCase().includes(needle)
              || (workspace.folderPath ?? '').toLowerCase().includes(needle)
          )
        : target.workspaces
  const label = target.error
    ? 'Unavailable'
    : target.workspaces === null
      ? 'Loading…'
      : target.picked?.name ?? 'Choose a project'
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Project on ${target.connection.machineName}`}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {label}
          <ChevronGlyph />
        </button>
      )}
    >
      <>
        {target.workspaces !== null && target.workspaces.length > 0 && !target.error ? (
          // The same search-first shape the local selector opens on.
          <div className="px-1.5 pb-1">
            <Input
              type="text"
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${target.connection.machineName}…`}
              aria-label={`Search projects on ${target.connection.machineName}`}
            />
          </div>
        ) : null}
        {target.error ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--tone-error)]">{target.error}</div>
        ) : visibleWorkspaces === null ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">Loading projects…</div>
        ) : visibleWorkspaces.length === 0 ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
            {needle ? 'No matching projects.' : 'No workspaces on that machine.'}
          </div>
        ) : (
          visibleWorkspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              role="menuitemradio"
              aria-checked={target.picked?.id === workspace.id}
              onClick={() => {
                onPick(workspace)
                setOpen(false)
              }}
              className={`${MENU_ITEM_STACKED_CLASS} ${
                target.picked?.id === workspace.id
                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)]'
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{workspace.name}</span>
                {workspace.folderPath ? (
                  <span className="mt-0.5 block truncate font-mono text-micro text-[color:var(--text-subtle)]">
                    {workspace.folderPath}
                  </span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </>
    </Popover>
  )
}

/** The remote target's checkout choice: the workspace's own checkout, or a fresh worktree. */
function RemoteCheckoutPicker({
  target,
  onChoose,
}: {
  target: RemoteTargetState
  onChoose: (choice: RemoteCheckoutChoice) => void
}) {
  const [open, setOpen] = React.useState(false)
  const worktreeReason = remoteWorktreeDisabledReason(target)
  const isWorktree = target.choice.mode === 'worktree'
  const label = isWorktree ? 'New worktree' : 'Current checkout'
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-checkout-option="true"]', activate)
  const focusChecked = React.useCallback((surface: HTMLElement) => {
    const target =
      surface.querySelector<HTMLButtonElement>('[data-checkout-option="true"][aria-checked="true"]:not([disabled])')
      ?? surface.querySelector<HTMLButtonElement>('[data-checkout-option="true"]:not([disabled])')
    target?.focus()
  }, [])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel={`Checkout on ${target.connection.machineName}`}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      onOpenAutoFocus={focusChecked}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          data-checkout-trigger="true"
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {label}
          <ChevronGlyph />
        </button>
      )}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!isWorktree}
        data-checkout-option="true"
        tabIndex={!isWorktree ? 0 : -1}
        onKeyDown={(event) => rowKey(event, () => { onChoose({ mode: 'current' }); setOpen(false) })}
        onClick={() => {
          onChoose({ mode: 'current' })
          setOpen(false)
        }}
        className={`${MENU_ITEM_STACKED_CLASS} ${!isWorktree ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]' : 'text-[color:var(--text-default)]'}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">Current checkout</span>
          <span className="mt-0.5 block text-meta leading-snug text-[color:var(--text-subtle)]">
            {target.checkout?.branch
              ? `The project as it is on ${target.connection.machineName}, on ${target.checkout.branch}`
              : `The project as it is on ${target.connection.machineName}`}
          </span>
        </span>
      </button>
      {/* `disabled`, per the menu spec: the row stays listed and dimmed with
          its reason, and the arrow walk skips it (the preset menu's idiom). */}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={isWorktree}
        disabled={worktreeReason !== null}
        data-checkout-option="true"
        tabIndex={isWorktree ? 0 : -1}
        onKeyDown={(event) =>
          rowKey(event, () => {
            onChoose({ mode: 'worktree', baseRef: null })
            setOpen(false)
          })
        }
        onClick={() => {
          onChoose({ mode: 'worktree', baseRef: null })
          setOpen(false)
        }}
        className={`${MENU_ITEM_STACKED_CLASS} ${
          worktreeReason
            ? 'text-[color:var(--text-disabled)]'
            : isWorktree
              ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
              : 'text-[color:var(--text-default)]'
        }`}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-body font-medium">New worktree</span>
          <span className="mt-0.5 block text-meta leading-snug text-[color:var(--text-subtle)]">
            {worktreeReason ?? 'A fresh checkout there, branched from the branch you pick'}
          </span>
        </span>
      </button>
    </Popover>
  )
}

/**
 * The branch segment. On the current checkout it is a FACT — the branch the
 * remote's checkout is on, which this machine never moves — and reads as
 * plain text. On a new worktree it is the base ref, picked from the remote's
 * own branch list, and reads "From main".
 */
function RemoteBranchSegment({
  target,
  onChooseBase,
}: {
  target: RemoteTargetState
  onChooseBase: (baseRef: string) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const checkout = target.checkout
  if (target.choice.mode === 'current') {
    if (!checkout) {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-meta text-[color:var(--text-muted)]" data-branch-fact="true">
          {target.checkoutError ? 'Branch unknown' : 'Reading branch…'}
        </span>
      )
    }
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-micro text-[color:var(--text-subtle)]" data-branch-fact="true">
        <BranchGlyph />
        {checkout.git ? checkout.branch ?? 'detached' : 'not a repository'}
      </span>
    )
  }
  const baseRef = effectiveBaseRefOf(checkout, target.choice.baseRef)
  const needle = query.trim().toLowerCase()
  const branches = (checkout?.branches ?? []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
  const rowKey = (event: React.KeyboardEvent<HTMLButtonElement>, activate: () => void) =>
    menuRadioRowKeyDown(event, '[data-branch-option="true"]', activate)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      ariaLabel={`Branch to fork on ${target.connection.machineName}`}
      popupRole="menu"
      placement="bottom-start"
      surfaceClassName={`w-[280px] ${MENU_LIST_CLASS}`}
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          data-branch-trigger="true"
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-micro text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          <BranchGlyph />
          {baseRef ? `From ${baseRef}` : 'Select branch'}
          <ChevronGlyph />
        </button>
      )}
    >
      <>
        {(checkout?.branches.length ?? 0) > 0 ? (
          <div className="px-1.5 pb-1">
            <Input
              type="text"
              size="sm"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search branches…"
              aria-label={`Search branches on ${target.connection.machineName}`}
              // The list is walked from the box: ArrowDown steps onto the
              // first branch, and the rows rove from there.
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown') return
                const first = (event.currentTarget.closest('[role="menu"]') ?? event.currentTarget.parentElement?.parentElement)
                  ?.querySelector<HTMLButtonElement>('[data-branch-option="true"]')
                if (first) {
                  event.preventDefault()
                  first.focus()
                }
              }}
            />
          </div>
        ) : null}
        {branches.length === 0 ? (
          <div className="px-2.5 py-1.5 text-meta text-[color:var(--text-muted)]">
            {needle ? 'No matching branches.' : 'No branches to fork from.'}
          </div>
        ) : (
          branches.map((entry) => (
            <button
              key={entry.name}
              type="button"
              role="menuitemradio"
              aria-checked={entry.name === baseRef}
              data-branch-option="true"
              tabIndex={entry.name === baseRef ? 0 : -1}
              onKeyDown={(event) =>
                rowKey(event, () => {
                  onChooseBase(entry.name)
                  setOpen(false)
                })
              }
              onClick={() => {
                onChooseBase(entry.name)
                setOpen(false)
              }}
              className={`${MENU_ITEM_CLASS} ${
                entry.name === baseRef
                  ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
                  : 'text-[color:var(--text-default)]'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left font-mono">{entry.name}</span>
              {entry.current ? (
                <span className="shrink-0 text-micro text-[color:var(--text-disabled)]">checked out</span>
              ) : entry.name === checkout?.defaultBranch ? (
                <span className="shrink-0 text-micro text-[color:var(--text-disabled)]">trunk</span>
              ) : null}
            </button>
          ))
        )}
      </>
    </Popover>
  )
}

/** The scope line as a control: the projects open here, plus Browse. */
function ProjectScopePicker({
  label,
  branch,
  options,
  selectedPath,
  onSelect,
  onBrowse,
  onClone,
}: {
  label: string
  branch: string | null
  options: NewAgentProjectOption[]
  selectedPath: string | null
  onSelect: (path: string) => void
  onBrowse?: () => void
  onClone?: (request: ProjectCloneRequest) => Promise<ProjectCloneResult>
}) {
  // Projects this app knows beyond the ones open in this window: the recent
  // folders the workspace hub lists. Searching the selector covers them too,
  // so a repo opened last week is one keystroke away rather than a Browse.
  const storedRecentFolders = useWorkspaceStore((s) => s.appSettings.recentWorkspaceFolders ?? [])
  const recentOptions = React.useMemo<NewAgentProjectOption[]>(() => {
    const open = new Set(options.map((option) => folderPathKey(option.path)))
    const seen = new Set<string>()
    const recents: NewAgentProjectOption[] = []
    for (const path of storedRecentFolders) {
      const trimmed = path?.trim()
      if (!trimmed) continue
      const key = folderPathKey(trimmed)
      if (open.has(key) || seen.has(key)) continue
      seen.add(key)
      recents.push({ path: trimmed, label: basename(trimmed) || trimmed })
    }
    return recents
  }, [options, storedRecentFolders])
  // Cold start: nothing open and nothing recent still needs somewhere for a
  // clone to land, so the app's default parent (the hub's own fallback) is
  // asked for once rather than telling the person to open a project first.
  const [fallbackParent, setFallbackParent] = React.useState<string | null>(null)
  React.useEffect(() => {
    let active = true
    void window.api.defaultWorkspaceParentDir?.()
      .then((dir) => {
        if (active) setFallbackParent(dir)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])
  // Where an imported repository lands: beside the current project, else
  // beside the first offered one, else beside a recent one, else the app's
  // default — the same smart-parent resolver the workspace hub uses.
  const defaultParent = resolveDefaultParentPath({
    folderPath: selectedPath,
    recentFolders: [...options.map((option) => option.path), ...storedRecentFolders],
    fallbackParent,
  })
  // A host that runs the clone itself outlives this popover; without one the
  // panel clones in place (the tab-strip host offers no picker, so in practice
  // this is the door with an older host).
  const runClone = React.useCallback(
    async (request: ProjectCloneRequest): Promise<ProjectCloneResult> => {
      if (onClone) return onClone(request)
      const cloned = await window.api
        .cloneGitHubRepo(request)
        .catch((caught: unknown): { ok: false; message: string } => ({
          ok: false,
          message: caught instanceof Error ? caught.message : 'Could not clone the repository.',
        }))
      if (!cloned.ok) return cloned
      showToast({ tone: 'good', title: `Cloned ${basename(cloned.path) || cloned.path}`, description: cloned.path })
      onSelect(cloned.path)
      return { ok: true, path: cloned.path }
    },
    [onClone, onSelect],
  )
  const [open, setOpen] = React.useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Project this agent runs in"
      popupRole="menu"
      placement="bottom-start"
      renderTrigger={({ ref, triggerProps, togglePopover }) => (
        <button
          ref={ref}
          type="button"
          onClick={togglePopover}
          // A stable hook for the Playwright passes (scripts/testing/
          // newChatWorkspace.mjs), which reach the folder through this control.
          data-project-trigger="true"
          // Exactly the machine trigger's box: the scope line is one row of
          // sibling chips, so a `mt-1` left over from when this was the only
          // control on its own line pushed it half a step below the machine
          // dropdown, and a bare `rounded` was an untokenized radius next to
          // its siblings' control radius.
          className={`interactive inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-meta text-[color:var(--text-subtle)] hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-default)] ${FOCUS_RING_CLASS}`}
          {...triggerProps}
        >
          {label}
          {branch ? ` · ${branch}` : ''}
          <ChevronGlyph />
        </button>
      )}
    >
      {/* Search + sources (remote-sessions-ux / project-selector-sources):
          the selector filters the projects, browses the disk, and steps in
          place into the shipped MC-2207 Git import — one surface, no second
          dialog stacked on the first. */}
      <ProjectSourceMenu
        options={options}
        recentOptions={recentOptions}
        selectedPath={selectedPath}
        defaultParent={defaultParent}
        onSelect={(path) => onSelect(path)}
        onBrowse={onBrowse}
        onClone={runClone}
        onClose={() => setOpen(false)}
      />
    </Popover>
  )
}

/**
 * The ⋯ surface: what a launch rarely changes. Two rows now — the role picker
 * left with the specialists (a role is a way of working, which is what a skill
 * is), and reasoning effort went into the model's own picker, where it is a
 * property of the model rather than a second control the row must carry.
 */
function MoreMenu({
  selection,
  conversationAvailable,
  onSelectKind,
  onOpenProviderSettings,
  worktreeName,
  onToggleWorktree,
  onChangeWorktree,
  worktreeAvailable,
  debugMode,
  onToggleDebug,
}: {
  selection: AgentComposerSelection
  conversationAvailable: boolean
  onSelectKind: (next: AgentComposerSelection) => void
  onOpenProviderSettings: () => void
  worktreeName: string | null
  onToggleWorktree: () => void
  onChangeWorktree: (next: string | null) => void
  worktreeAvailable: boolean
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
      {/* Always listed, never silently absent. Hiding it when no provider is
          configured left the option looking unimplemented rather than
          unconfigured — the same reason the roster shows an install route
          instead of dropping the CLI rows. */}
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
      <div className={MENU_DIVIDER_CLASS} role="separator" />

      {/* A conversation has no repo checkout of its own, so no worktree. */}
      {worktreeAvailable && selection.kind !== 'conversation' ? (
        <>
          <MenuValueRow
            label="Worktree"
            value={worktreeName === null ? 'Off' : worktreeName || 'Named on start'}
            expanded={worktreeName !== null}
            onClick={() => {
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
              worktreeName === null ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100'
            }`}
          >
            <div className="overflow-hidden">
              <input
                ref={worktreeRef}
                value={worktreeName ?? ''}
                onChange={(event) => onChangeWorktree(event.currentTarget.value)}
                placeholder="Branch name — blank uses the agent’s"
                aria-label="Worktree branch name"
                aria-hidden={worktreeName === null}
                tabIndex={worktreeName === null ? -1 : 0}
                className={`mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-2 py-1 text-meta text-[color:var(--text-strong)] outline-none placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`}
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
  onClick,
}: {
  label: string
  value: string
  expanded?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded || undefined}
      // Full-bleed like its sibling rows (menu spec): the inset rounded fill
      // is the card-in-a-card the spec retires.
      className={`${MENU_ITEM_CLASS} text-[color:var(--text-default)]`}
    >
      <span className="min-w-0 flex-1">{label}</span>
      <span className="max-w-[110px] shrink-0 truncate text-[color:var(--text-subtle)]">{value}</span>
      <span aria-hidden="true" className="shrink-0 text-micro text-[color:var(--text-disabled)]">›</span>
    </button>
  )
}

// An image staged on the prompt: the chat composer's attachment shape (so the
// shared strip renders it) plus the file path that stands in for it once the
// prompt becomes text.
type PromptImage = NewChatDraftImage

// One key per folder whatever the separator or trailing slash, so an open
// project and its recent-folders twin count once.
function folderPathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '').toLowerCase()
}

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
  const shape = hint ? MENU_ITEM_STACKED_CLASS : MENU_ITEM_CLASS
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      aria-disabled={disabled || undefined}
      onClick={onClick}
      className={`${shape} ${
        disabled
          ? 'text-[color:var(--text-disabled)]'
          : selected
            ? 'bg-[color:var(--bg-selected)] text-[color:var(--text-strong)]'
            : 'text-[color:var(--text-default)]'
      }`}
    >
      {/* The hint WRAPS rather than truncating. These sentences are the whole
          explanation — "connect one in S…" and "works the…" told nobody
          anything, and a tooltip to recover a sentence the surface had room
          for is a worse answer than two lines. */}
      <span className="min-w-0 flex-1">
        <span className={hint ? 'block text-body font-medium' : 'block'}>{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-meta leading-snug text-[color:var(--text-subtle)]">{hint}</span>
        ) : null}
      </span>
      {selected && !disabled ? (
        <CheckIcon className={`${hint ? 'mt-0.5 ' : ''}icon-xs shrink-0 text-[color:var(--accent-primary)]`} />
      ) : null}
    </button>
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
    <button
      type="button"
      onClick={onLaunch}
      disabled={disabled}
      className={`interactive rounded-md border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface-raised)] px-3 py-2.5 text-left transition-colors hover:border-[color:var(--border-strong)] hover:bg-[color:var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING_CLASS}`}
    >
      <div className="text-body font-medium text-[color:var(--text-strong)]">{entry.title}</div>
      <p className="mt-1 text-meta leading-5 text-[color:var(--text-muted)]">{entry.description}</p>
      <span className="mt-1.5 inline-block rounded border border-[color:var(--border-default)] px-1.5 text-micro text-[color:var(--text-subtle)]">
        {entry.outcome}
      </span>
    </button>
  )
}
