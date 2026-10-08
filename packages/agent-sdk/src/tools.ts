import { StudioError } from './errors.js'
import {
  STUDIO_CLIENT_TOOLS_CAPABILITY,
  STUDIO_MAX_TOOL_RESULT_BYTES,
  parseStudioToolResult,
  parseStudioToolsetOffer,
  studioUtf8Length,
  type StudioCallFrame,
  type StudioCancelFrame,
  type StudioToolCallContext,
  type StudioToolReach,
  type StudioToolResult,
  type StudioToolsetListing,
  type StudioToolsetOffer,
} from './protocol.js'
import type { ConversationRef } from './conversations.js'

// Client tools: give Studio's agents tools that run in this program.
//
// A toolset is offered once and kept: the client offers it again on every new
// connection, before anything else resumes, so an agent's calls find it after
// a dropped connection or a Studio restart. A call Studio sends is answered
// with what its handler returns; one Studio sends again after a reconnect
// (the same id, marked a redelivery) joins the handler still running or is
// answered from the reply it already gave, so a handler never runs twice for
// one call within one process. That memory lasts ten minutes per call.
//
// Nothing here imports Node: it runs wherever the client does.

/** The MCP tool result an agent receives. */
export type McpToolResult = StudioToolResult

/** A string is one text part; `toolResult` builds the rest; an MCP result passes as is. */
export type ToolAnswer = string | McpToolResult

export type ToolCall = {
  id: string
  toolset: string
  tool: string
  /** The calling chat, when the agent is one Studio launched. */
  conversation: ConversationRef | null
  agent: { name?: string; cli?: string }
  /** Who is calling, as Studio tells it: the agent's connection and its conversation. */
  context: StudioToolCallContext
  /** Aborted when Studio cancels the call: the turn was interrupted, the deadline passed, the agent left. */
  signal: AbortSignal
  /** True when this id reached an earlier connection of this process first. */
  redelivered: boolean
  /** Tell the agent how far the call has got. Sent only to a Studio that serves client tools. */
  progress(update: { progress?: number; total?: number; message?: string }): void
}

export type ToolHandler<I = Record<string, unknown>> = (input: I, call: ToolCall) => Promise<ToolAnswer> | ToolAnswer

export type ToolDefinition<I = Record<string, unknown>> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Whether a call changes anything. Defaults to true: only an explicit false makes a tool a read. */
  mutates?: boolean
  /** How long Studio waits for an answer: 1,000 to 600,000 ms, 60,000 when absent. */
  timeoutMs?: number
  handler: ToolHandler<I>
}

export type OfferedToolset = {
  readonly name: string
  readonly wireNames: readonly string[]
  /** `offered` while Studio holds it; `pending` while reconnecting; `withdrawn` once taken back. */
  readonly state: 'offered' | 'pending' | 'withdrawn'
  withdraw(): Promise<void>
}

export type ToolsetInput = {
  name: string
  title?: string
  description?: string
  /** Owners only: which agents may see it. An app's reach is its pairing's. */
  reach?: StudioToolReach
  // A handler's input type is its own business; the list holds any of them.
  tools: ToolDefinition<any>[]
}

export type StudioClientTools = {
  offer(toolset: ToolsetInput): Promise<OfferedToolset>
  /** Tell Studio which workspaces this client is showing, and whether the person is looking at it. A routing hint. */
  focus(hint: { focused: boolean; workspaceIds: string[]; activeWorkspaceId?: string }): void
  catalog(): Promise<StudioToolsetListing[]>
}

/** Thrown from a handler, it answers the agent with a tool error it should read: `no_tab`, `not_found`, … */
export class StudioToolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'StudioToolError'
    this.code = code
  }
}

function base64(bytes: Uint8Array): string {
  const buffer = (globalThis as { Buffer?: { from(data: Uint8Array): { toString(encoding: 'base64'): string } } })
    .Buffer
  if (buffer) return buffer.from(bytes).toString('base64')
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export const toolResult = {
  text(text: string, structured?: Record<string, unknown>): McpToolResult {
    return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) }
  },
  image(
    bytes: Uint8Array,
    mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
    caption?: string,
  ): McpToolResult {
    return {
      content: [
        ...(caption ? [{ type: 'text' as const, text: caption }] : []),
        { type: 'image', data: base64(bytes), mimeType },
      ],
    }
  },
  /** A failure the agent reads, in the shape every Studio tool answers one. */
  error(code: string, message: string): McpToolResult {
    return {
      content: [{ type: 'text', text: `${code}: ${message}` }],
      structuredContent: { ok: false, error: { code, message } },
      isError: true,
    }
  },
}

const MEMORY_MS = 10 * 60 * 1000
const MAX_MEMORY = 2048
/**
 * The most the stored replies may hold between them. A redelivery comes within
 * Studio's reconnect grace, so the newest replies are the ones worth keeping;
 * past this, the oldest finished ones go first, and a call still running is
 * never forgotten.
 */
