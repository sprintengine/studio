import type { ConversationEvent, ConversationSessionSummary } from '../../shared/conversation-runtime'
import { distroOfHostId } from '../../shared/execution-host'
import { distroOfUncPath } from '../../shared/host-paths'
import type { RemoteBackendMember } from '../wsl/backend-wire'
import { createWslPathEdge, type WslPathEdge } from '../wsl/wsl-path-edge'
import type { WslEnvironmentManager, WslServerConnection } from '../wsl/wsl-environment-manager'
import type { ConversationBackend } from './conversation-backend'

// The front door's router (phase 7 spec, 5.1–5.3): one `ConversationBackend`
// that answers every caller (the chat view's IPC and protocol, the phone's
// lane, the gateway, modules, scheduled and companion agents) and sends each
// call to the server that owns the chat.
//
// Which server owns a chat is decided by the workspace's machine, never by
// where its folder sits (section 6): a workspace on `wsl:<distro>`, or one
// whose folder is inside that distribution whatever its machine says, goes to
// that distribution's server when the person turned chats on there
// (`ExecutionHostSettings.chatServer`); everything else stays in this process,
// on today's per-process path. A call about a running session goes to
// whichever side holds that session, so a session started before the switch
// moved finishes where it started, and one chat never has two writers.
//
// Reads that need no server stay here: the provider catalog is the same build
// on both sides, and a live process's pid means nothing across the VM. Lists
// that span every chat (sessions, approval rules) merge this process's with
// those of the servers already running; they never start one.

export type RoutedConversationBackendDeps = {
  local: ConversationBackend
  /** The workspace's machine and folder, from the front door's registry. */
  workspace(workspaceId: string): { hostId?: string | null; folderPath?: string | null } | null
  /** Whether a distribution's chats run on its server (the per-distribution switch). */
  chatServerOn(distro: string): boolean
  servers: Pick<WslEnvironmentManager, 'connect' | 'current' | 'touch'>
  platform?: NodeJS.Platform
  log?: (message: string) => void
}

export type RoutedConversationBackend = ConversationBackend & {
  /** A distribution's server connected (or reconnected): its events join the stream. */
  attach(connection: WslServerConnection): void
  /** Where a workspace's chats run now: `null` for this process, or the distribution. */
  routeOf(workspaceId: string, workspaceRoot?: string): string | null
}

// Members whose answer is `{ ok: false, message }` when they fail; the router
// answers a server it cannot reach the same way, in words.
const RESULT_MEMBERS: ReadonlySet<string> = new Set([
  'startSession',
  'sendTurn',
  'respondToRequest',
  'setPermission',
  'setModel',
  'interrupt',
  'stopSession',
  'suspendSession',
  'terminalHandoffTarget',
  'stopForTerminalHandoff',
  'readAttachment',
  'planDocument',
  'listThreads',
  'searchThreads',
  'renameThread',
  'deleteTranscript',
  'readTranscript',
  'readConversationSync',
  'readConversationPage',
  'getTurnDiff',
  'listApprovalRules',
  'revokeApprovalRule',
  'revertToTurn',
  'rewindToTurn',
  'forkAtTurn',
])

type Remote = { connection: WslServerConnection; edge: WslPathEdge; unsubscribe: () => void }

