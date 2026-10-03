import type { Duplex } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

import { connect, type StudioClient } from '../../../packages/agent-sdk/src/client'
import type { OfferedToolset, ToolDefinition } from '../../../packages/agent-sdk/src/tools'
import type { StudioTransport } from '../../../packages/agent-sdk/src/transport'
import type { ClientToolRegistry } from '../tools/client-tool-registry'
import type { WslServerConnection } from './wsl-environment-manager'

// The desktop's toolsets, for a chat agent in WSL (phase 7 spec, 3.7). An
// agent there reaches its own server's gateway, which serves the core's tools
// but has no browser, canvas, editor, tour, terminals or agent launches: those
// are the desktop shell's, offered to the Windows-side server as its client
// toolsets. So the front door is a client of each WSL server too, with the
// shell role, and offers it the same toolsets; each call it is sent is run
// through the Windows side's own registry, which hands it to the shell, and
// the answer goes back the same way. An agent in WSL lists the tools an agent
// on Windows does.
//
// The offers follow the Windows side's: a toolset the shell offers later is
// offered on, one it withdraws is withdrawn. Tool inputs cross as the agent
// wrote them; a Linux path in one is the agent's own.

/** The toolsets the desktop's shell offers (decision R78), the ones relayed. */
export const RELAYED_TOOLSETS = ['browser', 'canvas', 'editor', 'tour', 'terminal', 'agent'] as const

export type WslToolRelay = { close(): void }

/** A Studio protocol transport over an admitted stream: one frame per line, saying hello with `ticket`. */
export function lineTransport(stream: Duplex, ticket: string): StudioTransport {
  const decoder = new StringDecoder('utf8')
  const messageListeners: Array<(frame: string) => void> = []
  const closeListeners: Array<(error?: Error) => void> = []
  let buffer = ''
  let failure: Error | undefined
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim()) for (const listener of messageListeners) listener(line)
      newline = buffer.indexOf('\n')
    }
  })
  stream.on('error', (error: Error) => {
    failure = error
  })
  stream.once('close', () => {
    for (const listener of closeListeners) listener(failure)
  })
  return {
    credential: { token: ticket },
    send: (frame) => void stream.write(`${frame}\n`),
    close: () => {
      stream.end()
      stream.destroy()
    },
    onMessage: (listener) => void messageListeners.push(listener),
    onClose: (listener) => void closeListeners.push(listener),
    pause: () => void stream.pause(),
    resume: () => void stream.resume(),
  }
}

/** The ticket line a `studio` door says first, then the stream for the protocol. */
export function readTicket(stream: Duplex, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const done = (error: Error | null, ticket?: string) => {
      clearTimeout(timer)
      stream.off('readable', onReadable)
      stream.off('close', onClose)
      if (error) reject(error)
      else resolve(ticket!)
    }
    const onClose = () => done(new Error('The Studio server closed the connection before it gave a ticket.'))
    const onReadable = () => {
      let chunk: Buffer | null
      while ((chunk = stream.read() as Buffer | null) !== null) {
        buffer = Buffer.concat([buffer, chunk])
        const newline = buffer.indexOf(0x0a)
        if (newline === -1) continue
        const rest = buffer.subarray(newline + 1)
        if (rest.length > 0) stream.unshift(rest)
        try {
          const line = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as { t?: unknown; ticket?: unknown }
          if (line.t !== 'ticket' || typeof line.ticket !== 'string') throw new Error('no ticket')
          done(null, line.ticket)
        } catch {
          done(new Error('The Studio server did not give a ticket.'))
        }
        return
      }
    }
    const timer = setTimeout(() => done(new Error('The Studio server gave no ticket in time.')), timeoutMs)
    timer.unref?.()
    stream.on('readable', onReadable)
    stream.once('close', onClose)
  })
}

/**
 * Offer the desktop's toolsets to every WSL server the Windows side connects
 * to, and keep the offers in step with the shell's.
 */
