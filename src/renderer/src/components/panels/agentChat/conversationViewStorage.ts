// How a conversation was left — where it was scrolled to and which rows were
// open — kept in localStorage so it survives a restart, not only a tab switch.
// The shape of `draftStore.ts`, for its reasons: one versioned blob, writes
// coalesced because each one rewrites the whole blob, a quota refusal answered
// by keeping the most recently used conversations, and a parse that keeps what
// it can validate rather than all or nothing.

export const CONVERSATION_VIEW_STORAGE_KEY = 'sprintengine-conversation-view'
const STORAGE_VERSION = 1
export const MAX_REMEMBERED_CONVERSATIONS = 100
// A row per tool call is open-able, so a long session can collect hundreds of
// ids. The most recently toggled ones are the ones a person would notice lost.
export const MAX_DISCLOSURES_PER_CONVERSATION = 200
// The origin's quota is shared with the workspace store and the drafts, so the
// view state stays a small fraction of it however many conversations are kept.
const MAX_VIEW_STATE_CHARS = 400_000
const MAX_ID_CHARS = 512
// A scroll settles, then it is written: a fling is dozens of events and only
// where it stopped matters. The ceiling keeps a long unbroken scroll from
// never being written at all.
export const VIEW_WRITE_DELAY_MS = 250
const VIEW_WRITE_MAX_WAIT_MS = 2_000

export type ConversationScrollMemory = { rowId?: string; offset: number; atEnd: boolean }
export type RememberedConversationView = {
  scroll?: ConversationScrollMemory
  disclosures: Map<string, boolean>
}
/** Oldest first, the order the in-memory LRU map iterates in. */
type ConversationViewEntries = ReadonlyArray<readonly [string, RememberedConversationView]>

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function normalizeScrollMemory(value: unknown): ConversationScrollMemory | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<ConversationScrollMemory>
  if (typeof raw.atEnd !== 'boolean' || typeof raw.offset !== 'number' || !Number.isFinite(raw.offset)) return undefined
  const rowId = typeof raw.rowId === 'string' && raw.rowId && raw.rowId.length <= MAX_ID_CHARS ? raw.rowId : undefined
  return { ...(rowId ? { rowId } : {}), offset: Math.max(0, raw.offset), atEnd: raw.atEnd }
}

function normalizeDisclosures(value: unknown): Map<string, boolean> {
  const disclosures = new Map<string, boolean>()
  if (!Array.isArray(value)) return disclosures
  for (const pair of value.slice(-MAX_DISCLOSURES_PER_CONVERSATION)) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [id, open] = pair as unknown[]
    if (typeof id === 'string' && id.length <= MAX_ID_CHARS && typeof open === 'boolean') disclosures.set(id, open)
  }
  return disclosures
}

/**
 * The remembered views, oldest first. Anything unreadable — no storage, a
 * blob from another version, corrupt JSON, one malformed record — costs only
 * itself: a conversation that cannot be restored opens at its end, which is
 * where it would have opened before this existed.
 */
export function readConversationViews(storage: StorageLike | undefined): [string, RememberedConversationView][] {
  let raw: string | null = null
  try {
    raw = storage?.getItem(CONVERSATION_VIEW_STORAGE_KEY) ?? null
  } catch {
    return []
  }
  if (!raw) return []
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return []
  }
  if (!envelope || typeof envelope !== 'object') return []
  const { version, conversations } = envelope as { version?: unknown; conversations?: unknown }
  if (version !== STORAGE_VERSION || !Array.isArray(conversations)) return []
  const views: [string, RememberedConversationView][] = []
  for (const record of conversations.slice(-MAX_REMEMBERED_CONVERSATIONS)) {
    if (!Array.isArray(record) || record.length !== 2) continue
    const [key, value] = record as unknown[]
    if (typeof key !== 'string' || !key || key.length > MAX_ID_CHARS || !value || typeof value !== 'object') continue
    const view = value as { scroll?: unknown; disclosures?: unknown }
    const scroll = normalizeScrollMemory(view.scroll)
    const disclosures = normalizeDisclosures(view.disclosures)
    if (scroll || disclosures.size) views.push([key, { ...(scroll ? { scroll } : {}), disclosures }])
  }
  return views
}

function serializeView(view: RememberedConversationView) {
  return { ...(view.scroll ? { scroll: view.scroll } : {}), disclosures: [...view.disclosures] }
}

/**
 * The newest conversations whose records fit the character budget, oldest
 * first again. The newest is always kept: it is the one on screen.
 */
function withinBudget(entries: ConversationViewEntries) {
  const kept: [string, ReturnType<typeof serializeView>][] = []
  let chars = 0
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const [key, view] = entries[index]!
    if (!view.scroll && !view.disclosures.size) continue
    const record = serializeView(view)
    chars += key.length + JSON.stringify(record).length
    if (kept.length >= MAX_REMEMBERED_CONVERSATIONS || (kept.length > 0 && chars > MAX_VIEW_STATE_CHARS)) break
    kept.push([key, record])
  }
  return kept.reverse()
}

const blobOf = (records: ReturnType<typeof withinBudget>) =>
  JSON.stringify({ version: STORAGE_VERSION, conversations: records })

/**
 * Writes the remembered views after the delay, as one blob. When the quota
 * refuses it, the newest conversations that fit are written instead — binary
 * searched, as the drafts do — and `evicted` hears which ones had to go, so
 * the next write does not serialise them and search again. A write that fails
 * outright changes nothing: the previous blob stays, which restores an older
 * position rather than none.
 */
export function createConversationViewWriter(
  storage: StorageLike,
  entries: () => ConversationViewEntries,
  evicted: (keys: string[]) => void = () => {},
) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstScheduledAt: number | null = null
  const attempt = (blob: string) => {
    try {
      storage.setItem(CONVERSATION_VIEW_STORAGE_KEY, blob)
      return true
    } catch {
      return false
    }
  }
  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    firstScheduledAt = null
  }
  const flush = () => {
    if (timer === null) return
    cancel()
    const records = withinBudget(entries())
    if (attempt(blobOf(records))) return
    // Fewer conversations is always a smaller blob. Keep the newest `count`.
    let fits = 0
    let low = 1
    let high = records.length - 1
    while (low <= high) {
      const count = (low + high) >> 1
      if (attempt(blobOf(records.slice(records.length - count)))) {
        fits = count
        low = count + 1
      } else high = count - 1
    }
    if (fits) evicted(records.slice(0, records.length - fits).map(([key]) => key))
  }
  const schedule = () => {
    const now = Date.now()
    firstScheduledAt ??= now
    if (timer !== null) clearTimeout(timer)
    const wait = Math.max(0, Math.min(VIEW_WRITE_DELAY_MS, firstScheduledAt + VIEW_WRITE_MAX_WAIT_MS - now))
    timer = setTimeout(flush, wait)
  }
  return { schedule, flush }
}
