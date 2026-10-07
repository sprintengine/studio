// Math in a reply: `$$…$$` and `\(…\)` inline, `$$` and `\[` … `\]` blocks,
// and a ```math fence, typeset with KaTeX.
//
// The risk is not missing a formula but finding one that is not there. Agents
// write prices ("between $5 and $10") and shell variables (`$HOME`, `$PATH`)
// in prose all the time, so a single dollar never opens math; only a doubled
// one does. Inline math closed by `$$` right before a digit is a pair of
// amounts written with doubled signs, not a formula, and stays text. The
// backslash delimiters are read by the parser itself rather than by a pass
// over the source, so they never open inside a code span or a code block,
// which the parser has already set aside. A `\[` … `\]` only becomes a display
// block standing on lines of its own; in the middle of a sentence it is the
// escaped bracket pair markdown always made it.
//
// The typesetter is loaded on the first formula (`lib/math/typesetMath.ts`).
// Until it has loaded, and whenever a formula does not parse, the source shows
// as code, so nothing a reply says is ever lost to a failed render.

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { loadedTypesetter, loadTypesetter, onTypesetterLoaded, typesetMath } from '../lib/math/typesetMath'

// ---- Parsing the backslash delimiters ---------------------------------------
//
// A micromark construct of our own beside remark-math's. It emits the same
// tokens remark-math's dollar construct does (`mathText`, `mathTextSequence`,
// `mathTextData`), so remark-math's tree builder turns it into the same
// `inlineMath` node. The slice of micromark's types it touches is declared
// here, as the alert pass declares its slice of the syntax tree.

type Code = number | null
type State = (code: Code) => State | undefined
type Effects = {
  enter: (type: string) => unknown
  exit: (type: string) => unknown
  consume: (code: Code) => void
  attempt: (construct: Construct, ok: State, nok: State) => State
}
type Construct = { name?: string; partial?: boolean; tokenize: (effects: Effects, ok: State, nok: State) => State }

const BACKSLASH = 92
const LEFT_PARENTHESIS = 40
const RIGHT_PARENTHESIS = 41
const LEFT_SQUARE_BRACKET = 91
const RIGHT_SQUARE_BRACKET = 93
const SPACE = 32
// micromark's codes for a line ending (CR, LF, CRLF) are the negatives below
// -2; -2 and -1 are a tab and the virtual spaces that pad it.
const isLineEnding = (code: Code): boolean => code !== null && code < -2
const isSpace = (code: Code): boolean => code === SPACE || code === -1 || code === -2

/**
 * `\` + `opener` … `\` + `closer`. Inline math stays on its line; a display
 * block may run over several. A backslash that does not close is TeX's own
 * (`\frac`, `\\`), so it and the character after it are both content.
 */
function backslashMath(opener: number, closer: number, multiline: boolean): Construct {
  const close: Construct = {
    partial: true,
    tokenize(effects, ok, nok) {
      const backslash: State = (code) => {
        effects.enter('mathTextSequence')
        effects.consume(code)
        return marker
      }
      const marker: State = (code) => {
        if (code !== closer) return nok(code)
        effects.consume(code)
        effects.exit('mathTextSequence')
        return ok
      }
      return backslash
    },
  }
  return {
    name: 'backslashMath',
    tokenize(effects, ok, nok) {
      let content = false
      const start: State = (code) => {
        effects.enter('mathText')
        effects.enter('mathTextSequence')
        effects.consume(code)
        return open
      }
      const open: State = (code) => {
        if (code !== opener) return nok(code)
        effects.consume(code)
        effects.exit('mathTextSequence')
        return between
      }
      // Between runs of content; no data token is open here.
      const between: State = (code) => {
        if (code === null) return nok(code)
        if (code === BACKSLASH) return content ? effects.attempt(close, done, escape)(code) : escape(code)
        if (isLineEnding(code)) {
          if (!multiline) return nok(code)
          effects.enter('lineEnding')
          effects.consume(code)
          effects.exit('lineEnding')
          return between
        }
        effects.enter('mathTextData')
        return data(code)
      }
      const data: State = (code) => {
        if (code === null || code === BACKSLASH || isLineEnding(code)) {
          effects.exit('mathTextData')
          return between(code)
        }
        if (!isSpace(code)) content = true
        effects.consume(code)
        return data
      }
      const escape: State = (code) => {
        effects.enter('mathTextData')
        effects.consume(code)
        content = true
        return escaped
      }
      const escaped: State = (code) => {
        if (code === null || isLineEnding(code)) {
          effects.exit('mathTextData')
          return between(code)
        }
        effects.consume(code)
        return data
      }
      const done: State = (code) => {
        effects.exit('mathText')
        return ok(code)
      }
      return start
    },
  }
}

const backslashMathText = {
  text: {
    [BACKSLASH]: [
      backslashMath(LEFT_PARENTHESIS, RIGHT_PARENTHESIS, false),
      backslashMath(LEFT_SQUARE_BRACKET, RIGHT_SQUARE_BRACKET, true),
    ],
  },
}

// ---- Settling what the parser found -----------------------------------------

type MathSyntaxNode = {
  type: string
  value?: string
  children?: MathSyntaxNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: Record<string, unknown>
}

/** The node remark-math builds for a `$$` block, so a `\[` block draws the same. */
function displayMathNode(value: string): MathSyntaxNode {
  return {
    type: 'math',
    value,
    data: {
      hName: 'pre',
      hChildren: [
        {
          type: 'element',
          tagName: 'code',
          properties: { className: ['language-math', 'math-display'] },
          children: [{ type: 'text', value }],
        },
      ],
    },
  }
}

