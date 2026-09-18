// The concurrency rule, in one pure function.
//
// Three writers touch a board — an agent through the tools, the person through
// the pane, and git through the file — and none of them can be made to wait for
// the others. So there is no lock: every element carries its own version, and a
// merge is decided per element. The rule has to be commutative and total, or
// two windows that saw the same two writes in a different order end up with
// different drawings and neither can tell.

import type { CanvasElement } from './types'

/** How long a deletion has to stay in the file for every peer to have seen it. */
export const CANVAS_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000

function readVersion(element: CanvasElement): number {
  return typeof element.version === 'number' && Number.isFinite(element.version) ? element.version : 0
}

function readNonce(element: CanvasElement): number {
  return typeof element.versionNonce === 'number' && Number.isFinite(element.versionNonce) ? element.versionNonce : 0
}

/**
 * Which of two edits to the same element survives: the higher `version`, and on
 * a tie the lower `versionNonce`. The nonce is random per edit, so the tie-break
 * is arbitrary — but it is the *same* arbitrary answer on every peer, which is
 * the only property that matters. Exact ties keep `local`, so a merge that
 * changes nothing returns the array it was given.
 */
export function pickWinner(local: CanvasElement, incoming: CanvasElement): CanvasElement {
  const localVersion = readVersion(local)
  const incomingVersion = readVersion(incoming)
  if (incomingVersion > localVersion) return incoming
  if (incomingVersion < localVersion) return local
  const localNonce = readNonce(local)
  const incomingNonce = readNonce(incoming)
  return incomingNonce < localNonce ? incoming : local
}

/**
 * Merge two views of the same board.
 *
 * Ids present on one side only are kept — an element the other side has not
 * seen yet is not a deletion, and a real deletion arrives as a tombstone with a
 * bumped version, which wins on its own merits.
 *
 * Order: `local`'s order is preserved and elements only the incoming side has
 * are appended in their own order, so nothing jumps around under the person's
 * cursor. Paint order is then restored from the fractional `index` fields where
 * they exist: elements carrying one are sorted among the positions they already
 * occupy, and elements without one stay exactly where they were, because an
 * element with no index has no opinion about who it should be drawn over.
 */
export function mergeElements(local: CanvasElement[], incoming: CanvasElement[]): CanvasElement[] {
  const incomingById = new Map<string, CanvasElement>()
  for (const element of incoming) {
    if (!incomingById.has(element.id)) incomingById.set(element.id, element)
  }

  const merged: CanvasElement[] = []
  const seen = new Set<string>()
  for (const element of local) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    const other = incomingById.get(element.id)
    merged.push(other ? pickWinner(element, other) : element)
  }
  for (const element of incoming) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    merged.push(element)
  }
  return sortByFractionalIndex(merged)
}

function sortByFractionalIndex(elements: CanvasElement[]): CanvasElement[] {
  const slots: number[] = []
  const indexed: CanvasElement[] = []
  for (let i = 0; i < elements.length; i += 1) {
    if (typeof elements[i].index === 'string') {
      slots.push(i)
      indexed.push(elements[i])
    }
  }
  if (slots.length < 2) return elements
  const order = indexed
    .map((element, position) => ({ element, position }))
    .sort((a, b) => {
      const left = a.element.index as string
      const right = b.element.index as string
      if (left === right) return a.position - b.position
      return left < right ? -1 : 1
    })
  const result = elements.slice()
  for (let i = 0; i < slots.length; i += 1) result[slots[i]] = order[i].element
  return result
}

/**
 * Drop tombstones that have outlived the window in which a peer could still be
 * carrying the element alive. Called at write time, so the file does not grow
 * without bound; a tombstone with no `updated` stamp is kept, because we cannot
 * tell how old it is and keeping it costs one line.
 */
export function dropStaleTombstones(elements: CanvasElement[], now: number): CanvasElement[] {
  return elements.filter((element) => {
    if (element.isDeleted !== true) return true
    const updated = element.updated
    if (typeof updated !== 'number' || !Number.isFinite(updated)) return true
    return now - updated <= CANVAS_TOMBSTONE_TTL_MS
  })
}

/**
 * A cheap fingerprint of "has anything mergeable changed?".
 *
 * The pane calls this on every editor `onChange` — which fires on pointer move —
 * so it hashes the four fields a merge can act on and nothing else: an id set,
 * a version, a nonce, a tombstone flag. Dragging a shape bumps its version, so
 * real edits always change the hash; hovering does not touch any of them, so
 * the debounce drops the write before it reaches IPC.
 */
export function sceneVersionHash(elements: CanvasElement[]): string {
  // FNV-1a over the fields above. Not a cryptographic hash and not used as one:
  // a collision costs one skipped save between two scenes that differ only in
  // fields this deliberately ignores.
  let hash = 0x811c9dc5
  for (const element of elements) {
    const line = `${element.id}:${readVersion(element)}:${readNonce(element)}:${element.isDeleted === true ? 1 : 0};`
    for (let i = 0; i < line.length; i += 1) {
      hash ^= line.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return `${elements.length}-${(hash >>> 0).toString(16)}`
}