function workspaceKeyOf(first: unknown): { workspaceId?: string; workspaceRoot?: string } {
  if (typeof first !== 'object' || first === null) return {}
  const record = first as Record<string, unknown>
  const key = (typeof record.key === 'object' && record.key !== null ? record.key : record) as Record<string, unknown>
  return {
    ...(typeof key.workspaceId === 'string' ? { workspaceId: key.workspaceId } : {}),
    ...(typeof key.workspaceRoot === 'string' ? { workspaceRoot: key.workspaceRoot } : {}),
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createRoutedConversationBackend(deps: RoutedConversationBackendDeps): RoutedConversationBackend {
  const { local } = deps
  const platform = deps.platform ?? process.platform
  const log = deps.log ?? (() => undefined)
  const listeners = new Set<(event: ConversationEvent) => void>()
  const remotes = new Map<string, Remote>()
  // Which distribution each remote session last said it was in, so a call
  // about it after its server restarted goes there (and is answered there),
  // not to this process, which never held it.
  const sessionDistro = new Map<string, string>()

  const dispatch = (event: ConversationEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event)
      } catch (error) {
        log(`A chat event listener threw: ${failureMessage(error)}`)
      }
    }
  }
  local.onEvent(dispatch)

  function attach(connection: WslServerConnection): void {
    remotes.get(connection.distro)?.unsubscribe()
    const edge = createWslPathEdge({ distro: connection.distro, driveMountRoot: connection.driveMountRoot })
    const unsubscribe = connection.backend.onEvent((event) => {
      sessionDistro.set(event.sessionId, connection.distro)
      dispatch(event)
    })
    remotes.set(connection.distro, { connection, edge, unsubscribe })
  }

  function routeOf(workspaceId: string, workspaceRoot?: string): string | null {
    if (platform !== 'win32') return null
    const record = deps.workspace(workspaceId)
    const folder = record?.folderPath ?? workspaceRoot ?? null
    // A folder inside a distribution belongs to it, whatever the machine says
    // (the git resolver's order); otherwise the machine decides.
    const distro = (folder ? distroOfUncPath(folder) : null) ?? distroOfHostId(record?.hostId ?? null, platform)
    return distro && deps.chatServerOn(distro) ? distro : null
  }

  function liveRemote(distro: string): Remote | null {
    const remote = remotes.get(distro)
    if (!remote || deps.servers.current(distro) !== remote.connection) return null
    return remote
  }

  function sessionOwner(sessionId: string): string | null {
    const listed = local.listSessions()
    if (listed.ok && listed.sessions.some((session) => session.sessionId === sessionId)) return null
    for (const [distro, remote] of remotes) {
      const mirrored = remote.connection.backend.listSessions()
      if (mirrored.ok && mirrored.sessions.some((session) => session.sessionId === sessionId)) return distro
    }
    return sessionDistro.get(sessionId) ?? null
  }

  async function callRemote(distro: string, member: RemoteBackendMember, args: unknown[]): Promise<unknown> {
    deps.servers.touch(distro)
    const connection = await deps.servers.connect(distro)
    let remote = remotes.get(distro)
    if (!remote || remote.connection !== connection) {
      attach(connection)
      remote = remotes.get(distro)!
    }
    const method = (connection.backend as unknown as Record<string, (...input: unknown[]) => unknown>)[member]
    const value = await method.apply(connection.backend, remote.edge.args(member, args))
    const session = (value as { session?: ConversationSessionSummary } | null)?.session
    if (session?.sessionId) sessionDistro.set(session.sessionId, distro)
    return remote.edge.result(member, value)
  }

  /** A call to a distribution's server, failing the way the member fails when the server cannot be reached. */
  async function guarded(distro: string, member: RemoteBackendMember, args: unknown[]): Promise<unknown> {
    try {
      return await callRemote(distro, member, args)
    } catch (error) {
      if (!RESULT_MEMBERS.has(member) && member !== 'getToolDetail') throw error
      const message = failureMessage(error)
      log(`${member} in WSL: ${distro} failed: ${message}`)
      return member === 'getToolDetail' ? { ok: false, code: 'unavailable', message } : { ok: false, message }
    }
  }

  const localCall = (member: string, args: unknown[]): unknown =>
    (local as unknown as Record<string, (...input: unknown[]) => unknown>)[member].apply(local, args)

  /** A member answered where the chat's workspace runs. */
  const byWorkspace =
    (member: RemoteBackendMember) =>
    (...args: unknown[]): unknown => {
      const { workspaceId, workspaceRoot } = workspaceKeyOf(args[0])
      const distro = workspaceId ? routeOf(workspaceId, workspaceRoot) : null
      return distro ? guarded(distro, member, args) : localCall(member, args)
    }

  /** A member answered where the session runs. */
  const bySession =
    (member: RemoteBackendMember) =>
    (...args: unknown[]): unknown => {
      const first = args[0]
      const sessionId =
        typeof first === 'string'
          ? first
          : typeof (first as { sessionId?: unknown } | null)?.sessionId === 'string'
            ? (first as { sessionId: string }).sessionId
            : null
      const distro = sessionId ? sessionOwner(sessionId) : null
      return distro ? guarded(distro, member, args) : localCall(member, args)
    }

  const backend = {
    attach,
    routeOf,
    onEvent(listener: (event: ConversationEvent) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listSessions(input: { workspaceId?: string; agentId?: string } = {}) {
      const listed = local.listSessions(input)
      if (!listed.ok) return listed
      const sessions = [...listed.sessions]
      for (const distro of remotes.keys()) {
        const remote = liveRemote(distro)
        const mirrored = remote?.connection.backend.listSessions(input)
        if (mirrored?.ok) sessions.push(...mirrored.sessions)
      }
      return { ok: true as const, sessions }
    },
    // A live process's pid means nothing on the other side of the VM.
    listLiveConversationRoots: () => local.listLiveConversationRoots(),
    // The same build on both sides: the catalog is this process's.
    getProviderCapabilities: (providerId: string) => local.getProviderCapabilities(providerId),
    getNativeProviderModels: (providerId: string) => local.getNativeProviderModels(providerId),
    startSession(...args: unknown[]) {
      const input = args[0] as { workspaceId: string; agentId: string; workspaceRoot: string }
      const distro = routeOf(input.workspaceId, input.workspaceRoot)
      if (!distro) return localCall('startSession', args)
      // A chat still live here keeps its one writer until it stops.
      const here = local.listSessions({ workspaceId: input.workspaceId, agentId: input.agentId })
      if (here.ok && here.sessions.some((session) => session.status !== 'stopped'))
        return localCall('startSession', args)
      return guarded(distro, 'startSession', args)
    },
    sendTurn: bySession('sendTurn'),
    hasCommandReceipt: bySession('hasCommandReceipt'),
    respondToRequest: bySession('respondToRequest'),
    setPermission: bySession('setPermission'),
    setModel: bySession('setModel'),
    interrupt: bySession('interrupt'),
    stopSession: bySession('stopSession'),
    suspendSession: bySession('suspendSession'),
    terminalHandoffTarget: bySession('terminalHandoffTarget'),
    stopForTerminalHandoff: bySession('stopForTerminalHandoff'),
    endTerminalHandoff(...args: unknown[]) {
      const sessionId = (args[0] as { sessionId?: string } | null)?.sessionId
      const distro = sessionId ? sessionOwner(sessionId) : null
      if (!distro) {
        localCall('endTerminalHandoff', args)
        return
      }
      void guarded(distro, 'endTerminalHandoff', args).catch(() => undefined)
    },
    noteTerminalHandoff: bySession('noteTerminalHandoff'),
    getToolDetail: byWorkspace('getToolDetail'),
    findToolCall: byWorkspace('findToolCall'),
    async readAttachment(...args: unknown[]) {
      // A reference names no workspace: this process's store first, then each running server's.
      const here = (await localCall('readAttachment', args)) as { ok: boolean }
      if (here.ok) return here
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'readAttachment', args)) as { ok: boolean }
        if (there.ok) return there
      }
      return here
    },
    planDocument: byWorkspace('planDocument'),
    listThreads: byWorkspace('listThreads'),
    searchThreads(...args: unknown[]) {
      const { workspaceId, workspaceRoot } = workspaceKeyOf(args[0])
      const distro = workspaceId ? routeOf(workspaceId, workspaceRoot) : null
      if (!distro) return localCall('searchThreads', args)
      return (async () => {
        const result = (await guarded(distro, 'searchThreads', [args[0]])) as {
          ok: boolean
          hits?: unknown[]
        }
        const onBatch = (args[1] as { onBatch?: (hits: unknown[]) => void } | undefined)?.onBatch
        if (result.ok && result.hits?.length) onBatch?.(result.hits)
        return result
      })()
    },
    renameThread: byWorkspace('renameThread'),
    deleteTranscript: byWorkspace('deleteTranscript'),
    readTranscript: byWorkspace('readTranscript'),
    readPeekTranscript: byWorkspace('readPeekTranscript'),
    readConversationSync: byWorkspace('readConversationSync'),
    readConversationPage: byWorkspace('readConversationPage'),
    recoverTranscript: byWorkspace('recoverTranscript'),
    getTurnDiff: byWorkspace('getTurnDiff'),
    async listApprovalRules() {
      const here = await local.listApprovalRules()
      if (!here.ok) return here
      const rules = [...here.rules]
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'listApprovalRules', [])) as typeof here
        if (there.ok) rules.push(...there.rules)
      }
      return { ok: true as const, rules }
    },
    async revokeApprovalRule(ruleId: string) {
      const here = await local.revokeApprovalRule(ruleId)
      if (here.ok) return here
      for (const distro of remotes.keys()) {
        if (!liveRemote(distro)) continue
        const there = (await guarded(distro, 'revokeApprovalRule', [ruleId])) as typeof here
        if (there.ok) return there
      }
      return here
    },
    revertToTurn: byWorkspace('revertToTurn'),
    rewindToTurn: byWorkspace('rewindToTurn'),
    forkAtTurn: byWorkspace('forkAtTurn'),
  }
  return backend as unknown as RoutedConversationBackend
}
