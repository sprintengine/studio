import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { STUDIO_TOOLSET_NAME_PATTERN } from '../../../packages/studio-protocol/src/public'

// Which client each app toolset name belongs to, and which conversations the
// person opened to it. A name is bound to a pairing the first time that
// pairing offers it, and another app that offers the same name is refused, so
// an agent that learned `game.spawn_enemy` from one app is never handed
// another app's tool under that name. The binding lasts as long as the
// pairing: revoking the app deletes it, with every conversation grant, so a
// later app that takes the name inherits nothing.
//
// Owner connections share one client id and so one set of bindings, which is
// right: an owner is the person. Built-in toolsets are never bound; they are
// the shell's.
//
// One small JSON file beside the paired apps, written whole and renamed over
// (0600), read once at start.

export const CLIENT_TOOLSETS_FILENAME = 'client-toolsets.json'

const MAX_BINDINGS = 512
const MAX_GRANTS_PER_TOOLSET = 512

export type ConversationRef = { workspaceId: string; agentId: string }

export type ClientToolsetBinding = {
  toolset: string
  clientId: string
  /** The title the toolset was last offered under, for Settings and the origin labels. */
  title: string
  boundAt: string
  /** Conversations the person opened to this toolset (`tools.grant`). */
  conversations: ConversationRef[]
}

export type ClientToolsetStore = {
  binding(toolset: string): ClientToolsetBinding | null
  bindings(): ClientToolsetBinding[]
  /** Bind a name to a client, or refresh its title. Throws when the name is another client's. */
  bind(toolset: string, clientId: string, title: string): ClientToolsetBinding
  setGranted(toolset: string, conversation: ConversationRef, granted: boolean): void
  /** The toolsets one conversation was opened to. */
  grantsOf(conversation: ConversationRef): string[]
  /** Forget everything a client held. Answers the toolset names that were its. */
  forgetClient(clientId: string): string[]
}

const same = (a: ConversationRef, b: ConversationRef) => a.workspaceId === b.workspaceId && a.agentId === b.agentId

function read(path: string, log?: (message: string) => void): Map<string, ClientToolsetBinding> {
  const out = new Map<string, ClientToolsetBinding>()
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return out
  }
  try {
    const parsed = JSON.parse(raw) as { bindings?: unknown }
    if (!Array.isArray(parsed.bindings)) return out
    for (const entry of parsed.bindings as Array<Record<string, unknown>>) {
      if (
        typeof entry?.toolset !== 'string' ||
        !STUDIO_TOOLSET_NAME_PATTERN.test(entry.toolset) ||
        typeof entry.clientId !== 'string' ||
        !entry.clientId
      )
        continue
      const conversations = Array.isArray(entry.conversations)
        ? (entry.conversations as Array<Record<string, unknown>>)
            .filter((ref) => typeof ref?.workspaceId === 'string' && typeof ref.agentId === 'string')
            .map((ref) => ({ workspaceId: ref.workspaceId as string, agentId: ref.agentId as string }))
            .slice(0, MAX_GRANTS_PER_TOOLSET)
        : []
      out.set(entry.toolset, {
        toolset: entry.toolset,
        clientId: entry.clientId,
        title: typeof entry.title === 'string' ? entry.title.slice(0, 60) : entry.toolset,
        boundAt: typeof entry.boundAt === 'string' ? entry.boundAt : new Date(0).toISOString(),
        conversations,
      })
    }
  } catch (error) {
    // Unreadable: nothing is bound, so the first app to offer a name takes it.
    // That loses no authority an app had (a binding only ever refuses), and
    // the file is left for someone to look at.
    log?.(`Client toolset bindings could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  return out
}

export function createClientToolsetStore(options: {
  /** The data directory; absent, the bindings live in memory only (tests, a Studio with no disk of its own). */
  dataDir?: () => string
  now?: () => Date
  log?: (message: string) => void
}): ClientToolsetStore {
  const now = options.now ?? (() => new Date())
  const path = () => (options.dataDir ? join(options.dataDir(), CLIENT_TOOLSETS_FILENAME) : null)
  const initial = path()
  const bindings = initial ? read(initial, options.log) : new Map<string, ClientToolsetBinding>()

  function persist(): void {
    const target = path()
    if (!target) return
    const body = `${JSON.stringify({ version: 1, bindings: [...bindings.values()] }, null, 2)}\n`
    const staged = `${target}.${process.pid}.tmp`
    writeFileSync(staged, body, { mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(staged, 0o600)
    renameSync(staged, target)
  }

  const copy = (binding: ClientToolsetBinding): ClientToolsetBinding => ({
    ...binding,
    conversations: binding.conversations.map((ref) => ({ ...ref })),
  })

  return {
    binding: (toolset) => {
      const found = bindings.get(toolset)
      return found ? copy(found) : null
    },
    bindings: () => [...bindings.values()].map(copy),
    bind(toolset, clientId, title) {
      const existing = bindings.get(toolset)
      if (existing && existing.clientId !== clientId) throw new Error(`"${toolset}" is bound to another client.`)
      if (existing) {
        if (existing.title !== title) {
          existing.title = title
          persist()
        }
        return copy(existing)
      }
      if (bindings.size >= MAX_BINDINGS) throw new Error(`${MAX_BINDINGS} toolset names are bound already.`)
      const created: ClientToolsetBinding = {
        toolset,
        clientId,
        title,
        boundAt: now().toISOString(),
        conversations: [],
      }
      bindings.set(toolset, created)
      try {
        persist()
      } catch (error) {
        bindings.delete(toolset)
        throw error
      }
      return copy(created)
    },
    setGranted(toolset, conversation, granted) {
      const binding = bindings.get(toolset)
      if (!binding) throw new Error(`"${toolset}" is not bound to any client.`)
      const held = binding.conversations.some((ref) => same(ref, conversation))
      if (held === granted) return
      const before = binding.conversations
      binding.conversations = granted
        ? [...before, { workspaceId: conversation.workspaceId, agentId: conversation.agentId }].slice(
            -MAX_GRANTS_PER_TOOLSET,
          )
        : before.filter((ref) => !same(ref, conversation))
      try {
        persist()
      } catch (error) {
        binding.conversations = before
        throw error
      }
    },
    grantsOf: (conversation) =>
      [...bindings.values()]
        .filter((binding) => binding.conversations.some((ref) => same(ref, conversation)))
        .map((binding) => binding.toolset),
    forgetClient(clientId) {
      const names = [...bindings.values()].filter((binding) => binding.clientId === clientId).map((b) => b.toolset)
      if (!names.length) return []
      for (const name of names) bindings.delete(name)
      persist()
      return names
    },
  }
}
