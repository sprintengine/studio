import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  conversationCommandsFolderKey,
  type ConversationCommand,
  type ConversationCommandCatalog,
} from '../../shared/conversation/commands'
import { isRecord } from '../../shared/records'
import { writeFileAtomically } from '../config-file-write'

// The last good command list per (CLI, folder), kept across restarts so the
// composer's `/` menu is full the moment a chat opens instead of after a probe
// answers — the list is served as it was while a fresh one is asked for. It
// is a cache and nothing more: a missing, unreadable or malformed file is an
// empty cache, and a list that failed is never written over a good one.

export const CONVERSATION_COMMANDS_CACHE_FILE = 'conversation-commands-cache.json'
/** How many (CLI, folder) lists are kept; the least recently answered go first. */
const CONVERSATION_COMMANDS_CACHE_MAX_ENTRIES = 32
const WRITE_DEBOUNCE_MS = 1_000
// Caps on what is read back, so a file edited by hand into something huge is
// cut down rather than carried into every window.
const MAX_COMMANDS_PER_LIST = 500
const MAX_FIELD_LENGTH = 2_000
const FORMAT_VERSION = 1

const SOURCES = new Set<ConversationCommand['source']>(['app', 'cli', 'custom', 'skill'])

export type ConversationCommandsDiskCache = {
  /** Every list the file holds, oldest first. Resolves to none when the file is absent or unreadable. */
  load: () => Promise<ConversationCommandCatalog[]>
  /** Keep this list (a good one only) and write the file soon after. */
  record: (catalog: ConversationCommandCatalog) => void
  /** Write any pending change now; for quit and tests. */
  flush: () => Promise<void>
}

export function createConversationCommandsDiskCache(options: {
  file: string
  maxEntries?: number
  debounceMs?: number
}): ConversationCommandsDiskCache {
  const maxEntries = options.maxEntries ?? CONVERSATION_COMMANDS_CACHE_MAX_ENTRIES
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS
  // Insertion order is recency: a re-recorded list moves to the end.
  const entries = new Map<string, ConversationCommandCatalog>()
  let loading: Promise<ConversationCommandCatalog[]> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let writing: Promise<void> = Promise.resolve()

  const keyOf = (catalog: { cli: string; cwd: string }) =>
    `${catalog.cli}\u0000${conversationCommandsFolderKey(catalog.cwd)}`

  function trim(): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  function load(): Promise<ConversationCommandCatalog[]> {
    loading ??= (async () => {
      const stored = await readCatalogs(options.file)
      // What was recorded before the file was read is newer than anything in
      // it, so the file's lists go in ahead of those and never replace them.
      const recorded = [...entries.values()]
      entries.clear()
      for (const catalog of stored) entries.set(keyOf(catalog), catalog)
      for (const catalog of recorded) {
        entries.delete(keyOf(catalog))
        entries.set(keyOf(catalog), catalog)
      }
      trim()
      return stored
    })()
    return loading
  }

  async function write(): Promise<void> {
    await load()
    if (!dirty) return
    dirty = false
    const body = JSON.stringify({ version: FORMAT_VERSION, catalogs: [...entries.values()] })
    try {
      await mkdir(dirname(options.file), { recursive: true })
      await writeFileAtomically(options.file, body)
    } catch {
      // A cache that cannot be written costs one probe at the next start.
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      writing = writing.then(write)
    }, debounceMs)
  }

  return {
    load,
    record(catalog) {
      if (catalog.error || catalog.fetchedAt <= 0) return
      const key = keyOf(catalog)
      entries.delete(key)
      entries.set(key, { cli: catalog.cli, cwd: catalog.cwd, commands: catalog.commands, fetchedAt: catalog.fetchedAt })
      trim()
      dirty = true
      schedule()
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
        writing = writing.then(write)
      }
      await writing
    },
  }
}

async function readCatalogs(file: string): Promise<ConversationCommandCatalog[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.catalogs)) return []
  const catalogs: ConversationCommandCatalog[] = []
  for (const raw of parsed.catalogs) {
    const catalog = readCatalog(raw)
    if (catalog) catalogs.push(catalog)
  }
  return catalogs
}

function readCatalog(raw: unknown): ConversationCommandCatalog | null {
  if (!isRecord(raw) || !text(raw.cli) || !text(raw.cwd) || !Array.isArray(raw.commands)) return null
  if (typeof raw.fetchedAt !== 'number' || !Number.isFinite(raw.fetchedAt) || raw.fetchedAt <= 0) return null
  const commands: ConversationCommand[] = []
  for (const entry of raw.commands.slice(0, MAX_COMMANDS_PER_LIST)) {
    const command = readCommand(entry)
    if (command) commands.push(command)
  }
  return { cli: raw.cli, cwd: raw.cwd, commands, fetchedAt: raw.fetchedAt }
}

function readCommand(raw: unknown): ConversationCommand | null {
  if (!isRecord(raw) || !text(raw.name) || /\s/.test(raw.name)) return null
  if (!SOURCES.has(raw.source as ConversationCommand['source'])) return null
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter(text) : []
  return {
    name: raw.name,
    ...(text(raw.description) ? { description: raw.description } : {}),
    ...(text(raw.argumentHint) ? { argumentHint: raw.argumentHint } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(text(raw.insertText) ? { insertText: raw.insertText } : {}),
    source: raw.source as ConversationCommand['source'],
  }
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_LENGTH
}
