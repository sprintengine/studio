import { AsyncLocalStorage } from 'node:async_hooks'

import {
  STUDIO_BUILT_IN_TOOLSETS,
  STUDIO_TOOL_LIMITS,
  STUDIO_TOOLSET_NAME_PATTERN,
  STUDIO_TOOL_NAME_PATTERN,
} from '../../../packages/studio-protocol/src/public'
import type { McpConnectionContext, McpToolRegistration, McpToolResult } from '../../shared/modules/mcp-tools'
import type {
  ClientToolCaller,
  ClientToolDefinition,
  ClientToolRegistry,
  ClientToolServedBy,
} from './client-tool-registry'
import type { ConversationRef } from './client-toolset-store'

// Client tools as the MCP gateway lists them: one catalog per agent
// connection, which only grows.
//
// Some agent runtimes act on `notifications/tools/list_changed` and some
// ignore it, so nothing is ever taken off a connection's list. A connection's
// first `tools/list` fills its catalog with every client tool it may see; a
// toolset offered later joins it and the connection is told, at most once
// every two seconds; a tool whose client has gone or withdrew it stays listed
// and answers one sentence saying so, until a client offers it again. A
// connection that cannot see a toolset is never told about it.
//
// A connection that ends drops its catalog. A bridge that reconnects across a
// server restart is a new connection while the agent still holds its old
// list, so a call to a name the new catalog lacks, whose toolset is built in
// or bound to a pairing, is answered as a client that is not there, not as an
// unknown tool, and the tool joins the catalog once its toolset is offered.

/** What an agent connection is beside its metadata: who it is to the registry, and the conversation it proved. */
type ConnectionIdentity = {
  id: string
  /** The conversation its launch token is bound to (R87). */
  conversation?: ConversationRef
}

// Per connection object, for as long as the transport holds it: a connection
// is a context, and the context is the transport's for its whole life.
const identities = new WeakMap<McpConnectionContext, ConnectionIdentity>()
let connectionSequence = 0

function identityOf(context: McpConnectionContext): ConnectionIdentity {
  let identity = identities.get(context)
  if (!identity) {
    identity = { id: `mcp-${++connectionSequence}` }
    identities.set(context, identity)
  }
  return identity
}

/**
 * Bind a gateway connection to the conversation its launch token names. Only
 * the gateway's own token check calls this: a conversation is what Studio
 * proved, never what the connection said.
 */
export function bindGatewayConversation(context: McpConnectionContext, conversation: ConversationRef | null): void {
  const identity = identityOf(context)
  if (conversation) identity.conversation = { workspaceId: conversation.workspaceId, agentId: conversation.agentId }
  else delete identity.conversation
}

/** The conversation a gateway connection's launch token proved, if any. */
export function gatewayConversation(context: McpConnectionContext | undefined): ConversationRef | undefined {
  return context ? identities.get(context)?.conversation : undefined
}

/** One gateway's view of a connection: its catalog and when it was last told the list grew. */
type ConnectionState = {
  catalog: Map<string, ClientToolDefinition> | null
  notify: (() => void) | null
  lastNotified: number
  pendingNotify: ReturnType<typeof setTimeout> | null
}

/** What the dispatcher hands a tool call while it runs: how to stop it, and where its progress goes. */
export type GatewayCallScope = {
  signal?: AbortSignal
  progress?: (update: { progress?: number; total?: number; message?: string }) => void
  /** Set by a client tool: which client answered, for the audit. */
  servedBy?: ClientToolServedBy
}

const callScope = new AsyncLocalStorage<GatewayCallScope>()

/** Run a tool handler with what its call carries. */
export function runGatewayCall<T>(scope: GatewayCallScope, handler: () => T): T {
  return callScope.run(scope, handler)
}

/** The shell toolsets a first `tools/list` waits for: fixed, or read when that list comes. */
export type ExpectedShellToolsets = readonly string[] | (() => readonly string[])

