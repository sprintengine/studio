import type { TailnetScope } from './tailnet'

// The Fleet: another machine's Studio, mounted in this one (MC-2167).
//
// `tailnet.ts` is "who may drive this machine"; `tailnet-peers.ts` is "which
// machines exist". This file is the third direction and the one a person
// actually works in: the machines this Studio has PAIRED WITH, what they hold,
// and the terminals it has open on them.
//
// The outbound half lives in the main process (`tailnet/tailnet-fleet-service.ts`),
// not the renderer, for one hard reason: the listener refuses any request
// carrying an `Origin` header, and a renderer's fetch/WebSocket always sends
// one. Main is also where the device token belongs — a credential that reached
// the renderer would be one XSS away from the tailnet.

/**
 * One machine this Studio is paired with.
 *
 * The device token is deliberately NOT here: it lives in the main-process store
 * and never crosses the IPC boundary, so nothing a window can read is a
 * credential.
 */
export type FleetConnection = {
  /** Local id for this pairing record. Ours, not the remote machine's. */
  id: string
  /** What to call the machine in the UI — its tailnet host name where we could resolve one. */
  machineName: string
  /** `address:port` of that machine's listener. */
  endpoint: string
  /** The device id the remote machine issued us, so a person can match it to a row in ITS settings. */
  deviceId: string
  /** The name we paired under (this machine's name), for the same reason. */
  deviceName: string
  /** What that machine granted us. Refreshed from the remote on every browse. */
  scopes: TailnetScope[]
  pairedAt: string
  lastConnectedAt: string | null
  /**
   * How this pairing came about (pair-from-the-scan-and-stay-paired): a
   * carried link, a request someone approved over there, or the reverse half
   * of a both-ways pairing that machine asked for. `unknown` for records
   * written before this was kept.
   */
  pairedVia: 'link' | 'request' | 'reverse' | 'unknown'
}

/** What this Studio may do with a paired machine's terminals. */
export type FleetTerminalAccess = 'none' | 'observe' | 'control'

/** A workspace on the remote machine, as `workspace.list` reports it. */
export type FleetWorkspace = {
  id: string
  name: string
  mode: string | null
  folderPath: string | null
}

/**
 * A workspace's checkout facts on the remote machine, as `workspace.checkout`
 * reports them (checkout-and-branch-on-remote-create). `git: false` is a real
 * answer — the folder is not a repository, so there is no branch to show and
 * no worktree to make — and is distinct from a gap, which is "this pairing
 * may not ask".
 */
export type FleetWorkspaceCheckout = {
  workspaceId: string
  git: boolean
  /** The branch the workspace's own checkout is on; null when detached or not a repo. */
  branch: string | null
  /** The trunk the remote resolves (origin/HEAD, upstream, main/master), or null. */
  defaultBranch: string | null
  branches: Array<{ name: string; current: boolean }>
  worktrees: Array<{ path: string; branch: string | null; isMain: boolean }>
}

export type FleetWorkspaceCheckoutResult =
  | { ok: true; checkout: FleetWorkspaceCheckout }
  | { ok: false; code: string; message: string }

/**
 * Where a remote chat runs, chosen at the launch: the current checkout or a
 * new worktree. `current` opens the agent in the
 * workspace's own checkout, on whatever branch it is on — this machine never
 * moves another machine's checkout. `worktree` asks the remote to branch a
 * fresh worktree off `baseRef` (its current branch when absent) and start
 * the agent there; it is served by `agent.launch`, the audited
 * `workspace:operate` mutation that already owns worktree creation.
 */
export type FleetCheckoutRequest =
  | { mode: 'current' }
  | { mode: 'worktree'; name?: string; baseRef?: string }

/** What a create actually landed on, reported back so the row can say so. */
export type FleetCreatedCheckout = {
  mode: 'current' | 'worktree'
  branch: string | null
  /** The worktree's absolute path on the remote; null on the current checkout. */
  worktreePath: string | null
}

/** A Sprint Engine run on the remote machine, as `sprint.list` reports it. */
export type FleetRun = {
  slug: string
  /** Project-relative path of the run state, exactly as the remote disclosed it. */
  statePath: string
}

/** A terminal session on the remote machine, as `terminal.list` reports it. */
export type FleetTerminal = {
  sessionId: string
  kind: 'agent' | 'terminal'
  workspaceId: string | null
  agentName: string | null
  cli: string | null
  cwd: string | null
  /** The pty is running. False with `suspended` false means it exited. */
  processAlive: boolean
  /** Paused to reclaim memory: the screen is real, the process is not. */
  suspended: boolean
  /** Hook-reported agent phase where the CLI reports one. */
  phase: string | null
}

