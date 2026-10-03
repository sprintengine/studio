import { randomBytes } from 'node:crypto'

import {
  STUDIO_MAX_TOOL_RESULT_BYTES,
  STUDIO_RESERVED_TOOLSET_NAMES,
  STUDIO_TOOL_LIMITS,
  isStudioBuiltInToolset,
  studioToolWireName,
  studioUtf8Length,
  type StudioCallFrame,
  type StudioCancelFrame,
  type StudioCancelReason,
  type StudioClientKind,
  type StudioProgressFrame,
  type StudioReplyFrame,
  type StudioToolCallContext,
  type StudioToolReach,
  type StudioToolResult,
  type StudioToolSpec,
  type StudioToolsetListing,
  type StudioToolsetOffer,
} from '../../../packages/studio-protocol/src/public'
import { toolError, type McpConnectionMetadata } from '../../shared/modules/mcp-tools'
import type { ClientToolsetStore, ConversationRef } from './client-toolset-store'

// The server's half of client tools: who offers what, who may see it, which
// client a call goes to, and what happens to a call when its client goes
// away. Transport-free: a connection is a `send` and an id, a call is a
// promise, and the gateway and the RPC each hold one end.
//
// The unit is an instance, not a connection: one client process, named by the
// `instanceId` its hello carried, across its reconnects. A connection that
// drops leaves its instance in place for a grace (20 s), with its offers, its
// affinities and the calls it was running; the same process reconnecting and
// offering again picks those calls up where they were, each sent once more
// under its own id and marked as a redelivery, and the SDK answers a call it
// has seen from its own memory. A process that restarted has a new instance
// id and none of that memory, so nothing is redelivered to it: a read is
// routed once more, and a mutation is answered `client_disconnected`, so a
// mutation runs at most once.
//
// Nothing is ever taken back from an agent's list here (that is the gateway's
// catalog); a tool whose client has gone answers one sentence saying so.

export type ClientToolInstanceInfo = {
  clientId: string
  clientName: string
  kind: StudioClientKind
  instanceId: string
}

/** One client connection, as the RPC hands it to the registry. */
export type ClientToolConnection = ClientToolInstanceInfo & {
  connectionId: string
  owner: boolean
  /**
   * The toolsets reserved for Studio's own shell this connection may offer:
   * `'all'` for the shell, a list for a client that may offer only some (a
   * web client offers the canvas), none for an app.
   */
  shell: 'all' | readonly string[] | null
  /** Whether what it offers is audited. Studio's own shell, over its own port, is the app rather than a client of it. */
  audited: boolean
  send(frame: StudioCallFrame | StudioCancelFrame): void
}

/** Who is calling a client tool: an agent's gateway connection. */
export type ClientToolCaller = {
  /** The gateway connection, for affinity, its in-flight bound and `agent_gone`. */
  gatewayConnectionId: string
  metadata: McpConnectionMetadata
  /**
   * The conversation this connection belongs to, proven by its launch token.
   * Never what the connection declared: a declared identity is only a claim.
   */
  conversation?: ConversationRef
}

/** A tool as the gateway lists it to agents. */
export type ClientToolDefinition = {
  toolset: string
  builtIn: boolean
  title: string
  description?: string
  tool: StudioToolSpec
  wireName: string
  mutates: boolean
}

export type ClientToolServedBy = { clientId: string; clientName: string; instanceId: string; kind: StudioClientKind }

export type ClientToolCallOutcome = { result: StudioToolResult; servedBy?: ClientToolServedBy }

export type ClientToolOfferOutcome =
  | { ok: true; toolset: string; wireNames: string[]; reach: StudioToolReach }
  | { ok: false; code: string; message: string; retryAfterMs?: number }

/** An offer or a withdrawal, as the RPC's audit records it: the toolset's name and size, never a tool's input or result. */
export type ClientToolAuditEntry = {
  clientId: string
  clientName: string
  tool: 'tools.offer' | 'tools.withdraw'
  toolset: string
  tools: number
  ok: boolean
  code?: string
}

export type ClientToolRegistryOptions = {
  store: ClientToolsetStore
  /**
   * Names a client may not offer because Studio serves them itself (its core
   * and module tools' families). Read on every offer, so a module enabled
   * later is covered.
   */
  servedFamilies: () => Iterable<string>
  /** Names reserved beyond the protocol's floor (every module id). Read on every offer. */
  reservedNames?: () => Iterable<string>
  /** An app's reach, from its pairing. Owners name theirs on the offer. */
  reachOf?: (clientId: string) => StudioToolReach
  /** The client that started a conversation, read from its record. */
  startedBy?: (conversation: ConversationRef) => string | null
  /** Called whenever what agents may be listed changes: an offer, a withdrawal, a grant, a client gone. */
  onChange?: () => void
  /** Told on each RPC audit-worthy act; never input or results. */
  audit?: (entry: ClientToolAuditEntry) => void
  /**
   * An app offered a toolset name for the first time, and agents may now be
   * given its tools: the person hears of it once (decisions R82).
   */
  onFirstOffer?: (entry: {
    clientId: string
    clientName: string
    toolset: string
    title: string
    tools: number
  }) => void
  log?: (message: string) => void
  now?: () => number
  graceMs?: number
}

type Offered = {
  offer: StudioToolsetOffer
  title: string
  reach: StudioToolReach
  builtIn: boolean
  offeredAt: number
  tools: Map<string, StudioToolSpec>
}

