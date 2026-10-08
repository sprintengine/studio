import { toolObject, type ConversationTimelineRow } from './conversationTimeline'
import { CONVERSATION_ROW_ATTRIBUTE } from './conversationRowFrame'
import { partitionWorkTimeline } from './timelineRows'
import { deriveTurnFold, turnAgentLanes, turnFoldedProse, turnFoldedSteps } from './turnFolds'

// Find in this chat (`chat.find`, ⌘F inside a chat).
//
// The transcript is a virtual list: a row off screen is not in the page, so
// the browser's own find cannot see it, and neither can a search of the DOM.
// What is searched is the projected rows' text instead (what the person said,
// what the agent replied, what a command printed, and the one-line summaries
// of the agent's steps), which is every row the chat has loaded whether or
// not it is drawn. A match is a place in a row; going to it scrolls the list
// to that row, and opens the turn's fold when the match is behind it.
//
// The words on screen are marked separately (`paintChatFindHighlights`), over
// whatever rows are drawn at the time. The two can disagree in small ways: the
// reply is searched as the markdown it was written in and drawn as what that
// renders to, so `**` in a query finds the source but marks nothing.

export type ChatFindHit = {
  rowIndex: number
  rowId: string
  /** Which match in its row this is, in the order the row draws its text. */
  occurrence: number
  /**
   * The disclosures the match is behind, outermost first, to open on the way
   * to it (conversationViewState ids): its turn's fold, then the group of
   * steps inside it. Empty when it is in plain view.
   */
  opens: string[]
}

type Segment = { text: string; opens: string[] }

/** A row's searchable text, in the order the row draws it. */
function rowSegments(row: ConversationTimelineRow): Segment[] {
  switch (row.kind) {
    case 'user':
      return [{ text: row.entry.text, opens: [] }]
    case 'commandOutput':
      return [{ text: row.entry.output, opens: [] }]
    case 'assistant': {
      // The fold over the turn's work draws first, then the agents it sent off
      // (cards outside the fold), then the reply. Inside the fold the steps
      // run in parts split by the prose between them, each part's steps a
      // group behind a line of its own (timelineRows' WorkTimeline): a match
      // in a step is behind the fold and that group both.
      const fold = deriveTurnFold(row.entry, row.tools) ? [`fold:${row.entry.turnId}`] : []
      const prose = turnFoldedProse(row.entry.intermediateText)
      const segments: Segment[] = []
      for (const part of partitionWorkTimeline(row.tools, prose)) {
        for (const text of part.text) segments.push({ text, opens: fold })
        const steps = turnFoldedSteps(part.tools)
        const group = steps[0] ? [`group:${steps[0].id}`] : []
        for (const step of steps) segments.push({ text: toolObject(step), opens: [...fold, ...group] })
      }
      for (const lane of turnAgentLanes(row.tools)) segments.push({ text: toolObject(lane), opens: [] })
      segments.push({ text: row.entry.text, opens: [] })
      return segments
    }
    default:
      return []
  }
}

/** Every start index of `needle` in `haystack`, both already lower-cased; matches do not overlap. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) found.push(at)
  return found
}

/** The query as it is matched: case folded, and nothing at all when it is only spaces. */
export function chatFindNeedle(query: string): string | null {
  return query.trim() ? query.toLocaleLowerCase() : null
}

/** Every match of `query` in the loaded rows, first row first. */
export function chatFindHits(rows: readonly ConversationTimelineRow[], query: string): ChatFindHit[] {
  const needle = chatFindNeedle(query)
  if (!needle) return []
  const hits: ChatFindHit[] = []
  rows.forEach((row, rowIndex) => {
    let occurrence = 0
    for (const segment of rowSegments(row)) {
      const count = occurrences(segment.text.toLocaleLowerCase(), needle).length
      for (let index = 0; index < count; index++) {
        hits.push({ rowIndex, rowId: row.id, occurrence, opens: segment.opens })
        occurrence += 1
      }
    }
  })
  return hits
}