const MAX_MEMORY_BYTES = 32 * 1024 * 1024

type Live = {
  input: ToolsetInput
  offer: StudioToolsetOffer
  handle: { name: string; wireNames: string[]; state: OfferedToolset['state'] }
}

type Remembered = {
  running: Promise<unknown> | null
  reply: Record<string, unknown> | null
  /** The encoded reply's size, counted against the memory's budget. */
  bytes: number
  controller: AbortController
  at: number
}

/** The client's side of client tools: what it offers, and the calls Studio sends it. */
export function createClientTools(deps: {
  request(method: 'tools.offer' | 'tools.withdraw' | 'tools.focus' | 'tools.catalog', params: unknown): Promise<unknown>
  /** Send a frame now; false when there is no open connection to send it on. */
  send(frame: Record<string, unknown>): boolean
  supports(capability: typeof STUDIO_CLIENT_TOOLS_CAPABILITY): boolean
  isOpen(): boolean
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const live = new Map<string, Live>()
  const memory = new Map<string, Remembered>()
  let lastFocus: Record<string, unknown> | null = null

  let memoryBytes = 0
  function forget(id: string, entry: Remembered): void {
    memory.delete(id)
    memoryBytes -= entry.bytes
  }
  function prune(): void {
    const at = now()
    for (const [id, entry] of memory) if (!entry.running && at - entry.at > MEMORY_MS) forget(id, entry)
    // Oldest finished first; a running call is never forgotten, or its
    // redelivery would run the handler again.
    for (const [id, entry] of memory) {
      if (memory.size <= MAX_MEMORY && memoryBytes <= MAX_MEMORY_BYTES) break
      if (!entry.running) forget(id, entry)
    }
  }

  async function sendOffer(entry: Live): Promise<void> {
    const answer = (await deps.request('tools.offer', {
      toolset: entry.offer,
      ...(entry.input.reach ? { reach: entry.input.reach } : {}),
    })) as { wireNames: string[] }
    if (live.get(entry.offer.name) !== entry) return
    entry.handle.wireNames = answer.wireNames
    entry.handle.state = 'offered'
  }

  const api: StudioClientTools = {
    async offer(input) {
      const { tools, reach: _reach, ...rest } = input
      const parsed = parseStudioToolsetOffer({
        ...rest,
        tools: tools.map(({ handler: _handler, ...spec }) => spec),
      })
      // A bad schema fails here, in the app, with a message, not as a refusal from Studio.
      if (!parsed.ok) throw new StudioError(parsed.code, parsed.message)
      if (!deps.supports(STUDIO_CLIENT_TOOLS_CAPABILITY))
        throw new StudioError('unsupported', 'This Studio does not take tools from its clients.')
      for (const tool of tools)
        if (typeof tool.handler !== 'function')
          throw new StudioError('invalid_params', `"${tool.name}" has no handler.`)
      const previous = live.get(parsed.offer.name)
      const entry: Live = {
        input,
        offer: parsed.offer,
        handle: previous?.handle ?? { name: parsed.offer.name, wireNames: [], state: 'pending' },
      }
      live.set(parsed.offer.name, entry)
      try {
        await sendOffer(entry)
      } catch (error) {
        if (live.get(parsed.offer.name) === entry) {
          if (previous) live.set(parsed.offer.name, previous)
          else live.delete(parsed.offer.name)
        }
        throw error
      }
      const handle = entry.handle
      return {
        get name() {
          return handle.name
        },
        get wireNames() {
          return [...handle.wireNames]
        },
        get state() {
          return handle.state
        },
        async withdraw() {
          const current = live.get(handle.name)
          if (!current || current.handle !== handle) return
          live.delete(handle.name)
          handle.state = 'withdrawn'
          await deps.request('tools.withdraw', { toolset: handle.name }).catch((error: unknown) => {
            // Withdrawn already, or never offered on this connection: nothing to take back.
            if (error instanceof StudioError && error.code === 'not_offered') return
            throw error
          })
        },
      }
    },
    focus(hint) {
      lastFocus = {
        focused: hint.focused,
        workspaceIds: [...hint.workspaceIds],
        ...(hint.activeWorkspaceId ? { activeWorkspaceId: hint.activeWorkspaceId } : {}),
      }
      if (!deps.supports(STUDIO_CLIENT_TOOLS_CAPABILITY)) return
      void deps.request('tools.focus', lastFocus).catch(() => undefined)
    },
    async catalog() {
      return ((await deps.request('tools.catalog', {})) as { toolsets: StudioToolsetListing[] }).toolsets
    },
  }

  function normalise(answer: ToolAnswer): McpToolResult {
    return typeof answer === 'string' ? toolResult.text(answer) : answer
  }

  function reply(id: string, body: Record<string, unknown>): void {
    const frame = { t: 'reply', id, ...body }
    const remembered = memory.get(id)
    if (remembered) {
      remembered.reply = frame
      remembered.running = null
      remembered.at = now()
      remembered.bytes = studioUtf8Length(JSON.stringify(frame))
      memoryBytes += remembered.bytes
      // Moved to the end: the oldest finished call is the first to go.
      memory.delete(id)
      memory.set(id, remembered)
      prune()
    }
    // A call Studio cancelled is no longer waited on there, and after a
    // reconnect a reply to it reads as a frame for a call it never made, which
    // ends the connection for good. Its handler ran on; its answer stays here.
    if (remembered?.controller.signal.aborted) return
    if (deps.isOpen()) deps.send(frame)
  }

  async function run(frame: StudioCallFrame, remembered: Remembered): Promise<void> {
    const entry = live.get(frame.toolset)
    const definition = entry?.input.tools.find((tool) => tool.name === frame.tool)
    if (!definition) {
      reply(frame.id, {
        ok: false,
        error: { code: 'unknown_tool', message: `This client does not offer ${frame.toolset}.${frame.tool}.` },
      })
      return
    }
    const conversation = frame.context.conversation ?? null
    const call: ToolCall = {
      id: frame.id,
      toolset: frame.toolset,
      tool: frame.tool,
      conversation: conversation ? { workspaceId: conversation.workspaceId, agentId: conversation.agentId } : null,
      agent: {
        ...(frame.context.connection.agentName ? { name: frame.context.connection.agentName } : {}),
        ...(frame.context.connection.cliId ? { cli: frame.context.connection.cliId } : {}),
      },
      context: frame.context,
      signal: remembered.controller.signal,
      redelivered: frame.redelivery === true,
      progress(update) {
        if (remembered.controller.signal.aborted || !deps.supports(STUDIO_CLIENT_TOOLS_CAPABILITY)) return
        deps.send({ t: 'progress', id: frame.id, ...update })
      },
    }
    let body: Record<string, unknown>
    try {
      // A handler is untyped at run time: what Studio could not read would be
      // dropped there and the agent left to the call's deadline, so it fails here.
      const result = parseStudioToolResult(normalise(await definition.handler(frame.input, call)))
      body = result
        ? { ok: true, result }
        : {
            ok: false,
            error: {
              code: 'invalid_result',
              message: `${frame.toolset}.${frame.tool} returned something that is not a tool result: return a string, or { content } of text and image parts.`,
            },
          }
    } catch (error) {
      body =
        error instanceof StudioToolError
          ? { ok: true, result: toolResult.error(error.code, error.message) }
          : {
              ok: false,
              error: {
                code: 'tool_failed',
                message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || 'The tool failed.',
              },
            }
    }
    // Over the limit fails here, where the handler's author can see it.
    if (studioUtf8Length(JSON.stringify({ t: 'reply', id: frame.id, ...body })) > STUDIO_MAX_TOOL_RESULT_BYTES)
      body = {
        ok: false,
        error: {
          code: 'too_large',
          message: `${frame.toolset}.${frame.tool}'s answer is over ${STUDIO_MAX_TOOL_RESULT_BYTES / 1024} KiB. Return a reference and a summary instead.`,
        },
      }
    reply(frame.id, body)
  }

  return {
    api,
    /** A call from Studio. One this process has seen joins its handler, or is answered from its reply. */
    handleCall(frame: StudioCallFrame): void {
      prune()
      const known = memory.get(frame.id)
      if (known) {
        if (known.reply && deps.isOpen()) deps.send(known.reply)
        return
      }
      const remembered: Remembered = {
        running: null,
        reply: null,
        bytes: 0,
        controller: new AbortController(),
        at: now(),
      }
      memory.set(frame.id, remembered)
      const running = run(frame, remembered).catch(() => undefined)
      // A call answered before its handler could start (an unknown tool) is finished already.
      if (!remembered.reply) remembered.running = running
    },
    /** Studio stopped waiting for a call: its handler's signal is aborted. Its reply, if any, is dropped there. */
    handleCancel(frame: StudioCancelFrame): void {
      memory.get(frame.id)?.controller.abort(new StudioError('cancelled', `Cancelled: ${frame.reason}.`))
    },
    /** A new connection: every live toolset is offered again, ahead of anything else, then the last focus hint. */
    reoffer(): void {
      if (!live.size && !lastFocus) return
      for (const entry of live.values()) {
        entry.handle.state = 'pending'
        void sendOffer(entry).catch(() => undefined)
      }
      if (lastFocus && deps.supports(STUDIO_CLIENT_TOOLS_CAPABILITY))
        void deps.request('tools.focus', lastFocus).catch(() => undefined)
    },
    /** The connection dropped: what is offered waits to be offered again. */
    dropped(): void {
      for (const entry of live.values()) entry.handle.state = 'pending'
    },
    /** The client closed for good: every running handler is told. */
    close(): void {
      for (const entry of memory.values()) entry.controller.abort(new StudioError('closed', 'The client is closed.'))
      for (const entry of live.values()) entry.handle.state = 'withdrawn'
      live.clear()
    },
  }
}