type Instance = ClientToolInstanceInfo & {
  key: string
  owner: boolean
  audited: boolean
  shell: ClientToolConnection['shell']
  connection: ClientToolConnection | null
  offers: Map<string, Offered>
  focus: { focused: boolean; workspaceIds: Set<string> } | null
  focusedAt: number
  /** When its connection dropped, while it waits out its grace. */
  graceTimer: ReturnType<typeof setTimeout> | null
  /** Offers and withdrawals in the last minute on its current connection, for the rate limit. */
  offerTimes: number[]
  /**
   * Toolsets it offered on a connection before this one, not yet offered
   * again. Nothing is sent under them; if they are not offered again within
   * the grace they go, as an instance's offers go when it does not come back.
   */
  stale: Set<string>
  staleTimer: ReturnType<typeof setTimeout> | null
  /** Cancels for calls it was sent, held while it has no connection to tell. */
  pendingCancels: StudioCancelFrame[]
}

type CallState = 'waiting' | 'sent' | 'orphaned'

type Call = {
  id: string
  toolset: string
  tool: string
  wireName: string
  input: Record<string, unknown>
  caller: ClientToolCaller
  mutates: boolean
  timeoutMs: number
  instance: Instance
  state: CallState
  /** Connections this id was sent to, so a second send is marked a redelivery. */
  sentTo: Set<string>
  rerouted: boolean
  /** Prefixed to the first text part when the toolset moved to another client under this caller. */
  notice?: string
  deadline: ReturnType<typeof setTimeout>
  onProgress?: (progress: { progress?: number; total?: number; message?: string }) => void
  settle: (outcome: ClientToolCallOutcome) => void
}

type Affinity = { instanceKey: string | null; movedFrom?: string }

const DEFAULT_GRACE_MS = STUDIO_TOOL_LIMITS.reconnectGraceMs
const BUSY_RETRY_MS = 500
const MAX_AFFINITIES = 8192
const MAX_PENDING_CANCELS = 256
const SHELL_KIND_ORDER: Record<StudioClientKind, number> = { desktop: 0, web: 1, headless: 2, app: 3 }

function noun(toolset: string, title: string): string {
  return toolset === 'browser' ? 'the browser' : toolset === 'canvas' ? 'the canvas' : title
}

function failure(code: string, message: string, extra?: Record<string, unknown>): StudioToolResult {
  const result = toolError(code, message) as StudioToolResult
  if (extra) result.structuredContent = { ...result.structuredContent, ...extra }
  return result
}

export type ClientToolRegistry = ReturnType<typeof createClientToolRegistry>

