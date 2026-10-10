// In-page links in a rendered document: `[Setup](#setup)` in a README's table
// of contents, or a footnote's `[^1]`.
//
// Headings get GitHub's anchor slugs, so a link written against GitHub's
// rendering finds its heading here too. Every id carries GitHub's own
// `user-content-` prefix — the one remark already gives footnote ids — so a
// heading called "Root" can never take the id of an element of the app around
// it. A link is followed by scrolling its own document, never by touching the
// window's location: that belongs to the app (the web build reads its pairing
// token out of the hash), and a hash written there would outlive the document
// that asked for it.

export const MARKDOWN_FRAGMENT_PREFIX = 'user-content-'

// The slice of the markdown syntax tree this pass reads and writes, declared
// here for the same reason the alert pass declares its own.
type HeadingSyntaxNode = {
  type: string
  value?: string
  alt?: string
  children?: HeadingSyntaxNode[]
  data?: { hProperties?: Record<string, unknown> }
}

/**
 * GitHub's heading slug: lower case, punctuation and symbols dropped, each
 * space a dash. Letters, marks, digits, connector punctuation and hyphens are
 * kept in any script, so `## Überblick` and `## 安装` anchor too.
 */
export function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

/**
 * Remark plugin: every heading gets its slug as a prefixed id, made unique
 * within the document the way GitHub does it — the second "Setup" is
 * `setup-1`, and a suffix never lands on a slug a heading already has.
 */
export function remarkHeadingIds() {
  return (tree: HeadingSyntaxNode) => {
    const taken = new Set<string>()
    const nextSuffix = new Map<string, number>()
    const visit = (node: HeadingSyntaxNode) => {
      for (const child of node.children ?? []) {
        if (child.type !== 'heading') {
          visit(child)
          continue
        }
        const slug = githubHeadingSlug(plainText(child))
        if (!slug) continue
        let count = nextSuffix.get(slug) ?? 0
        let id = slug
        while (taken.has(id)) {
          count += 1
          id = `${slug}-${count}`
        }
        nextSuffix.set(slug, count)
        taken.add(id)
        child.data = {
          ...child.data,
          hProperties: { ...child.data?.hProperties, id: `${MARKDOWN_FRAGMENT_PREFIX}${id}` },
        }
      }
    }
    visit(tree)
  }
}

// A heading's text as GitHub slugs it: its words and its code, with an image
// standing in by its alt text.
function plainText(node: HeadingSyntaxNode): string {
  if (typeof node.value === 'string') return node.value
  if (node.type === 'image') return node.alt ?? ''
  return (node.children ?? []).map(plainText).join('')
}

/** An href that points inside the document it is written in. */
export function isMarkdownFragmentHref(href: string | undefined): href is string {
  return typeof href === 'string' && href.length > 1 && href.startsWith('#')
}

/**
 * The element an in-page link points at, looked up only inside the document
 * the link sits in: two replies can each have a "Setup", and each link means
 * its own. A link written against GitHub (`#setup`) takes the prefix; one
 * remark wrote itself (a footnote's `#user-content-fn-1`) already has it.
 */
export function markdownFragmentTarget(link: Element, href: string): Element | null {
  const root = link.closest('.markdown-rendered')
  if (!root) return null
  let fragment = href.slice(1)
  try {
    fragment = decodeURIComponent(fragment)
  } catch {
    // A stray `%` is part of the name, not an escape.
  }
  const ids = fragment.startsWith(MARKDOWN_FRAGMENT_PREFIX)
    ? [fragment]
    : [`${MARKDOWN_FRAGMENT_PREFIX}${fragment}`, `${MARKDOWN_FRAGMENT_PREFIX}${fragment.toLowerCase()}`]
  // Read on a click, never on render, so a walk of the ids is cheap enough and
  // needs no escaping of a fragment written by whoever wrote the document.
  const elements = Array.from(root.querySelectorAll('[id]'))
  for (const id of ids) {
    const match = elements.find((element) => element.id === id)
    if (match) return match
  }
  return null
}
