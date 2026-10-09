import { useEffect, useRef, type RefObject } from 'react'

/**
 * "A find is taking the reader to text inside you": dispatched, bubbling, at
 * the node holding the match, so whatever clips it — a long message folded to
 * its first lines, a code block folded to its first rows, a plan card resting
 * as a preview — opens and shows it.
 *
 * The browser's own find-in-page does this through `hidden="until-found"` and
 * the `beforematch` event, but only for its own matches; a find that runs over
 * the app's data (Find in chat) needs the same courtesy from the folds it
 * lands in, and an event is how a fold says so without the find knowing which
 * folds exist. Each fold keeps every line in the DOM while folded, so the node
 * is there to dispatch from.
 */
export const REVEAL_MATCH_EVENT = 'studio:reveal-match'

/** Ask every fold around `node` to show it. */
export function revealMatch(node: Node): void {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement
  // The node's own window's Event: one made by another realm is refused.
  const EventOfNode = element?.ownerDocument.defaultView?.Event ?? Event
  element?.dispatchEvent(new EventOfNode(REVEAL_MATCH_EVENT, { bubbles: true }))
}

/** Open a fold when a find lands inside it. Listens only while `folded`. */
export function useRevealMatch(ref: RefObject<Element | null>, folded: boolean, reveal: () => void): void {
  const latest = useRef(reveal)
  latest.current = reveal
  useEffect(() => {
    const element = ref.current
    if (!element || !folded) return
    const listener = () => latest.current()
    element.addEventListener(REVEAL_MATCH_EVENT, listener)
    return () => element.removeEventListener(REVEAL_MATCH_EVENT, listener)
  }, [ref, folded])
}