export function createClientToolGateway(options: {
  registry: ClientToolRegistry
  /**
   * The shell's toolsets this server waits for at start: the desktop's own
   * server lists the browser and the canvas from an agent's very first
   * `tools/list`. A server with no shell of its own names none and never waits.
   * As a function it is asked when the first list comes, not at start: the
   * person can switch a toolset off (the agents' browser) in between, and a
   * wait for a toolset that is not coming is five seconds of nothing.
   */
  expectShellToolsets?: ExpectedShellToolsets
  /** How long a first `tools/list` waits for them. */
  bootWaitMs?: number
  now?: () => number
}) {
  const { registry } = options
  const now = options.now ?? Date.now
  const tracked = new Set<McpConnectionContext>()
  const states = new WeakMap<McpConnectionContext, ConnectionState>()
  function stateOf(context: McpConnectionContext): ConnectionState {
    let state = states.get(context)
    if (!state) {
      state = { catalog: null, notify: null, lastNotified: 0, pendingNotify: null }
      states.set(context, state)
    }
    return state
  }
  // Waits only until the shell's toolsets first arrive, or the wait runs out
  // once: after that a missing toolset is a missing client, not a slow start.
  let booted: Promise<void> | null = null
  const expected = (): readonly string[] => {
    const toolsets = options.expectShellToolsets
    return typeof toolsets === 'function' ? toolsets() : (toolsets ?? [])
  }

  function callerOf(context: McpConnectionContext): ClientToolCaller {
    const identity = identityOf(context)
    return {
      gatewayConnectionId: identity.id,
      metadata: context.metadata,
      ...(identity.conversation ? { conversation: identity.conversation } : {}),
    }
  }

  function registration(definition: ClientToolDefinition): McpToolRegistration {
    const description = definition.builtIn
      ? definition.tool.description
      : [`[From ${definition.title}, an app connected to Studio.]`, definition.description, definition.tool.description]
          .filter(Boolean)
          .join(' ')
    return {
      name: definition.wireName,
      description,
      inputSchema: definition.tool.inputSchema,
      mutates: definition.mutates,
      handler: (args, context) => callTool(definition.toolset, definition.tool.name, args, context),
    }
  }

  async function callTool(
    toolset: string,
    tool: string,
    args: Record<string, unknown>,
    context: McpConnectionContext | undefined,
  ): Promise<McpToolResult> {
    const scope = callScope.getStore()
    const outcome = await registry.call({
      caller: context
        ? callerOf(context)
        : { gatewayConnectionId: 'mcp-unknown', metadata: { kind: 'external-local' } },
      toolset,
      tool,
      args,
      ...(scope?.signal ? { signal: scope.signal } : {}),
      ...(scope?.progress ? { onProgress: scope.progress } : {}),
    })
    if (scope && outcome.servedBy) scope.servedBy = outcome.servedBy
    return outcome.result
  }

  /** Fill or grow a connection's catalog; answers whether anything it lists was added or changed. */
  function grow(context: McpConnectionContext, state: ConnectionState): boolean {
    const catalog = (state.catalog ??= new Map())
    let grew = false
    for (const definition of registry.visibleTools(callerOf(context))) {
      const known = catalog.get(definition.wireName)
      if (known && sameDefinition(known, definition)) continue
      catalog.set(definition.wireName, definition)
      grew = true
    }
    return grew
  }

  function listed(context: McpConnectionContext | undefined): ClientToolDefinition[] {
    if (!context) return []
    const state = stateOf(context)
    grow(context, state)
    // A definition offered since is the newest; one whose client is gone is
    // kept as it was last offered.
    return [...state.catalog!.values()].map(
      (definition) => registry.definitionOf(definition.toolset, definition.tool.name) ?? definition,
    )
  }

  const builtInRank = (toolset: string) => {
    const index = (STUDIO_BUILT_IN_TOOLSETS as readonly string[]).indexOf(toolset)
    return index === -1 ? STUDIO_BUILT_IN_TOOLSETS.length : index
  }

  function notifyLater(state: ConnectionState): void {
    if (!state.notify || state.pendingNotify) return
    const wait = state.lastNotified + STUDIO_TOOL_LIMITS.listChangedIntervalMs - now()
    const send = () => {
      state.pendingNotify = null
      state.lastNotified = now()
      state.notify?.()
    }
    if (wait <= 0) send()
    else {
      state.pendingNotify = setTimeout(send, wait)
      state.pendingNotify.unref?.()
    }
  }

  // Every change to what is offered or granted: each connection that has
  // listed and can now see something new is told, and only it.
  registry.subscribe(() => {
    for (const context of tracked) {
      const state = stateOf(context)
      if (state.catalog === null) continue
      if (grow(context, state)) notifyLater(state)
    }
  })

  return {
    /** The shell's toolsets for this connection, in the slots the browser and canvas tools always held. */
    builtIns(context?: McpConnectionContext): McpToolRegistration[] {
      return listed(context)
        .filter((definition) => definition.builtIn)
        .sort((a, b) => builtInRank(a.toolset) - builtInRank(b.toolset))
        .map(registration)
    },
    /** Apps' toolsets for this connection, after every tool of Studio's own, by name. */
    apps(context?: McpConnectionContext): McpToolRegistration[] {
      return listed(context)
        .filter((definition) => !definition.builtIn)
        .sort((a, b) => (a.toolset === b.toolset ? 0 : a.toolset < b.toolset ? -1 : 1))
        .map(registration)
    },
    /**
     * A call to a name this connection's catalog lacks, whose toolset a client
     * may answer for: answered by the registry (which says the client is not
     * there), and listed from now on.
     */
    fallback(context: McpConnectionContext, name: string): McpToolRegistration | null {
      const dot = name.indexOf('.')
      if (dot === -1) return null
      const toolset = name.slice(0, dot)
      const tool = name.slice(dot + 1)
      if (!STUDIO_TOOLSET_NAME_PATTERN.test(toolset) || !STUDIO_TOOL_NAME_PATTERN.test(tool)) return null
      if (!registry.isKnownToolset(toolset)) return null
      return {
        name,
        description: '',
        inputSchema: { type: 'object' },
        handler: (args, callContext) => callTool(toolset, tool, args, callContext ?? context),
      }
    },
    /** Waits, once, for the shell's toolsets before the first list. */
    ready(): Promise<void> {
      if (booted) return booted
      const toolsets = expected()
      booted = toolsets.length
        ? registry.whenOffered(toolsets, options.bootWaitMs ?? 5_000).then(() => undefined)
        : Promise.resolve()
      return booted
    },
    /** A connection that hears notifications: told when its list grows. Returns what to call when it ends. */
    track(context: McpConnectionContext, notify: () => void): () => void {
      const state = stateOf(context)
      state.notify = notify
      tracked.add(context)
      return () => {
        tracked.delete(context)
        if (state.pendingNotify) clearTimeout(state.pendingNotify)
        state.pendingNotify = null
        state.notify = null
        state.catalog = null
        registry.gatewayConnectionClosed(identityOf(context).id)
      }
    },
  }
}

function sameDefinition(a: ClientToolDefinition, b: ClientToolDefinition): boolean {
  return (
    a.title === b.title &&
    a.description === b.description &&
    a.mutates === b.mutates &&
    JSON.stringify(a.tool) === JSON.stringify(b.tool)
  )
}