export function createClientToolRegistry(options: ClientToolRegistryOptions) {
  const now = options.now ?? Date.now
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const instances = new Map<string, Instance>()
  const byConnection = new Map<string, Instance>()
  const calls = new Map<string, Call>()
  // The newest definition of each toolset any client offered, kept after the
  // client goes: a catalog that listed a tool keeps describing it.
  const definitions = new Map<string, Offered>()
  // Why a toolset with no offer has none: its client withdrew it, or left.
  const lastGone = new Map<string, 'withdrawn' | 'disconnected'>()
  const affinities = new Map<string, Affinity>()
  // Conversations an app started, by instance, while this process runs: the
  // record says which client, this says which of its processes.
  const startedInstances = new Map<string, string>()
  const buckets = new Map<string, { tokens: number; at: number }>()
  let sequence = 0
  let closed = false
  const callPrefix = randomBytes(6).toString('hex')

  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of [...(options.onChange ? [options.onChange] : []), ...listeners]) {
      try {
        listener()
      } catch (error) {
        options.log?.(`A client tools listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  const conversationKey = (ref: ConversationRef) => `${ref.workspaceId}\u0000${ref.agentId}`
  const affinityKey = (caller: ClientToolCaller, toolset: string) =>
    caller.conversation
      ? `c\u0000${conversationKey(caller.conversation)}\u0000${toolset}`
      : `g\u0000${caller.gatewayConnectionId}\u0000${toolset}`
  const servedBy = (instance: Instance): ClientToolServedBy => ({
    clientId: instance.clientId,
    clientName: instance.clientName,
    instanceId: instance.instanceId,
    kind: instance.kind,
  })

  // ── Names and reach ───────────────────────────────────────────────────────

  function servedHere(name: string): boolean {
    for (const family of options.servedFamilies()) if (family === name) return true
    return false
  }
  function reserved(name: string): boolean {
    if (STUDIO_RESERVED_TOOLSET_NAMES.includes(name)) return true
    for (const extra of options.reservedNames?.() ?? []) if (extra === name) return true
    return false
  }
  function mayOfferReserved(shell: ClientToolConnection['shell'], name: string): boolean {
    return shell === 'all' || (Array.isArray(shell) && shell.includes(name))
  }

  /** Whether an app toolset reaches this caller. Built-ins reach every caller, as today. */
  function reaches(toolset: string, caller: ClientToolCaller): boolean {
    if (isStudioBuiltInToolset(toolset) || reserved(toolset)) return true
    if (caller.metadata.kind === 'remote-tailnet') return false
    const binding = options.store.binding(toolset)
    if (!binding) return false
    const reach = reachFor(binding.clientId, toolset)
    if (reach === 'all') return true
    const conversation = caller.conversation
    if (!conversation) return false
    if (options.startedBy?.(conversation) === binding.clientId) return true
    return binding.conversations.some(
      (ref) => ref.workspaceId === conversation.workspaceId && ref.agentId === conversation.agentId,
    )
  }

  function reachFor(clientId: string, toolset: string): StudioToolReach {
    // An owner's reach is the one its newest offer named.
    const offered = definitions.get(toolset)
    if (clientId === 'owner') return offered?.reach ?? 'own'
    return options.reachOf?.(clientId) ?? 'own'
  }

  // ── Instances ─────────────────────────────────────────────────────────────

  function instanceKey(clientId: string, instanceId: string): string {
    return `${clientId}\u0000${instanceId}`
  }

  function offering(toolset: string, includeAway = true): Instance[] {
    return [...instances.values()].filter(
      (instance) => instance.offers.has(toolset) && (includeAway || instance.connection !== null),
    )
  }

  function sentCount(instance: Instance): number {
    let count = 0
    for (const call of calls.values()) if (call.instance === instance && call.state === 'sent') count++
    return count
  }

  function connectionOf(connectionId: string): Instance | null {
    return byConnection.get(connectionId) ?? null
  }

  /**
   * A connection said hello and may offer tools. The same instance id from the
   * same client is the same process coming back: it takes its instance over
   * (and a connection it had still open is told its calls went elsewhere).
   */
  function attach(connection: ClientToolConnection): void {
    if (closed) return
    const key = instanceKey(connection.clientId, connection.instanceId)
    let instance = instances.get(key)
    if (instance) {
      if (instance.graceTimer) clearTimeout(instance.graceTimer)
      instance.graceTimer = null
      const previous = instance.connection
      if (previous && previous.connectionId !== connection.connectionId) {
        byConnection.delete(previous.connectionId)
        for (const call of calls.values())
          if (call.instance === instance && call.state === 'sent') {
            safeSend(previous, { t: 'cancel', id: call.id, reason: 'client_replaced' })
            call.state = 'orphaned'
          }
      }
      instance.connection = connection
      instance.clientName = connection.clientName
      instance.kind = connection.kind
      instance.shell = connection.shell
      instance.audited = connection.audited
      if (previous?.connectionId !== connection.connectionId) {
        // The rate limit is a connection's: a process that comes back may offer again.
        instance.offerTimes = []
        // What it offered before waits for it to offer again, within a grace.
        if (instance.offers.size > 0) {
          for (const name of instance.offers.keys()) instance.stale.add(name)
          if (instance.staleTimer) clearTimeout(instance.staleTimer)
          instance.staleTimer = setTimeout(() => expireStale(instance!), graceMs)
          instance.staleTimer.unref?.()
        }
        // What was cancelled while it was away is told to it now.
        for (const frame of instance.pendingCancels.splice(0)) safeSend(connection, frame)
      }
    } else {
      instance = {
        key,
        clientId: connection.clientId,
        clientName: connection.clientName,
        kind: connection.kind,
        instanceId: connection.instanceId,
        owner: connection.owner,
        audited: connection.audited,
        shell: connection.shell,
        connection,
        offers: new Map(),
        focus: null,
        focusedAt: 0,
        graceTimer: null,
        offerTimes: [],
        stale: new Set(),
        staleTimer: null,
        pendingCancels: [],
      }
      instances.set(key, instance)
    }
    byConnection.set(connection.connectionId, instance)
  }

  /**
   * A connection closed. Its instance keeps everything for the grace; calls it
   * was running wait for it to come back, and so do calls routed to it since.
   */
  function detach(connectionId: string): void {
    const instance = byConnection.get(connectionId)
    byConnection.delete(connectionId)
    if (!instance || instance.connection?.connectionId !== connectionId) return
    instance.connection = null
    for (const call of calls.values()) if (call.instance === instance && call.state === 'sent') call.state = 'orphaned'
    if (instance.offers.size === 0 && ![...calls.values()].some((call) => call.instance === instance)) {
      instances.delete(instance.key)
      return
    }
    instance.graceTimer = setTimeout(() => expire(instance), graceMs)
    instance.graceTimer.unref?.()
    changed()
  }

  /** The grace ran out: the instance's offers go, its affinities move, and its calls are settled. */
  function expire(instance: Instance): void {
    if (instances.get(instance.key) !== instance || instance.connection) return
    instance.graceTimer = null
    instances.delete(instance.key)
    for (const toolset of instance.offers.keys()) if (!offering(toolset).length) lastGone.set(toolset, 'disconnected')
    instance.offers.clear()
    for (const affinity of affinities.values())
      if (affinity.instanceKey === instance.key) {
        affinity.instanceKey = null
        affinity.movedFrom = instance.clientName
      }
    if (instance.staleTimer) clearTimeout(instance.staleTimer)
    instance.staleTimer = null
    instance.stale.clear()
    instance.pendingCancels = []
    for (const call of [...calls.values()])
      if (call.instance === instance)
        settleElsewhere(call, `${instance.clientName} disconnected while running ${call.wireName}.`)
    changed()
  }

  /**
   * A call its client can no longer answer: one never sent, or a read, is
   * tried once more elsewhere; a mutation it may have run is answered so.
   */
  function settleElsewhere(call: Call, why: string): void {
    if (call.state === 'waiting' || (call.state === 'orphaned' && !call.mutates && !call.rerouted)) {
      if (call.state === 'orphaned') call.rerouted = true
      reroute(call)
      return
    }
    finish(call, failure('client_disconnected', `${why} It may or may not have finished; check before retrying.`))
  }

  /** A process came back and did not offer again what it offered before: those toolsets go. */
  function expireStale(instance: Instance): void {
    instance.staleTimer = null
    if (instances.get(instance.key) !== instance || !instance.stale.size) return
    const gone = [...instance.stale]
    instance.stale.clear()
    for (const name of gone) {
      instance.offers.delete(name)
      if (!offering(name).length) lastGone.set(name, 'disconnected')
    }
    for (const call of [...calls.values()])
      if (call.instance === instance && gone.includes(call.toolset) && call.state !== 'sent')
        settleElsewhere(call, `${instance.clientName} came back without ${call.wireName}.`)
    changed()
  }

  function safeSend(connection: ClientToolConnection, frame: StudioCallFrame | StudioCancelFrame): void {
    try {
      connection.send(frame)
    } catch (error) {
      options.log?.(`A client tool frame could not be sent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ── Offers ────────────────────────────────────────────────────────────────

  function rateLimited(instance: Instance): number | null {
    const at = now()
    instance.offerTimes = instance.offerTimes.filter((time) => at - time < 60_000)
    if (instance.offerTimes.length >= STUDIO_TOOL_LIMITS.offersPerMinute)
      return Math.max(1, 60_000 - (at - instance.offerTimes[0]))
    instance.offerTimes.push(at)
    return null
  }

  function appToolsetCount(instance: Instance): number {
    let count = 0
    for (const offered of instance.offers.values()) if (!offered.builtIn) count++
    return count
  }

  function appToolCount(except: string): number {
    let count = 0
    const counted = new Set<string>()
    for (const instance of instances.values())
      for (const [name, offered] of instance.offers) {
        if (offered.builtIn || name === except || counted.has(name)) continue
        counted.add(name)
        count += offered.tools.size
      }
    return count
  }

  function offer(
    connectionId: string,
    toolset: StudioToolsetOffer,
    requestedReach?: StudioToolReach,
  ): ClientToolOfferOutcome {
    const instance = connectionOf(connectionId)
    if (!instance) return { ok: false, code: 'unavailable', message: 'This connection cannot offer tools.' }
    const audit = (ok: boolean, code?: string) =>
      instance.audited &&
      options.audit?.({
        clientId: instance.clientId,
        clientName: instance.clientName,
        tool: 'tools.offer',
        toolset: toolset.name,
        tools: toolset.tools.length,
        ok,
        ...(code ? { code } : {}),
      })
    const refuse = (code: string, message: string, retryAfterMs?: number): ClientToolOfferOutcome => {
      audit(false, code)
      return { ok: false, code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    }
    const name = toolset.name
    // A name Studio serves itself is no one's to shadow, its own shell's included.
    if (servedHere(name)) return refuse('reserved_name', `Studio serves "${name}" tools itself.`)
    const builtIn = reserved(name)
    if (builtIn && !mayOfferReserved(instance.shell, name))
      return refuse('reserved_name', `"${name}" is reserved for Studio's own tools.`)
    const retryAfterMs = rateLimited(instance)
    if (retryAfterMs !== null)
      return refuse(
        'busy',
        `Toolsets may be offered or withdrawn ${STUDIO_TOOL_LIMITS.offersPerMinute} times a minute.`,
        retryAfterMs,
      )
    // The bound is on a client's own toolsets. The reserved names the shell
    // offers are a fixed list, and the WSL front door offers a server more of
    // them than the bound holds: the shell's six and the Windows side's own.
    if (!builtIn && !instance.offers.has(name) && appToolsetCount(instance) >= STUDIO_TOOL_LIMITS.toolsetsPerConnection)
      return refuse('too_large', `A client may offer at most ${STUDIO_TOOL_LIMITS.toolsetsPerConnection} toolsets.`)
    if (!builtIn && appToolCount(name) + toolset.tools.length > STUDIO_TOOL_LIMITS.appToolsPerServer)
      return refuse('busy', `Apps may give agents at most ${STUDIO_TOOL_LIMITS.appToolsPerServer} tools in all.`)
    const title = toolset.title ?? (builtIn ? name : instance.clientName.slice(0, STUDIO_TOOL_LIMITS.titleChars))
    let firstOffer = false
    if (!builtIn) {
      const binding = options.store.binding(name)
      if (binding && binding.clientId !== instance.clientId)
        return refuse('name_taken', `Another app already gives agents "${name}" tools.`)
      firstOffer = binding === null && !instance.owner
      try {
        options.store.bind(name, instance.clientId, title)
      } catch (error) {
        options.log?.(`A toolset name could not be bound: ${error instanceof Error ? error.message : String(error)}`)
        return refuse('unavailable', 'Studio could not record that toolset.')
      }
    }
    const reach: StudioToolReach = builtIn
      ? 'all'
      : instance.owner
        ? (requestedReach ?? 'own')
        : (options.reachOf?.(instance.clientId) ?? 'own')
    const offered: Offered = {
      offer: toolset,
      title,
      reach,
      builtIn,
      offeredAt: now(),
      tools: new Map(toolset.tools.map((tool) => [tool.name, tool])),
    }
    instance.offers.set(name, offered)
    instance.stale.delete(name)
    if (!instance.stale.size && instance.staleTimer) {
      clearTimeout(instance.staleTimer)
      instance.staleTimer = null
    }
    definitions.set(name, offered)
    lastGone.delete(name)
    audit(true)
    if (firstOffer)
      try {
        options.onFirstOffer?.({
          clientId: instance.clientId,
          clientName: instance.clientName,
          toolset: name,
          title,
          tools: toolset.tools.length,
        })
      } catch (error) {
        options.log?.(`A first-offer listener threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    // The same process back within its grace: what it was running, and what
    // waited for it, goes to it now.
    // One for a tool this offer no longer has is answered, not left to its deadline.
    if (instance.connection)
      for (const call of [...calls.values()])
        if (call.instance === instance && call.toolset === name && call.state !== 'sent') {
          if (offered.tools.has(call.tool)) send(call)
          else settleElsewhere(call, `${instance.clientName} no longer offers ${call.wireName}.`)
        }
    changed()
    return {
      ok: true,
      toolset: name,
      wireNames: toolset.tools.map((tool) => studioToolWireName(name, tool.name)),
      reach,
    }
  }

  function withdraw(
    connectionId: string,
    toolset: string,
  ): { ok: true; withdrawn: boolean } | { ok: false; code: string; message: string; retryAfterMs?: number } {
    const instance = connectionOf(connectionId)
    if (!instance) return { ok: false, code: 'unavailable', message: 'This connection cannot offer tools.' }
    const held = instance.offers.get(toolset)
    if (!held) return { ok: false, code: 'not_offered', message: `This connection does not offer "${toolset}".` }
    const retryAfterMs = rateLimited(instance)
    if (retryAfterMs !== null)
      return {
        ok: false,
        code: 'busy',
        message: `Toolsets may be offered or withdrawn ${STUDIO_TOOL_LIMITS.offersPerMinute} times a minute.`,
        retryAfterMs,
      }
    instance.offers.delete(toolset)
    instance.stale.delete(toolset)
    if (!offering(toolset).length) lastGone.set(toolset, 'withdrawn')
    // A call sent before may still be answered; one that was waiting for this
    // offer is not left to its deadline.
    for (const call of [...calls.values()])
      if (call.instance === instance && call.toolset === toolset && call.state !== 'sent')
        settleElsewhere(call, `${instance.clientName} no longer offers ${call.wireName}.`)
    if (instance.audited)
      options.audit?.({
        clientId: instance.clientId,
        clientName: instance.clientName,
        tool: 'tools.withdraw',
        toolset,
        tools: held.tools.size,
        ok: true,
      })
    changed()
    return { ok: true, withdrawn: true }
  }

  function focus(connectionId: string, hint: { focused: boolean; workspaceIds: string[] }): void {
    const instance = connectionOf(connectionId)
    if (!instance) return
    instance.focus = { focused: hint.focused, workspaceIds: new Set(hint.workspaceIds) }
    if (hint.focused) instance.focusedAt = now()
  }

  // ── What agents see ───────────────────────────────────────────────────────

  /** Every client tool this caller may be listed, from a toolset someone offers now (within its grace too). */
  function visibleTools(caller: ClientToolCaller): ClientToolDefinition[] {
    const out: ClientToolDefinition[] = []
    const names = new Set<string>()
    for (const instance of instances.values()) for (const name of instance.offers.keys()) names.add(name)
    for (const name of names) {
      if (!reaches(name, caller)) continue
      const definition = definitions.get(name)
      if (definition) out.push(...describe(name, definition))
    }
    return out
  }

  function describe(toolset: string, offered: Offered): ClientToolDefinition[] {
    return [...offered.tools.values()].map((tool) => ({
      toolset,
      builtIn: offered.builtIn,
      title: offered.title,
      ...(offered.offer.description ? { description: offered.offer.description } : {}),
      tool,
      wireName: studioToolWireName(toolset, tool.name),
      mutates: offered.builtIn ? tool.mutates === true : tool.mutates !== false,
    }))
  }

  /** The newest definition of one wire name, offered now or not. */
  function definitionOf(toolset: string, tool: string): ClientToolDefinition | null {
    const offered = definitions.get(toolset)
    if (!offered) return null
    return describe(toolset, offered).find((definition) => definition.tool.name === tool) ?? null
  }

  /** Whether a toolset name is one a client may answer for: built in, reserved for the shell, or bound to a pairing. */
  /** A toolset a client may answer for. A family Studio serves itself is never one: no client may offer it. */
  function isKnownToolset(toolset: string): boolean {
    if (servedHere(toolset)) return false
    return isStudioBuiltInToolset(toolset) || reserved(toolset) || options.store.binding(toolset) !== null
  }

  function catalog(viewer: { clientId: string; owner: boolean }): StudioToolsetListing[] {
    const names = new Set<string>(definitions.keys())
    const listings: StudioToolsetListing[] = []
    for (const name of [...names].sort()) {
      const offered = definitions.get(name)!
      const binding = offered.builtIn ? null : options.store.binding(name)
      if (!offered.builtIn && !viewer.owner && binding?.clientId !== viewer.clientId) continue
      if (!offered.builtIn && !binding) continue
      listings.push({
        name,
        title: offered.title,
        builtIn: offered.builtIn,
        offeredBy: offering(name).map((instance) => ({
          clientName: instance.clientName,
          kind: instance.kind,
          instanceId: instance.instanceId,
          connected: instance.connection !== null,
        })),
        tools: describe(name, offered).map((definition) => ({
          name: definition.tool.name,
          wireName: definition.wireName,
          mutates: definition.mutates,
        })),
      })
    }
    return listings
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  function candidates(toolset: string, tool: string): Instance[] {
    return offering(toolset).filter((instance) => instance.offers.get(toolset)!.tools.has(tool))
  }

  function rank(list: Instance[], caller: ClientToolCaller, toolset: string): Instance | null {
    if (!list.length) return null
    const workspaceId = caller.conversation?.workspaceId ?? caller.metadata.workspaceId
    const started = caller.conversation ? startedInstances.get(conversationKey(caller.conversation)) : undefined
    const score = (instance: Instance): number[] => [
      instance.connection ? 0 : 1,
      workspaceId && instance.focus?.focused && instance.focus.workspaceIds.has(workspaceId) ? 0 : 1,
      workspaceId && instance.focus?.workspaceIds.has(workspaceId) ? 0 : 1,
      started && started === instance.key ? 0 : 1,
      SHELL_KIND_ORDER[instance.kind],
      -instance.focusedAt,
      -(instance.offers.get(toolset)?.offeredAt ?? 0),
    ]
    const compare = (a: number[], b: number[]) => {
      for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index]
      return 0
    }
    return [...list].sort((a, b) => compare(score(a), score(b)))[0]
  }

  /** Where one call goes: its conversation's affinity if that client still offers the tool, else the best other. */
  function route(
    caller: ClientToolCaller,
    toolset: string,
    tool: string,
  ): { instance: Instance; notice?: string } | null {
    const key = affinityKey(caller, toolset)
    const affinity = affinities.get(key)
    const list = candidates(toolset, tool)
    if (affinity?.instanceKey) {
      const held = instances.get(affinity.instanceKey)
      if (held && list.includes(held)) {
        // Used, so kept longest: the bound drops the affinities nobody uses.
        affinities.delete(key)
        affinities.set(key, affinity)
        return { instance: held }
      }
    }
    const best = rank(list, caller, toolset)
    if (!best) return null
    const movedFrom = affinity && affinity.instanceKey === null ? affinity.movedFrom : undefined
    affinities.delete(key)
    affinities.set(key, { instanceKey: best.key })
    // One per conversation and toolset: the oldest go first past a bound.
    while (affinities.size > MAX_AFFINITIES) affinities.delete(affinities.keys().next().value!)
    const offered = best.offers.get(toolset)!
    const notice =
      movedFrom !== undefined
        ? `${noun(toolset, offered.title).replace(/^./, (first) => first.toUpperCase())} is now in ${best.clientName}. ${toolset === 'browser' ? 'Tab ids from before no longer apply.' : 'What it handed out before may no longer apply.'}`
        : undefined
    return { instance: best, ...(notice ? { notice } : {}) }
  }

  // ── Calls ─────────────────────────────────────────────────────────────────

  function unavailable(toolset: string, tool: string): StudioToolResult {
    const wireName = studioToolWireName(toolset, tool)
    const definition = definitions.get(toolset)
    const title = definition?.title ?? options.store.binding(toolset)?.title ?? toolset
    const gone = lastGone.get(toolset)
    if (definition && offering(toolset).length > 0)
      // Offered, but not this tool any more.
      return failure('tool_withdrawn', `${title} no longer offers ${wireName}.`)
    if (gone === 'withdrawn' && !isStudioBuiltInToolset(toolset))
      return failure('tool_withdrawn', `${title} no longer offers ${wireName}.`)
    if (isStudioBuiltInToolset(toolset))
      return failure(
        'client_unavailable',
        `Open Studio on a desktop and connect it to this machine to use ${noun(toolset, title)}.`,
      )
    return failure('client_unavailable', `${title} is not running. Start it to use ${wireName}.`)
  }

  function takeToken(clientId: string): boolean {
    const at = now()
    const bucket = buckets.get(clientId) ?? { tokens: STUDIO_TOOL_LIMITS.callBurstPerApp, at }
    bucket.tokens = Math.min(
      STUDIO_TOOL_LIMITS.callBurstPerApp,
      bucket.tokens + ((at - bucket.at) / 1000) * STUDIO_TOOL_LIMITS.callsPerSecondPerApp,
    )
    bucket.at = at
    buckets.set(clientId, bucket)
    if (bucket.tokens < 1) return false
    bucket.tokens -= 1
    return true
  }

  function busy(name: string): ClientToolCallOutcome {
    return {
      result: failure('busy', `${name} is busy; retry shortly.`, { retryAfterMs: BUSY_RETRY_MS }),
    }
  }

  function contextFor(call: Call): StudioToolCallContext {
    const metadata = call.caller.metadata
    const connection: StudioToolCallContext['connection'] = { kind: metadata.kind }
    for (const key of ['workspaceId', 'agentId', 'agentName', 'cliId'] as const)
      if (metadata[key]) connection[key] = metadata[key]
    // A paired device's identity is the shell's business, not an app's.
    if (call.instance.shell !== null) {
      if (metadata.deviceId) connection.deviceId = metadata.deviceId
      if (metadata.deviceName) connection.deviceName = metadata.deviceName
    }
    return {
      connection,
      ...(call.caller.conversation
        ? {
            conversation: {
              workspaceId: call.caller.conversation.workspaceId,
              agentId: call.caller.conversation.agentId,
            },
          }
        : {}),
    }
  }

  function send(call: Call): void {
    const connection = call.instance.connection
    if (
      !connection ||
      call.instance.stale.has(call.toolset) ||
      !call.instance.offers.get(call.toolset)?.tools.has(call.tool)
    ) {
      call.state = call.sentTo.size ? 'orphaned' : 'waiting'
      return
    }
    const redelivery = call.sentTo.size > 0
    call.sentTo.add(connection.connectionId)
    call.state = 'sent'
    safeSend(connection, {
      t: 'call',
      id: call.id,
      toolset: call.toolset,
      tool: call.tool,
      input: call.input,
      context: contextFor(call),
      timeoutMs: call.timeoutMs,
      ...(redelivery ? { redelivery: true as const } : {}),
    })
  }

  function finish(call: Call, result: StudioToolResult): void {
    if (calls.get(call.id) !== call) return
    calls.delete(call.id)
    clearTimeout(call.deadline)
    const prefixed =
      call.notice && !result.isError
        ? (() => {
            const index = result.content.findIndex((part) => part.type === 'text')
            if (index === -1)
              return { ...result, content: [{ type: 'text' as const, text: call.notice! }, ...result.content] }
            const content = [...result.content]
            const part = content[index] as { type: 'text'; text: string }
            content[index] = { type: 'text', text: `${call.notice}\n\n${part.text}` }
            return { ...result, content }
          })()
        : result
    call.settle({ result: prefixed, servedBy: servedBy(call.instance) })
  }

  /** Stop waiting for a call: the agent is answered at once, and its client told if it had it. */
  function cancel(call: Call, reason: StudioCancelReason, result: StudioToolResult): void {
    if (calls.get(call.id) !== call) return
    // A client that was sent the call is told, now or when it comes back:
    // its handler may still be running.
    if (call.sentTo.size > 0) {
      const frame: StudioCancelFrame = { t: 'cancel', id: call.id, reason }
      const connection = call.instance.connection
      if (connection) safeSend(connection, frame)
      else {
        call.instance.pendingCancels.push(frame)
        if (call.instance.pendingCancels.length > MAX_PENDING_CANCELS) call.instance.pendingCancels.shift()
      }
    }
    finish(call, result)
  }

  function reroute(call: Call): void {
    const next = route(call.caller, call.toolset, call.tool)
    if (!next || next.instance === call.instance) {
      finish(call, unavailable(call.toolset, call.tool))
      return
    }
    call.instance = next.instance
    if (next.notice) call.notice = next.notice
    // A new client has never seen this id, so it is not a redelivery there.
    call.sentTo.clear()
    send(call)
  }

  /**
   * Run one client tool for an agent. Always answers a tool result: the
   * client's, or one sentence saying why there is none.
   */
  function call(input: {
    caller: ClientToolCaller
    toolset: string
    tool: string
    args: Record<string, unknown>
    signal?: AbortSignal
    onProgress?: Call['onProgress']
  }): Promise<ClientToolCallOutcome> {
    const { caller, toolset, tool } = input
    const wireName = studioToolWireName(toolset, tool)
    if (closed) return Promise.resolve({ result: failure('client_unavailable', 'Studio is shutting down.') })
    if (!reaches(toolset, caller)) {
      const title = definitions.get(toolset)?.title ?? options.store.binding(toolset)?.title ?? toolset
      return Promise.resolve({
        result: failure(
          'client_unavailable',
          `${title} has not been opened to this conversation, so ${wireName} cannot be used here.`,
        ),
      })
    }
    const routed = route(caller, toolset, tool)
    if (!routed) return Promise.resolve({ result: unavailable(toolset, tool) })
    const { instance } = routed
    const definition = instance.offers.get(toolset)!
    const spec = definition.tools.get(tool)!
    let running = 0
    for (const other of calls.values()) if (other.caller.gatewayConnectionId === caller.gatewayConnectionId) running++
    if (running >= STUDIO_TOOL_LIMITS.callsInFlightPerAgent) return Promise.resolve(busy(instance.clientName))
    if (sentCount(instance) >= STUDIO_TOOL_LIMITS.callsInFlightPerConnection)
      return Promise.resolve(busy(instance.clientName))
    if (!instance.owner && !takeToken(instance.clientId)) return Promise.resolve(busy(instance.clientName))
    const timeoutMs = spec.timeoutMs ?? STUDIO_TOOL_LIMITS.defaultTimeoutMs
    return new Promise<ClientToolCallOutcome>((resolve) => {
      const id = `${callPrefix}-${++sequence}`
      const entry: Call = {
        id,
        toolset,
        tool,
        wireName,
        input: input.args,
        caller,
        mutates: definition.builtIn ? spec.mutates === true : spec.mutates !== false,
        timeoutMs,
        instance,
        state: 'waiting',
        sentTo: new Set(),
        rerouted: false,
        ...(routed.notice ? { notice: routed.notice } : {}),
        deadline: setTimeout(() => {
          const current = calls.get(id)
          if (!current) return
          cancel(
            current,
            'timeout',
            failure(
              'timeout',
              `${current.instance.clientName} did not answer ${wireName} within ${Math.round(timeoutMs / 1000)} s.`,
            ),
          )
        }, timeoutMs + STUDIO_TOOL_LIMITS.timeoutSlackMs),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
        settle: resolve,
      }
      entry.deadline.unref?.()
      calls.set(id, entry)
      if (input.signal) {
        const abort = () => {
          const current = calls.get(id)
          if (current) cancel(current, 'interrupted', failure('cancelled', 'Cancelled.'))
        }
        if (input.signal.aborted) {
          abort()
          return
        }
        input.signal.addEventListener('abort', abort, { once: true })
      }
      send(entry)
    })
  }

  /** A client's answer. One for a call already answered, or not this connection's, is dropped and logged. */
  function reply(connectionId: string, frame: StudioReplyFrame): void {
    const instance = connectionOf(connectionId)
    const call = calls.get(frame.id)
    if (!call || !instance || call.instance !== instance) {
      options.log?.(
        `A reply to client tool call ${frame.id.slice(0, 64)} arrived after it was answered, or from another client; dropped.`,
      )
      return
    }
    if (!frame.ok) {
      finish(call, failure(frame.error.code, frame.error.message))
      return
    }
    if (studioUtf8Length(JSON.stringify(frame)) > STUDIO_MAX_TOOL_RESULT_BYTES) {
      finish(call, failure('too_large', `${call.wireName}'s answer was too large to return.`))
      return
    }
    finish(call, frame.result)
  }

  function progress(connectionId: string, frame: StudioProgressFrame): void {
    const instance = connectionOf(connectionId)
    const call = calls.get(frame.id)
    if (!call || !instance || call.instance !== instance) return
    const { t: _t, id: _id, ...update } = frame
    try {
      call.onProgress?.(update)
    } catch {
      // A listener's failure is its own.
    }
  }

  /** The turn was interrupted: every call it was waiting on is answered `cancelled`. */
  function cancelCallsFor(conversation: ConversationRef): number {
    let count = 0
    for (const entry of [...calls.values()])
      if (
        entry.caller.conversation?.workspaceId === conversation.workspaceId &&
        entry.caller.conversation.agentId === conversation.agentId
      ) {
        cancel(entry, 'interrupted', failure('cancelled', 'Cancelled.'))
        count++
      }
    return count
  }

  /** An agent's gateway connection closed: its calls are cancelled and its own affinities forgotten. */
  function gatewayConnectionClosed(gatewayConnectionId: string): void {
    for (const entry of [...calls.values()])
      if (entry.caller.gatewayConnectionId === gatewayConnectionId)
        cancel(entry, 'agent_gone', failure('cancelled', 'Cancelled.'))
    const prefix = `g\u0000${gatewayConnectionId}\u0000`
    for (const key of [...affinities.keys()]) if (key.startsWith(prefix)) affinities.delete(key)
  }

  /** A conversation this client process started: routing prefers it for that conversation. */
  function noteStarted(connectionId: string, conversation: ConversationRef): void {
    const instance = connectionOf(connectionId)
    if (!instance) return
    startedInstances.set(conversationKey(conversation), instance.key)
    while (startedInstances.size > 4096) startedInstances.delete(startedInstances.keys().next().value!)
  }

  /** Open one conversation to one app toolset, or close it. Answers the toolsets it is open to. */
  function grant(
    conversation: ConversationRef,
    toolset: string,
    granted: boolean,
  ): { ok: true; grants: string[] } | { ok: false; code: string; message: string } {
    const binding = options.store.binding(toolset)
    if (!binding || isStudioBuiltInToolset(toolset))
      return { ok: false, code: 'not_offered', message: `No app gives agents "${toolset}" tools.` }
    try {
      options.store.setGranted(toolset, conversation, granted)
    } catch (error) {
      options.log?.(`A toolset grant could not be saved: ${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, code: 'unavailable', message: 'Studio could not record that.' }
    }
    changed()
    return { ok: true, grants: options.store.grantsOf(conversation) }
  }

  /**
   * A pairing was revoked: its names are released, the person's grants to
   * them go, and its instances with everything they held. Answers the names
   * it held, so the approval rules naming them can go too.
   */
  function forgetClient(clientId: string): string[] {
    for (const instance of [...instances.values()]) {
      if (instance.clientId !== clientId) continue
      if (instance.graceTimer) clearTimeout(instance.graceTimer)
      if (instance.staleTimer) clearTimeout(instance.staleTimer)
      instances.delete(instance.key)
      if (instance.connection) byConnection.delete(instance.connection.connectionId)
      for (const entry of [...calls.values()])
        if (entry.instance === instance)
          finish(entry, failure('client_unavailable', `${instance.clientName} is no longer paired with Studio.`))
    }
    let names: string[] = []
    try {
      names = options.store.forgetClient(clientId)
    } catch (error) {
      options.log?.(
        `A revoked app's toolset names could not be released: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const name of names) {
      definitions.delete(name)
      lastGone.delete(name)
    }
    buckets.delete(clientId)
    changed()
    return names
  }

  /** Settles once every named toolset has an offer from a connected client, or the wait runs out. */
  function whenOffered(toolsets: readonly string[], timeoutMs: number): Promise<boolean> {
    const ready = () => toolsets.every((name) => offering(name, false).length > 0)
    if (ready()) return Promise.resolve(true)
    return new Promise((resolve) => {
      const started = now()
      const poll = setInterval(() => {
        if (ready() || closed || now() - started >= timeoutMs) {
          clearInterval(poll)
          resolve(ready())
        }
      }, 25)
      poll.unref?.()
    })
  }

  function close(): void {
    if (closed) return
    closed = true
    for (const entry of [...calls.values()])
      cancel(entry, 'shutting_down', failure('client_unavailable', 'Studio is shutting down.'))
    for (const instance of instances.values()) {
      if (instance.graceTimer) clearTimeout(instance.graceTimer)
      if (instance.staleTimer) clearTimeout(instance.staleTimer)
    }
    instances.clear()
    byConnection.clear()
  }

  return {
    attach,
    detach,
    offer,
    withdraw,
    focus,
    reply,
    progress,
    call,
    cancelCallsFor,
    gatewayConnectionClosed,
    noteStarted,
    grant,
    grantsOf: (conversation: ConversationRef) => options.store.grantsOf(conversation),
    forgetClient,
    visibleTools,
    definitionOf,
    isKnownToolset,
    reaches,
    catalog,
    whenOffered,
    close,
    /** The instance a connection belongs to, for the RPC's own bookkeeping. */
    instanceOf: (connectionId: string): ClientToolInstanceInfo | null => {
      const instance = connectionOf(connectionId)
      return instance
        ? {
            clientId: instance.clientId,
            clientName: instance.clientName,
            kind: instance.kind,
            instanceId: instance.instanceId,
          }
        : null
    },
    /**
     * Whether a connection's process may be answering calls: it offers a
     * toolset, or a call was sent to it. A reply from any other is out of place.
     */
    mayAnswer: (connectionId: string): boolean => {
      const instance = connectionOf(connectionId)
      if (!instance) return false
      if (instance.offers.size > 0) return true
      for (const entry of calls.values()) if (entry.instance === instance) return true
      return false
    },
    /** How many calls are waiting on clients, for tests and diagnostics. */
    pendingCalls: () => calls.size,
    /**
     * The toolsets one paired client's name is bound to, and how each stands
     * now: offered by a connected process, waiting out a reconnect, or not offered.
     */
    toolsetsOf(clientId: string): Array<{
      name: string
      title: string
      tools: number
      state: 'offered' | 'reconnecting' | 'not_offered'
    }> {
      return options.store
        .bindings()
        .filter((binding) => binding.clientId === clientId)
        .map((binding) => {
          const holders = offering(binding.toolset)
          const definition = definitions.get(binding.toolset)
          return {
            name: binding.toolset,
            title: definition?.title ?? binding.title,
            tools: definition?.tools.size ?? 0,
            state:
              holders.length === 0
                ? ('not_offered' as const)
                : holders.some((instance) => instance.connection !== null)
                  ? ('offered' as const)
                  : ('reconnecting' as const),
          }
        })
    },
    /** Something the registry reads changed outside it (an app's reach): every catalog looks again. */
    refresh(): void {
      changed()
    },
    /** Hear every change to what is offered, granted or gone. Returns the unsubscriber. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