export function relayShellToolsets(input: {
  onConnected(listener: (connection: WslServerConnection) => void): void
  registry: ClientToolRegistry
  log?: (message: string) => void
  /** Stands in for the SDK's `connect` in tests. */
  connectClient?: typeof connect
}): WslToolRelay {
  const log = input.log ?? (() => undefined)
  const open = new Map<string, { client: StudioClient; offered: Map<string, OfferedToolset>; stop(): void }>()
  let closed = false

  /** What the shell offers now, toolset by toolset, as the Windows registry describes it. */
  const shellToolsets = () => {
    const visible = input.registry.visibleTools({
      gatewayConnectionId: 'wsl-relay',
      metadata: { kind: 'studio-agent' },
    })
    const sets = new Map<string, { title: string; description?: string; tools: (typeof visible)[number]['tool'][] }>()
    for (const definition of visible) {
      if (!definition.builtIn || !(RELAYED_TOOLSETS as readonly string[]).includes(definition.toolset)) continue
      const entry = sets.get(definition.toolset) ?? {
        title: definition.title,
        ...(definition.description ? { description: definition.description } : {}),
        tools: [],
      }
      entry.tools.push(definition.tool)
      sets.set(definition.toolset, entry)
    }
    return sets
  }

  const relayTo =
    (distro: string, toolset: string, tool: { name: string }): ToolDefinition['handler'] =>
    async (args, call) => {
      const outcome = await input.registry.call({
        caller: {
          // One gateway connection per WSL agent connection, for the Windows
          // side's affinity and in-flight bounds.
          gatewayConnectionId: `wsl:${distro}:${call.context.connection.workspaceId ?? ''}:${call.context.connection.agentId ?? call.id}`,
          metadata: { ...call.context.connection, kind: call.context.connection.kind },
          ...(call.context.conversation ? { conversation: call.context.conversation } : {}),
        },
        toolset,
        tool: tool.name,
        args: args as Record<string, unknown>,
        signal: call.signal,
        onProgress: (progress) => call.progress(progress),
      })
      return outcome.result
    }

  async function sync(distro: string): Promise<void> {
    const entry = open.get(distro)
    if (!entry) return
    const wanted = shellToolsets()
    for (const [name, offered] of entry.offered) {
      if (wanted.has(name)) continue
      entry.offered.delete(name)
      await offered.withdraw().catch(() => undefined)
    }
    for (const [name, set] of wanted) {
      const current = entry.offered.get(name)
      const names = set.tools.map((tool) => tool.name).sort()
      if (current && current.wireNames.length === names.length) continue
      try {
        const offered = await entry.client.tools.offer({
          name,
          title: set.title,
          ...(set.description ? { description: set.description } : {}),
          tools: set.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            ...(tool.mutates !== undefined ? { mutates: tool.mutates } : {}),
            ...(tool.timeoutMs !== undefined ? { timeoutMs: tool.timeoutMs } : {}),
            handler: relayTo(distro, name, tool),
          })),
        })
        entry.offered.set(name, offered)
      } catch (error) {
        // A family the WSL server serves itself is refused, and stays its own.
        log(
          `The ${name} toolset was not offered to WSL: ${distro}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  input.onConnected((connection) => {
    if (closed) return
    open.get(connection.distro)?.stop()
    const doConnect = input.connectClient ?? connect
    void doConnect({
      transport: async () => {
        const stream = await connection.open('studio')
        const ticket = await readTicket(stream)
        return lineTransport(stream, ticket)
      },
      client: { name: 'SprintEngine Studio (Windows)', kind: 'desktop' },
      // A new server start reaches here as a new connection; this one ends with its server.
      reconnect: false,
    }).then(
      (client) => {
        if (closed || connection.backend.isOpen() === false) {
          client.close()
          return
        }
        const unsubscribe = input.registry.subscribe(() => void sync(connection.distro))
        open.set(connection.distro, {
          client,
          offered: new Map(),
          stop: () => {
            unsubscribe()
            client.close()
            open.delete(connection.distro)
          },
        })
        connection.backend.onClose(
          () => open.get(connection.distro)?.client === client && open.get(connection.distro)?.stop(),
        )
        void sync(connection.distro)
      },
      (error: unknown) =>
        log(
          `The desktop's tools could not be offered to WSL: ${connection.distro}: ${error instanceof Error ? error.message : String(error)}`,
        ),
    )
  })

  return {
    close() {
      closed = true
      for (const entry of [...open.values()]) entry.stop()
    },
  }
}