/** The hit after (or before) `index`, round the end; -1 when there are none. */
export function stepChatFindIndex(index: number, count: number, direction: 1 | -1): number {
  if (count === 0) return -1
  if (index < 0) return direction === 1 ? 0 : count - 1
  return (index + direction + count) % count
}

// ── Marking the words on screen ─────────────────────────────────────────────
//
// The CSS Custom Highlight API marks text without touching the DOM the rows
// own, so React, the markdown renderer and the virtual list are never handed
// a node they did not make. The highlight registry is the document's, and a
// window can show two chats at once (a split pane), so each view's ranges are
// kept apart here and the registry holds them all.

export const CHAT_FIND_HIGHLIGHT = 'chat-find'
export const CHAT_FIND_ACTIVE_HIGHLIGHT = 'chat-find-active'

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void }
type HighlightConstructor = new (...ranges: Range[]) => unknown

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight
  return css?.highlights && Highlight ? { registry: css.highlights, Highlight } : null
}

// NodeFilter's values, which are the DOM's and never change: read from the
// global, they are missing wherever a document is built without a window's.
const SHOW_TEXT = 0x4
const FILTER_ACCEPT = 1
const FILTER_REJECT = 2

const painted = new Map<string, { all: Range[]; active: Range | null }>()

function commitHighlights(): void {
  const api = highlightApi()
  if (!api) return
  const all = [...painted.values()].flatMap((view) => view.all)
  const active = [...painted.values()].flatMap((view) => (view.active ? [view.active] : []))
  if (all.length) api.registry.set(CHAT_FIND_HIGHLIGHT, new api.Highlight(...all))
  else api.registry.delete(CHAT_FIND_HIGHLIGHT)
  if (active.length) api.registry.set(CHAT_FIND_ACTIVE_HIGHLIGHT, new api.Highlight(...active))
  else api.registry.delete(CHAT_FIND_ACTIVE_HIGHLIGHT)
}

/** The find bar's own marker, so its words are never taken for a match. */
export const CONVERSATION_FIND_ATTRIBUTE = 'data-conversation-find'

/**
 * Mark every match drawn under `root` for the view `viewKey`, and the current
 * one more strongly: the `occurrence`-th match inside the row it is in, or the
 * row's last when the drawn text holds fewer than the source did. Answers the
 * current match's range, for bringing it into view.
 */
export function paintChatFindHighlights(
  viewKey: string,
  root: HTMLElement | null,
  query: string,
  active: Pick<ChatFindHit, 'rowId' | 'occurrence'> | null,
): Range | null {
  const needle = chatFindNeedle(query)
  if (!root || !needle) {
    clearChatFindHighlights(viewKey)
    return null
  }
  const all: Range[] = []
  const inActiveRow: Range[] = []
  const activeRow = active
    ? [...root.querySelectorAll(`[${CONVERSATION_ROW_ATTRIBUTE}]`)].find(
        (element) => element.getAttribute(CONVERSATION_ROW_ATTRIBUTE) === active.rowId,
      )
    : undefined
  // The find bar floats inside the transcript; its own words ("1 of 3") are not the chat's.
  const walker = root.ownerDocument.createTreeWalker(root, SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(`[${CONVERSATION_FIND_ATTRIBUTE}]`) ? FILTER_REJECT : FILTER_ACCEPT,
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue
    if (!text) continue
    for (const at of occurrences(text.toLocaleLowerCase(), needle)) {
      const range = root.ownerDocument.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      all.push(range)
      if (activeRow?.contains(node)) inActiveRow.push(range)
    }
  }
  const current =
    active && inActiveRow.length ? inActiveRow[Math.min(active.occurrence, inActiveRow.length - 1)]! : null
  painted.set(viewKey, { all, active: current })
  commitHighlights()
  return current
}

/** Take the view's marks down: its find closed, or the view went. */
export function clearChatFindHighlights(viewKey: string): void {
  if (!painted.delete(viewKey)) return
  commitHighlights()
}
