// Version bookkeeping, which is the whole reason the worker can hand main a
// full element array at all.
//
// Main merges what comes back against whatever the board holds now, per element,
// higher version wins (src/shared/canvas/merge.ts). Two rules follow, and
// breaking either one loses somebody's drawing:
//
//   1. Every element the worker changed must come back on a version strictly
//      above the one it replaced, or the person's concurrent edit silently wins
//      over the agent's — or worse, neither does and the two halves disagree.
//   2. Every element the worker did NOT change must come back byte for byte,
//      same version, same nonce. An element that arrives merely re-serialised
//      with a fresh version is a write main cannot tell from a real one, and it
//      overwrites whatever the person did to it while the request was in flight.
//
// So the draft below hands back the ORIGINAL object for anything untouched, and
// the stamp is applied only where the content actually differs.

import type { CanvasElement } from '../../../shared/canvas/types'

/** Fields that say when an element changed, not what it is. */
const BOOKKEEPING_KEYS = new Set(['version', 'versionNonce', 'updated'])

/** A fresh nonce, in the range the file format uses. */
export function freshNonce(random: () => number = Math.random): number {
  return Math.floor(random() * 2 ** 31)
}

/**
 * Whether two versions of an element differ in anything that matters.
 *
 * Deliberately structural rather than field-by-field: the element type carries
 * an index signature precisely so a field this code has never heard of survives,
 * and a comparison that only knew the named fields would call two elements equal
 * over a difference it could not see.
 */
export function sameContent(a: CanvasElement, b: CanvasElement): boolean {
  return stableKey(a) === stableKey(b)
}

function stableKey(element: CanvasElement): string {
  const keys = Object.keys(element)
    .filter((key) => !BOOKKEEPING_KEYS.has(key))
    .sort()
  const parts: string[] = []
  for (const key of keys) parts.push(`${key}=${JSON.stringify(element[key]) ?? 'undefined'}`)
  return parts.join('\u0000')
}

export type Stamp = { now: () => number; nonce: () => number }

export const defaultStamp: Stamp = { now: () => Date.now(), nonce: () => freshNonce() }

/**
 * `next` on a version main will accept over `previous`.
 *
 * `Math.max` rather than `previous.version + 1` because the converter bumps
 * versions of its own accord — a shape that gained an arrow in `boundElements`
 * comes back one ahead already — and going backwards from that would undo the
 * converter's own bookkeeping.
 */
export function stampVersion(next: CanvasElement, previous: CanvasElement | undefined, stamp: Stamp): CanvasElement {
  if (!previous) {
    return { ...next, versionNonce: stamp.nonce(), updated: stamp.now() }
  }
  if (sameContent(next, previous)) return previous
  const previousVersion = typeof previous.version === 'number' ? previous.version : 0
  const nextVersion = typeof next.version === 'number' ? next.version : 0
  return {
    ...next,
    version: Math.max(nextVersion, previousVersion + 1),
    versionNonce: stamp.nonce(),
    updated: stamp.now(),
  }
}

/** The same element with `updates` applied, on a version above its own. */
export function withChanges(
  element: CanvasElement,
  updates: Partial<CanvasElement>,
  stamp: Stamp,
): CanvasElement {
  const next = { ...element, ...updates } as CanvasElement
  return stampVersion(next, element, stamp)
}

/**
 * A working copy of a scene that remembers what it was handed.
 *
 * Order is the array's order: an element is replaced in place, and anything new
 * lands at the end, where the editor paints it on top.
 */
export class SceneDraft {
  private readonly list: CanvasElement[]
  private readonly slot = new Map<string, number>()
  private readonly original = new Map<string, CanvasElement>()
  private readonly touched = new Set<string>()

  constructor(elements: readonly CanvasElement[]) {
    this.list = []
    for (const element of elements) {
      if (!element || typeof element.id !== 'string') continue
      if (this.slot.has(element.id)) continue
      this.slot.set(element.id, this.list.length)
      this.list.push(element)
      this.original.set(element.id, element)
    }
  }

  has(id: string): boolean {
    return this.slot.has(id)
  }

  get(id: string): CanvasElement | undefined {
    const at = this.slot.get(id)
    return at === undefined ? undefined : this.list[at]
  }

  /** The element as it arrived, before anything in this request touched it. */
  originalOf(id: string): CanvasElement | undefined {
    return this.original.get(id)
  }

  /** Live (non-tombstoned) elements, in scene order. */
  live(): CanvasElement[] {
    return this.list.filter((element) => element.isDeleted !== true)
  }

  all(): CanvasElement[] {
    return this.list
  }

  /** Replace an element in place, or append it when the id is new. */
  put(element: CanvasElement): void {
    const at = this.slot.get(element.id)
    if (at === undefined) {
      this.slot.set(element.id, this.list.length)
      this.list.push(element)
    } else {
      if (this.list[at] === element) return
      this.list[at] = element
    }
    this.touched.add(element.id)
  }

  /** Apply `updates` to an element that is already here, bumping its version. */
  patch(id: string, updates: Partial<CanvasElement>, stamp: Stamp): CanvasElement | null {
    const current = this.get(id)
    if (!current) return null
    const next = withChanges(current, updates, stamp)
    if (next === current) return current
    this.put(next)
    return next
  }

  /** Ids whose element is not the object this draft was handed. */
  changedIds(): string[] {
    const out: string[] = []
    for (const id of this.touched) {
      const originalElement = this.original.get(id)
      const current = this.get(id)
      if (!current) continue
      if (originalElement && originalElement === current) continue
      out.push(id)
    }
    return out
  }
}
