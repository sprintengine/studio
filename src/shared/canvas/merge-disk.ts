import type { CanvasBoundElementRef, CanvasElement } from './types'

// The two merges a board needs beyond the per-element one in `merge.ts`: a
// whole scene read off the disk, and the other half of every binding after a
// merge. Shared, so a client that draws boards without the desktop's Node
// service (a web client) merges exactly as the desktop does.

/** A fresh `versionNonce`, in the range the file format uses. */
function randomNonce(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

function boundRefs(element: CanvasElement): CanvasBoundElementRef[] {
  const bound = element.boundElements
  if (!Array.isArray(bound)) return []
  return bound.filter((ref) => typeof ref?.id === 'string')
}

/**
 * Merge a board file somebody else wrote into what is in memory.
 *
 * Not `mergeElements`: this side is not a peer's partial view but a WHOLE
 * scene, so absence means deletion. An id the disk no longer carries is
 * tombstoned with a bumped version, which is the same deletion every other
 * subscriber will merge; a tie on version goes to the disk, because the disk is
 * what a person just looked at in another program.
 */
export function mergeFromDisk(local: CanvasElement[], disk: CanvasElement[], now: number): CanvasElement[] {
  const diskById = new Map<string, CanvasElement>()
  for (const element of disk) if (!diskById.has(element.id)) diskById.set(element.id, element)

  const merged: CanvasElement[] = []
  const seen = new Set<string>()
  for (const element of local) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    const fromDisk = diskById.get(element.id)
    if (!fromDisk) {
      merged.push(
        element.isDeleted === true
          ? element
          : { ...element, isDeleted: true, version: (element.version ?? 0) + 1, updated: now },
      )
      continue
    }
    const localVersion = typeof element.version === 'number' ? element.version : 0
    const diskVersion = typeof fromDisk.version === 'number' ? fromDisk.version : 0
    merged.push(diskVersion >= localVersion ? fromDisk : element)
  }
  for (const element of disk) {
    if (seen.has(element.id)) continue
    seen.add(element.id)
    merged.push(element)
  }
  return merged
}

/**
 * The other half of every binding, after a merge.
 *
 * A binding is a PAIR of references — the arrow names the shape, the shape
 * lists the arrow — and the merge decides per ELEMENT, so the two halves can
 * come from different writers. A shape the person moved while an agent
 * fastened an arrow to it wins the merge outright, `boundElements` and all,
 * and the arrow is then listed nowhere: it follows the shape, but dragging
 * the shape leaves it behind, and the one-way binding that results is one no
 * skeleton edit can clear.
 *
 * Only the MISSING half is ever added, never removed, which is what makes
 * this safe to run on every write. Somebody who detached an arrow cleared the
 * arrow's own binding too, so there is nothing here to add back; a shape
 * listing an arrow that binds it nowhere is left for the lint to report,
 * because removing it could undo an edit still in flight.
 *
 * A repaired shape takes a version above its own, so the writer whose copy
 * won hears about it on the answer to its own write rather than sending the
 * half-binding back and undoing the repair.
 */
export function repairBindingPairs(
  elements: CanvasElement[],
  now: number,
  nonce: () => number = randomNonce,
): CanvasElement[] {
  const live = new Map<string, CanvasElement>()
  for (const element of elements) {
    if (element.isDeleted !== true) live.set(element.id, element)
  }
  const additions = new Map<string, CanvasBoundElementRef[]>()
  const want = (hostId: string, ref: CanvasBoundElementRef): void => {
    const host = live.get(hostId)
    if (!host) return
    const listed = boundRefs(host).map((entry) => entry.id)
    const pending = additions.get(hostId) ?? []
    if (listed.includes(ref.id) || pending.some((entry) => entry.id === ref.id)) return
    additions.set(hostId, [...pending, ref])
  }

  for (const element of live.values()) {
    for (const which of ['startBinding', 'endBinding'] as const) {
      const binding = element[which]
      const targetId =
        typeof binding === 'object' &&
        binding !== null &&
        typeof (binding as { elementId?: unknown }).elementId === 'string'
          ? (binding as { elementId: string }).elementId
          : null
      if (targetId) want(targetId, { id: element.id, type: 'arrow' })
    }
    if (element.type === 'text' && typeof element.containerId === 'string' && element.containerId) {
      want(element.containerId, { id: element.id, type: 'text' })
    }
  }
  if (additions.size === 0) return elements

  return elements.map((element) => {
    const extra = additions.get(element.id)
    if (!extra || element.isDeleted === true) return element
    const next: CanvasElement = {
      ...element,
      boundElements: [...boundRefs(element), ...extra],
      version: (typeof element.version === 'number' ? element.version : 0) + 1,
      versionNonce: nonce(),
      updated: now,
    }
    return next
  })
}