function opensWith(node: MathSyntaxNode, source: string, delimiter: string): boolean {
  const start = node.position?.start.offset
  return start !== undefined && source.startsWith(delimiter, start)
}

/**
 * A `\[` block stands on lines of its own: nothing before it on its first
 * line, nothing after it on its last. Agents often write it straight under a
 * sentence ("The update is:" and then the block), which markdown reads as one
 * paragraph, so the paragraph is split around it.
 */
function standsAlone(siblings: MathSyntaxNode[], index: number): boolean {
  const before = siblings[index - 1]
  const after = siblings[index + 1]
  const lineBefore = !before || (before.type === 'text' && /\n[ \t]*$/u.test(before.value ?? ''))
  const lineAfter = !after || (after.type === 'text' && /^[ \t]*\n/u.test(after.value ?? ''))
  return lineBefore && lineAfter
}

function settleParagraph(paragraph: MathSyntaxNode, source: string): MathSyntaxNode[] {
  const children = paragraph.children ?? []
  const blocks: MathSyntaxNode[] = []
  let run: MathSyntaxNode[] = []
  const flush = () => {
    const first = run[0]
    if (first?.type === 'text') first.value = (first.value ?? '').replace(/^[ \t]*\n/u, '')
    const last = run.at(-1)
    if (last?.type === 'text') last.value = (last.value ?? '').replace(/\n[ \t]*$/u, '')
    const kept = run.filter((node) => node.type !== 'text' || node.value)
    if (kept.length) blocks.push({ ...paragraph, children: kept })
    run = []
  }
  children.forEach((child, index) => {
    if (child.type !== 'inlineMath') return void run.push(child)
    const end = child.position?.end.offset
    if (opensWith(child, source, '\\[')) {
      if (standsAlone(children, index)) {
        flush()
        blocks.push(displayMathNode((child.value ?? '').trim()))
      } else run.push({ type: 'text', value: `[${child.value ?? ''}]` })
    } else if (opensWith(child, source, '$$') && end !== undefined && /\d/u.test(source[end] ?? '')) {
      run.push({ type: 'text', value: source.slice(child.position!.start.offset, end) })
    } else run.push(child)
  })
  if (!blocks.length) {
    paragraph.children = run
    return [paragraph]
  }
  flush()
  return blocks
}

function settle(node: MathSyntaxNode, source: string): void {
  if (!node.children) return
  const children: MathSyntaxNode[] = []
  for (const child of node.children) {
    if (child.type === 'paragraph' && child.children?.some((inner) => inner.type === 'inlineMath')) {
      children.push(...settleParagraph(child, source))
    } else {
      settle(child, source)
      children.push(child)
    }
  }
  node.children = children
}

/**
 * Remark plugin, after remark-math: the backslash delimiters, a `\[` block
 * that stands alone made a display block, and a `$$` that closes on a digit
 * given back to the text.
 */
export function remarkMathDelimiters(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  data.micromarkExtensions ??= []
  data.micromarkExtensions.push(backslashMathText)
  return (tree: MathSyntaxNode, file: { value: unknown }) => settle(tree, String(file.value ?? ''))
}

// ---- Drawing it -------------------------------------------------------------

/** The typesetter once it has loaded; asks for it the first time it is wanted. */
function useTypesetter(wanted: boolean) {
  const engine = useSyncExternalStore(onTypesetterLoaded, loadedTypesetter, loadedTypesetter)
  useEffect(() => {
    if (wanted && !engine) loadTypesetter().catch(() => undefined)
  }, [wanted, engine])
  return engine
}

/** A formula's first line of complaint, for the note under its source. */
function mathError(message: string): string {
  return `Shown as source: ${message.split('\n', 1)[0].replace(/^KaTeX parse error:\s*/u, '')}`
}

/**
 * Inline math. The source shows as inline code while the typesetter loads,
 * and stays that way, with the reason on hover, when the formula does not
 * parse. The TeX rides on the element so a copied selection gets it back.
 */
export function InlineMath({ tex, codeClassName }: { tex: string; codeClassName: string }): ReactNode {
  const engine = useTypesetter(true)
  const result = engine ? typesetMath(engine, tex, false) : null
  if (!result || 'error' in result) {
    return (
      <code className={codeClassName} title={result ? mathError(result.error) : undefined}>
        {tex}
      </code>
    )
  }
  return <span data-math="inline" data-tex={tex} dangerouslySetInnerHTML={{ __html: result.html }} />
}

/**
 * A display formula. While its message streams it is the source, in the code
 * block it arrived in: a formula typed a token at a time parses, fails and
 * parses again, and would flicker between the two. Once settled it is drawn;
 * `fallback` is the block it falls back to, with a note saying why when the
 * formula does not parse.
 */
export function DisplayMath({
  tex,
  streaming,
  className,
  fallback,
}: {
  tex: string
  streaming: boolean
  className: string
  fallback: (note?: string) => ReactNode
}): ReactNode {
  const engine = useTypesetter(!streaming)
  if (streaming || !engine) return fallback()
  const result = typesetMath(engine, tex, true)
  if ('error' in result) return fallback(mathError(result.error))
  return (
    <div data-math="display" data-tex={tex} className={className} dangerouslySetInnerHTML={{ __html: result.html }} />
  )
}

/**
 * The fence tag a display formula comes in: a `$$` or `\[` block is built as
 * one, and ```math asks for it outright. A ```latex, ```tex or ```katex fence
 * stays code: it is as often a document, or TeX someone is meant to copy, as a
 * formula, and a drawing would hide it behind one with nothing to copy.
 */
export function isMathLanguage(language: string | undefined): boolean {
  return (language ?? '').toLowerCase() === 'math'
}