/**
 * A part of a browse this machine is not allowed to read, named with the reason.
 *
 * A device paired for terminals alone genuinely cannot list workspaces. Showing
 * an empty list would say "this machine has no workspaces", which is a
 * different — and false — statement.
 */
export type FleetGap = {
  part: 'workspaces' | 'terminals' | 'runs'
  code: string
  message: string
}

/** One machine's contents, as the Fleet surface shows them. */
export type FleetBrowse = {
  connectionId: string
  /** False when the machine did not answer at all; everything below is then empty. */
  reachable: boolean
  /** Why it did not answer, in a sentence. Null when it did. */
  unreachableReason: string | null
  /** True when the remote refused our token — revoked or re-paired at the other end. */
  unauthorized: boolean
  /** Live scopes read from the remote, which may differ from what was stored at pairing. */
  scopes: TailnetScope[]
  terminalAccess: FleetTerminalAccess
  workspaces: FleetWorkspace[]
  terminals: FleetTerminal[]
  gaps: FleetGap[]
}

/** The state of one attached remote terminal's link, as the pane badges it. */
export type FleetLinkState =
  /** Opening the socket for the first time. */
  | 'connecting'
  /** Attached; output is flowing. */
  | 'live'
  /** The socket dropped and we are dialling again. Scrollback stays on screen. */
  | 'reconnecting'
  /** The peer is not answering. Quiet, not alarming — a sleeping laptop looks like this. */
  | 'offline'
  /** Finished for good: the session ended, access was revoked, or the pane detached. */
  | 'closed'

/**
 * What main sends a remote terminal pane.
 *
 * `replay` / `output` / `exit` / `ended` / `error` are the listener's own attach
 * frames, forwarded verbatim. `status` is main's addition: the CLIENT-side link
 * lifecycle, which the server cannot narrate because the times it matters are
 * exactly the times it is unreachable.
 */
export type FleetTerminalEvent =
  | { type: 'status'; state: FleetLinkState; detail: string }
  | { type: 'attached'; sessionId: string; access: FleetTerminalAccess; title: string }
  | { type: 'replay'; data: string; reason: 'attach' | 'resync' }
  | { type: 'output'; data: string }
  | { type: 'exit'; exitCode: number }
  | { type: 'ended'; reason: string }
  | { type: 'error'; code: string; message: string }

export type FleetPairResult =
  | { ok: true; connection: FleetConnection }
  | { ok: false; code: string; message: string }

export type FleetAttachResult = { ok: true } | { ok: false; code: string; message: string }

export type FleetCreateTerminalResult =
  | { ok: true; sessionId: string; workspaceId: string; agentId: string; title: string; checkout: FleetCreatedCheckout }
  | { ok: false; code: string; message: string }

/** Terminal access a set of granted scopes carries, in the Fleet's vocabulary. */
export function fleetTerminalAccess(scopes: readonly TailnetScope[]): FleetTerminalAccess {
  if (scopes.includes('terminal:control')) return 'control'
  if (scopes.includes('terminal:observe')) return 'observe'
  return 'none'
}

/** The channel one attachment's events arrive on. The renderer picks the id and subscribes first. */
export function fleetTerminalEventChannel(attachId: string): string {
  return `fleet:terminal:${attachId}`
}

/**
 * A pairing we have ASKED for and are waiting on (MC-2233), as a window sees
 * it. The collect secret is not here and never leaves main.
 */
export type FleetPairRequestView = {
  requestId: string
  endpoint: string
  machineName: string
  /**
   * The six digits the person at the other machine must TYPE to allow this
   * (pair-from-the-scan-and-stay-paired, phase 2). Minted over there; shown
   * large here so it can be read out.
   */
  comparisonCode: string
  expiresAt: string
  /** True when this request also offers the other machine a device here (phase 6). */
  reverseOffered: boolean
}

/**
 * How a request THIS machine made stopped waiting, or that it still is.
 * `failed` is the one phase the other machine never said: the wait ended
 * here (the credential could not be saved, or the reverse grant could not
 * be minted) and `detail` says why.
 */
export type FleetPairRequestPhase = 'waiting' | 'approved' | 'denied' | 'expired' | 'cancelled' | 'failed'

/**
 * Whether a paired machine answers right now (phase 4), as main last checked
 * it. `unauthorized` is the one refusal that is not "asleep": the machine
 * answered and refused our credential, so it was revoked over there.
 */
export type FleetMachineReachability = {
  connectionId: string
  machineName: string
  /** A check is in flight; `reachable` is the previous answer meanwhile. */
  checking: boolean
  reachable: boolean
  unauthorized: boolean
  /** Epoch ms of the last completed check, or null before the first. */
  checkedAt: number | null
  /** Epoch ms of the last time the machine answered, or null if it never has. */
  lastReachedAt: number | null
  /** The failure in a sentence when not reachable; null otherwise. */
  detail: string | null
}

