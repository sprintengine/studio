// Markdown as a person typed it into the composer, rather than as a document.
//
// A message is read back as markdown so a pasted code fence, a list or a link
// renders the way it would anywhere else. Two document rules would betray
// what was typed, though: a single newline would fold two lines into one
// sentence, and an HTML-looking fragment (`<div>` in a question about a
// template) would vanish into the renderer instead of being shown. So every
// newline in prose is a line break, and HTML is text.

// The slice of the markdown syntax tree this pass reads and writes. Declared
// here for the same reason the alert pass declares its own: the tree's types
// belong to a package the renderer only reaches through remark.
type UserTextNode = {
  type: string
  value?: string
  children?: UserTextNode[]
}

// Containers whose children are blocks: an HTML block directly inside one
// becomes a paragraph of its text, not a bare text node between blocks.
const FLOW_CONTAINERS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/** Remark plugin: hard line breaks in prose, and HTML shown as the text it is. */
export function remarkUserText() {
  return (tree: UserTextNode) => rewrite(tree)
}

function rewrite(node: UserTextNode): void {
  if (!node.children) return
  const flow = FLOW_CONTAINERS.has(node.type)
  const children: UserTextNode[] = []
  for (const child of node.children) {
    if (child.type === 'html') {
      const text = breakLines(child.value ?? '')
      children.push(...(flow ? [{ type: 'paragraph', children: text }] : text))
    } else if (child.type === 'text') {
      children.push(...breakLines(child.value ?? ''))
    } else {
      rewrite(child)
      children.push(child)
    }
  }
  node.children = children
}

// One text node per line with a break between each, as remark's own hard
// break (two trailing spaces) would have produced.
function breakLines(value: string): UserTextNode[] {
  const lines = value.split(/\r?\n/u)
  const nodes: UserTextNode[] = []
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'break' })
    if (line) nodes.push({ type: 'text', value: line })
  })
  return nodes
}
