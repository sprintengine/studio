// Pure selector/snippet algorithms for the annotate picker. These run *inside*
// the sandboxed frame (serialized into the injected script — see pickerRuntime),
// so they must reference nothing but their arguments and standard JS. They
// operate on a minimal structural node rather than a DOM `Element` so the whole
// algorithm is unit-testable in the node harness (no jsdom) and the injected
// runtime adapts real elements to this shape.

/** A DOM element reduced to the fields the selector algorithm needs. */
export type SelectorNode = {
  /** Tag name as the DOM reports it (may be upper-case); lower-cased on output. */
  tagName: string
  /** `id` attribute, or null when absent/empty. */
  id: string | null
  /** Class tokens in document order. */
  classNames: readonly string[]
  /** Parent element node, or null at the document root. */
  parent: SelectorNode | null
  /** 1-based index among siblings sharing this tag. */
  nthOfType: number
  /** Count of siblings sharing this tag (>= 1); >1 means nth-of-type is needed. */
  typeSiblingCount: number
}

// A CSS identifier we can drop into a selector verbatim without escaping. Ids or
// classes that don't match fall back to the structural chain, which stays unique
// by construction, so an odd id never produces a broken selector.
const SAFE_CSS_IDENT = /^-?[A-Za-z_][\w-]*$/

/**
 * Shortest reasonably-unique CSS path to `node`, built constructively (no
 * `querySelectorAll` round-trips, so it needs no live document): an `id`
 * fast-path stops the climb (ids are document-unique per spec), otherwise each
 * level contributes `tag` + safe classes + `:nth-of-type(n)` when the tag repeats
 * among siblings. The full ancestor chain (to the nearest id, else the root)
 * guarantees uniqueness even when classes collide.
 */
export function buildUniqueSelector(node: SelectorNode): string {
  const segments: string[] = []
  let current: SelectorNode | null = node
  while (current) {
    if (current.id && SAFE_CSS_IDENT.test(current.id)) {
      segments.unshift(`#${current.id}`)
      break
    }
    let segment = current.tagName.toLowerCase()
    for (const cls of current.classNames) {
      if (SAFE_CSS_IDENT.test(cls)) segment += `.${cls}`
    }
    if (current.typeSiblingCount > 1) {
      segment += `:nth-of-type(${current.nthOfType})`
    }
    segments.unshift(segment)
    current = current.parent
  }
  return segments.join(' > ')
}

/**
 * Human- and agent-readable outerHTML excerpt: whitespace collapsed and capped
 * so a single annotation can't smuggle a whole subtree into the feedback batch.
 * The excerpt is the fallback anchor when the selector orphans after a revision.
 */
export function buildSnippetExcerpt(outerHtml: string, max = 200): string {
  const collapsed = outerHtml.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}

/**
 * DevTools-style hover identity, e.g. `h2 · .p-h — "Today's jobs"`: tag, the
 * first safe class, and a short text hint. Purely for the tooltip chip.
 */
export function describeElementChip(
  node: Pick<SelectorNode, 'tagName' | 'classNames'>,
  text: string,
): string {
  const cls = node.classNames.find((token) => SAFE_CSS_IDENT.test(token))
  const trimmed = text.replace(/\s+/g, ' ').trim()
  const hint = trimmed.length > 40 ? `${trimmed.slice(0, 39).trimEnd()}…` : trimmed
  let label = node.tagName.toLowerCase()
  if (cls) label += ` · .${cls}`
  if (hint) label += ` — "${hint}"`
  return label
}