export type FleetRequestPairingResult =
  | { ok: true; request: FleetPairRequestView }
  | { ok: false; code: string; message: string }

/**
 * The answer to one poll. `unreachable` is deliberately NOT an outcome here —
 * it comes back as `ok: false` so the panel keeps waiting rather than tearing
 * the request down: a machine that went to sleep mid-wait has not refused.
 */
export type FleetCollectPairingResult =
  | { ok: true; status: 'pending'; request: FleetPairRequestView }
  | { ok: true; status: 'approved'; connection: FleetConnection }
  | { ok: true; status: 'denied' }
  | { ok: true; status: 'expired' }
  | { ok: false; code: string; message: string }

/**
 * Broadcast fleet lifecycle (MC: remote-sessions-ux / tailnet-live-state-push).
 *
 * Distinct from the per-attachment `fleetTerminalEventChannel` stream, which
 * carries pty bytes to the one window that owns the pane. These are the
 * whole-app facts every window may care about — a machine paired or forgotten,
 * an attachment's link state changing — pushed on one channel so chrome (the
 * Remote glyph, toasts) never polls. The fleet has no per-machine supervisor:
 * "connected" is a property of its live attachments, and these events say
 * exactly that rather than inventing a machine phase main does not hold.
 */
export type FleetEvent =
  | { kind: 'machine-paired'; revision: number; connection: FleetConnection }
  | { kind: 'machine-forgotten'; revision: number; connectionId: string; machineName: string }
  | ({ kind: 'attachment'; revision: number } & FleetLiveAttachment)
  /**
   * A request this machine made to pair with another (phase 3): main owns
   * the wait, so every surface — not just the panel that asked — can show
   * the code while it waits and the answer when it lands. `connection` rides
   * on `approved`; `detail` on `failed` and `denied`.
   */
  | {
      kind: 'pair-request'
      revision: number
      phase: FleetPairRequestPhase
      request: FleetPairRequestView
      connection?: FleetConnection
      detail?: string
    }
  | ({ kind: 'machine-reachability'; revision: number } & FleetMachineReachability)

/**
 * One pane's link to one remote session. Keyed by `attachId` — the pane —
 * not by session: two panes on the same remote session are two links, and
 * one closing must not retract the other's "live".
 */
export type FleetLiveAttachment = {
  attachId: string
  connectionId: string
  machineName: string
  sessionId: string
  state: FleetLinkState
  detail: string
}

/**
 * The initial read behind `FLEET_EVENT_CHANNEL`: every attachment main holds
 * right now with its link state, so a window that mounts (or reloads) after
 * a pane went live is not stuck on "paired". Carries the same monotonic
 * `revision` the events do; a subscriber keeps whichever is newer.
 */
export type FleetLiveState = {
  revision: number
  attachments: FleetLiveAttachment[]
  /** Requests this machine made that are still waiting to be answered. */
  requests: FleetPairRequestView[]
  /** The last reachability answer per paired machine; absent before the first check. */
  reachability: FleetMachineReachability[]
}

export const FLEET_EVENT_CHANNEL = 'fleet:event'
export const FLEET_GET_LIVE_STATE_CHANNEL = 'fleet:get-live-state'

export const FLEET_REQUEST_PAIRING_CHANNEL = 'fleet:request-pairing'
export const FLEET_COLLECT_PAIRING_CHANNEL = 'fleet:collect-pairing'
export const FLEET_CANCEL_PAIRING_CHANNEL = 'fleet:cancel-pairing'
/** Re-check one paired machine now (the row's Retry), or every machine when no id is given. */
export const FLEET_CHECK_REACHABILITY_CHANNEL = 'fleet:check-reachability'
export const FLEET_LIST_CONNECTIONS_CHANNEL = 'fleet:list-connections'
export const FLEET_PAIR_CHANNEL = 'fleet:pair'
export const FLEET_FORGET_CHANNEL = 'fleet:forget'
export const FLEET_BROWSE_CHANNEL = 'fleet:browse'
export const FLEET_LIST_RUNS_CHANNEL = 'fleet:list-runs'
export const FLEET_CREATE_TERMINAL_CHANNEL = 'fleet:create-terminal'
/** One remote workspace's checkout facts (branch, branches, worktrees) over `workspace.checkout`. */
export const FLEET_WORKSPACE_CHECKOUT_CHANNEL = 'fleet:workspace-checkout'
export const FLEET_ATTACH_TERMINAL_CHANNEL = 'fleet:attach-terminal'
export const FLEET_DETACH_TERMINAL_CHANNEL = 'fleet:detach-terminal'
export const FLEET_TERMINAL_INPUT_CHANNEL = 'fleet:terminal-input'
export const FLEET_TERMINAL_RESIZE_CHANNEL = 'fleet:terminal-resize'
