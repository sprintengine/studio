import { createHash, randomBytes } from 'crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

import type { ConversationEvent, ConversationPage } from '../../../shared/conversation-runtime'
import { parseConversationWireEvent } from '../../../../packages/conversation-protocol/src/serverFrames'
import { isRecord } from '../../../shared/records'

// What this machine keeps of a conversation it follows on another machine: the
// tail of its transcript as it last read it, and the cursor that transcript
// ends at. The cursor is only worth anything beside the events it vouches for
// — resuming after event 812 with no events in hand would show a conversation
// starting mid-reply — so the two are written together, in one file, and read
// back together or not at all.
//
// This is what lets a restart here resume where it left off: the cached tail
// is on screen at once, and the far end is asked only for what came after it.
// A reset from the far end (the log was recreated, or this cursor fell too far
// behind) replaces the file with the snapshot it sends.
//
// One directory per app profile, one file per followed conversation, named by
// hashes so a remote's ids never become a path here. Mode 0600, like every
// other file under the tailnet: a transcript is as private as the machine it
// came from.

const DIRECTORY = 'tailnet-remote-conversations'
const VERSION = 1

export type RemoteConversationCacheKey = { connectionId: string; workspaceId: string; agentId: string }

/** A followed conversation's tail and the cursor it ends at. */
export type RemoteConversationCacheRecord = {
  generation: string | null
  /** The highest sequence held; null before anything was read. */
  lastSeq: number | null
  page: ConversationPage
}

export type RemoteConversationCache = {
  load(key: RemoteConversationCacheKey): Promise<RemoteConversationCacheRecord | null>
  save(key: RemoteConversationCacheKey, record: RemoteConversationCacheRecord): Promise<void>
  /** The same write, finished before returning: for shutdown, when nothing waits on a promise. */
  saveNow(key: RemoteConversationCacheKey, record: RemoteConversationCacheRecord): void
  /** Everything kept for one paired machine. Forgetting a machine must not leave its transcripts behind. */
  forgetConnection(connectionId: string): Promise<void>
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32)

export function remoteConversationCacheFile(key: RemoteConversationCacheKey): string {
  return `${hash(key.connectionId)}-${hash(JSON.stringify([key.workspaceId, key.agentId]))}.json`
}

export function createRemoteConversationCache(options: {
  resolveUserDataDir: () => string
  log?: (message: string) => void
}): RemoteConversationCache {
  const directory = () => join(options.resolveUserDataDir(), DIRECTORY)
  const encode = (key: RemoteConversationCacheKey, record: RemoteConversationCacheRecord) =>
    `${JSON.stringify({ version: VERSION, key, ...record })}\n`
  // Writes for one file are chained, so an older tail never lands after a newer one.
  const writes = new Map<string, Promise<void>>()

  return {
    async load(key) {
      let text: string
      try {
        text = await readFile(join(directory(), remoteConversationCacheFile(key)), 'utf8')
      } catch {
        return null
      }
      try {
        return readRecord(JSON.parse(text), key)
      } catch {
        // An unreadable file is no cursor at all: the next subscribe asks for
        // a snapshot, which rewrites it.
        return null
      }
    },
    save(key, record) {
      const file = remoteConversationCacheFile(key)
      const payload = encode(key, record)
      const previous = writes.get(file) ?? Promise.resolve()
      const next = previous.then(async () => {
        try {
          await mkdir(directory(), { recursive: true, mode: 0o700 })
          const target = join(directory(), file)
          const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
          await writeFile(temporary, payload, { mode: 0o600 })
          await rename(temporary, target)
        } catch (error) {
          options.log?.(`Could not keep a followed conversation's transcript: ${message(error)}`)
        }
      })
      writes.set(file, next)
      void next.finally(() => {
        if (writes.get(file) === next) writes.delete(file)
      })
      return next
    },
    saveNow(key, record) {
      try {
        mkdirSync(directory(), { recursive: true, mode: 0o700 })
        const target = join(directory(), remoteConversationCacheFile(key))
        const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(temporary, encode(key, record), { mode: 0o600 })
        renameSync(temporary, target)
      } catch (error) {
        options.log?.(`Could not keep a followed conversation's transcript: ${message(error)}`)
      }
    },
    async forgetConnection(connectionId) {
      const prefix = `${hash(connectionId)}-`
      let names: string[]
      try {
        names = await readdir(directory())
      } catch {
        return
      }
      await Promise.all(
        names
          .filter((name) => name.startsWith(prefix))
          .map(async (name) => {
            await writes.get(name)?.catch(() => undefined)
            await rm(join(directory(), name), { force: true })
          }),
      )
    },
  }
}

/** A record read back, or null for one written for another conversation or in a shape this build cannot vouch for. */
function readRecord(value: unknown, key: RemoteConversationCacheKey): RemoteConversationCacheRecord | null {
  if (!isRecord(value) || value.version !== VERSION || !isRecord(value.key) || !isRecord(value.page)) return null
  if (
    value.key.connectionId !== key.connectionId ||
    value.key.workspaceId !== key.workspaceId ||
    value.key.agentId !== key.agentId
  )
    return null
  const generation = typeof value.generation === 'string' && value.generation ? value.generation : null
  const lastSeq = typeof value.lastSeq === 'number' && Number.isSafeInteger(value.lastSeq) ? value.lastSeq : null
  const page = value.page
  if (!Array.isArray(page.events) || typeof page.hasMore !== 'boolean') return null
  const beforeCursor =
    typeof page.beforeCursor === 'number' && Number.isSafeInteger(page.beforeCursor) ? page.beforeCursor : null
  const events: ConversationEvent[] = []
  for (const entry of page.events) {
    const event = parseConversationWireEvent(entry)
    if (!event || event.seq === undefined) return null
    events.push(event as ConversationEvent)
  }
  return { generation, lastSeq, page: { events, hasMore: page.hasMore, beforeCursor } }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
