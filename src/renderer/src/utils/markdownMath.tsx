// Math in a reply: `$$…$$` and `\(…\)` inline, `$$` and `\[` … `\]` blocks,
// and a ```math fence, typeset with KaTeX.
//
// The risk is not missing a formula but finding one that is not there. Agents
// write prices ("between $5 and $10") and shell variables (`$HOME`, `$PATH`)
// in prose all the time, so a single dollar never opens math; only a doubled
// one does. A `$$` that closes right before a digit is a pair of amounts
// written with doubled signs ("$$100 and then $$200"), not a formula. Every
// delimiter is read by the parser itself rather than by a pass over the source,
// so none opens inside a code span or a code block, which the parser has
// already set aside, and inline math gives way to a backtick or a `://`, which
// TeX has no use for and code spans and links do.
//
// A display block is a block of its own, like a code fence: `$$` or `\[` alone
// on a line (or `\[ … \]` filling one), its TeX the lines up to the matching
// closing line, so a line of TeX that starts with `-`, `+`, `1.` or `#` stays
// TeX instead of becoming a list or a heading. Unlike a code fence it needs its
// closing line, so a formula still streaming in is text until it is complete.
// In the middle of a sentence `\[` is the escaped bracket markdown always made
// it, and `\[1\]` on a line of its own is a citation.
//
// The typesetter is loaded on the first formula (`lib/math/typesetMath.ts`).
// Until it has loaded, and whenever a formula does not parse, the source shows
// as code, so nothing a reply says is ever lost to a failed render.

import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { loadedTypesetter, loadTypesetter, onTypesetterLoaded, typesetMath } from '../lib/math/typesetMath'

// ---- Parsing the delimiters -------------------------------------------------
//
// micromark constructs of our own in place of remark-math's. They emit the
// tokens remark-math's do (`mathText…` inline, `mathFlow…` for a block), so
// its tree builder turns them into the same `inlineMath` and `math` nodes. The
// slice of micromark's types they touch is declared here, as the alert pass
// declares its slice of the syntax tree.

type Code = number | null
type State = (code: Code) => State | undefined
type Effects = {
  enter: (type: string) => unknown
  exit: (type: string) => unknown
  consume: (code: Code) => void
  attempt: (construct: Construct, ok: State, nok: State) => State
}
type TokenizeContext = {
  interrupt?: boolean
  parser: { lazy: Record<number, boolean | undefined> }
  now: () => { line: number; offset: number }
  events: Array<[string, { type: string }]>
}
type Construct = {
  name?: string
  partial?: boolean
  concrete?: boolean
  previous?: (this: TokenizeContext, code: Code) => boolean
  tokenize: (this: TokenizeContext, effects: Effects, ok: State, nok: State) => State
}

const DOLLAR = 36
const BACKSLASH = 92
const LEFT_PARENTHESIS = 40
const RIGHT_PARENTHESIS = 41
const LEFT_SQUARE_BRACKET = 91
const RIGHT_SQUARE_BRACKET = 93
const BACKTICK = 96
const COLON = 58
const SLASH = 47
const COMMA = 44
const SPACE = 32

// An opener gives up this far in. Every opener of its kind that it passed over
// gives up too, without reading the text again (`gaveUp`): it would read the
// same text to the same end. So a reply full of `$$` that never close, or of
// `\[` blocks still waiting for their `\]`, is read once rather than to its
// end from each of them. (A formula that starts inside an abandoned one's
// reach and ends past it is the price, and at these lengths it does not occur.)
const MAX_INLINE_MATH = 4096
const MAX_DISPLAY_MATH = 16_384

// How far each kind of opener has read and given up, per parse.
const givenUp = new WeakMap<object, Map<string, number>>()

function gaveUp(context: TokenizeContext, kind: string): void {
  let kinds = givenUp.get(context.parser)
  if (!kinds) givenUp.set(context.parser, (kinds = new Map()))
  kinds.set(kind, Math.max(kinds.get(kind) ?? 0, context.now().offset))
}

function passedOver(context: TokenizeContext, kind: string): boolean {
  const end = givenUp.get(context.parser)?.get(kind)
  return end !== undefined && context.now().offset < end
}

// micromark's codes for a line ending (CR, LF, CRLF) are the negatives below
// -2; -2 and -1 are a tab and the virtual spaces that pad it.
const isLineEnding = (code: Code): boolean => code !== null && code < -2
const isSpace = (code: Code): boolean => code === SPACE || code === -1 || code === -2
const isDigit = (code: Code): boolean => code !== null && code >= 48 && code <= 57

/**
 * Inline math: `$$…$$`, which may run over the lines of its paragraph, or
 * `\(…\)`, which stays on its line. A backslash inside is TeX's own (`\frac`,
 * `\\`, `\$`), so it and the character after it are both content. A backtick
 * or a `://` ends the attempt: the code span or the link it starts wins.
 */
function inlineMath(dollar: boolean): Construct {
  const delimiter = dollar ? DOLLAR : BACKSLASH
  return {
    name: dollar ? 'chatDollarMath' : 'chatParenMath',
    // A `$$` right after another dollar is part of a longer run, unless that
    // one was escaped.
    ...(dollar
      ? {
          previous(this: TokenizeContext, code: Code) {
            return code !== DOLLAR || this.events.at(-1)?.[1].type === 'characterEscape'
          },
        }
      : {}),
    tokenize(effects, ok, nok) {
      const kind = dollar ? 'dollar' : 'parenthesis'
      let length = 0
      let content = false
      let last: Code = null
      let beforeLast: Code = null
      const closing: Construct = { partial: true, tokenize: tokenizeClosing }

      const fail: State = (code) => {
        gaveUp(this, kind)
        return nok(code)
      }
      const start: State = (code) => {
        if (passedOver(this, kind)) return nok(code)
        effects.enter('mathText')
        effects.enter('mathTextSequence')
        effects.consume(code)
        return dollar ? secondDollar : openParenthesis
      }
      const secondDollar: State = (code) => {
        if (code !== DOLLAR) return nok(code)
        effects.consume(code)
        return afterDollars
      }
      const afterDollars: State = (code) => {
        if (code === DOLLAR) return nok(code)
        effects.exit('mathTextSequence')
        return between(code)
      }
      const openParenthesis: State = (code) => {
        if (code !== LEFT_PARENTHESIS) return nok(code)
        effects.consume(code)
        effects.exit('mathTextSequence')
        return between
      }
      // Between runs of content; no data token is open here.
      const between: State = (code) => {
        if (code === null || length > MAX_INLINE_MATH) return fail(code)
        if (isLineEnding(code)) {
          if (!dollar) return fail(code)
          effects.enter('lineEnding')
          effects.consume(code)
          effects.exit('lineEnding')
          last = code
          return between
        }
        if (code === delimiter) return effects.attempt(closing, done, data)(code)
        return data(code)
      }
      const data: State = (code) => {
        effects.enter('mathTextData')
        return character(code)
      }
      const character: State = (code) => {
        if (code === BACKTICK) return fail(code)
        if (code === SLASH && last === SLASH && beforeLast === COLON) return fail(code)
        consume(code)
        return code === BACKSLASH ? escaped : inside
      }
      const escaped: State = (code) => {
        if (code === null || isLineEnding(code)) return inside(code)
        consume(code)
        // An escaped `\$` neither closes nor starts a run of dollars.
        last = null
        return inside
      }
      const inside: State = (code) => {
        // The second dollar of a run that did not close is content too.
        const failedRun = dollar && code === DOLLAR && last === DOLLAR
        if (code === null || isLineEnding(code) || length > MAX_INLINE_MATH || (code === delimiter && !failedRun)) {
          effects.exit('mathTextData')
          return between(code)
        }
        return character(code)
      }
      const consume = (code: Code) => {
        if (!isSpace(code)) content = true
        effects.consume(code)
        beforeLast = last
        last = code
        length++
      }
      const done: State = (code) => {
        effects.exit('mathText')
        return ok(code)
      }

      function tokenizeClosing(effects: Effects, ok: State, nok: State): State {
        const marker: State = (code) => {
          if (!content) return nok(code)
          effects.enter('mathTextSequence')
          effects.consume(code)
          return dollar ? secondClosingDollar : closingParenthesis
        }
        const secondClosingDollar: State = (code) => {
          if (code !== DOLLAR) return nok(code)
          effects.consume(code)
          return afterClosingDollars
        }
        const afterClosingDollars: State = (code) => {
          if (code === DOLLAR || isDigit(code)) return nok(code)
          effects.exit('mathTextSequence')
          return ok(code)
        }
        const closingParenthesis: State = (code) => {
          if (code !== RIGHT_PARENTHESIS) return nok(code)
          effects.consume(code)
          effects.exit('mathTextSequence')
          return ok
        }
        return marker
      }

      return start
    },
  }
}

/**
 * A display block. `$$` opens and closes on lines of their own, like a code
 * fence. `\[` opens a line and `\]` ends one, so the TeX may share their lines
 * (`\[ E = mc^2 \]` is a block of one line); a `\]` with more text after it
 * on its line is a sentence's brackets, and nothing here is math. A line that
 * leaves the container the block opened in (a blockquote's, a list item's)
 * ends it unclosed.
 */
const displayMath: Construct = {
  name: 'chatDisplayMath',
  concrete: true,
  tokenize(effects, ok, nok) {
    let bracket = false
    let length = 0
    let content = false
    // `\[1\]` and `\[2, 3\]` are citations, not equations.
    let citation = true
    const nonLazyLine: Construct = { partial: true, tokenize: tokenizeNonLazyLine }
    const closingDollars: Construct = { partial: true, tokenize: tokenizeClosingDollars }
    const closingBracket: Construct = { partial: true, tokenize: tokenizeClosingBracket }

    const kind = () => (bracket ? 'bracket block' : 'dollar block')
    // Interrupting a paragraph only the opening line is read, so giving up
    // there says nothing about the lines after it.
    const fail: State = (code) => {
      if (!this.interrupt) gaveUp(this, kind())
      return nok(code)
    }
    const start: State = (code) => {
      if (code !== DOLLAR && code !== BACKSLASH) return nok(code)
      bracket = code === BACKSLASH
      if (passedOver(this, kind())) return nok(code)
      effects.enter('mathFlow')
      effects.enter('mathFlowFence')
      effects.enter('mathFlowFenceSequence')
      effects.consume(code)
      return openingMarker
    }
    const openingMarker: State = (code) => {
      if (code !== (bracket ? LEFT_SQUARE_BRACKET : DOLLAR)) return nok(code)
      effects.consume(code)
      return afterOpening
    }
    const afterOpening: State = (code) => {
      if (code === DOLLAR) return nok(code)
      effects.exit('mathFlowFenceSequence')
      return space(openingRest)(code)
    }
    const openingRest: State = (code) => {
      if (code === null) return nok(code)
      if (isLineEnding(code)) {
        effects.exit('mathFlowFence')
        // Interrupting a paragraph, the opening line is all that is looked at.
        return this.interrupt ? ok(code) : nextLine(code)
      }
      if (!bracket) return nok(code)
      effects.exit('mathFlowFence')
      return bracketLine(code)
    }

    const nextLine: State = (code) =>
      ++length > MAX_DISPLAY_MATH ? fail(code) : effects.attempt(nonLazyLine, lineStart, fail)(code)
    const lineStart: State = (code) =>
      bracket ? bracketLine(code) : effects.attempt(closingDollars, after, dollarLine)(code)

    // A line of a `$$` block.
    const dollarLine: State = (code) => {
      if (code === null) return fail(code)
      if (isLineEnding(code)) return nextLine(code)
      effects.enter('mathFlowValue')
      return dollarValue(code)
    }
    const dollarValue: State = (code) => {
      if (code === null || isLineEnding(code)) {
        effects.exit('mathFlowValue')
        return dollarLine(code)
      }
      return take(code, dollarValue)
    }

    // A line of a `\[` block, up to its end or to the `\]` that ends the block.
    const bracketLine: State = (code) => {
      if (code === null) return fail(code)
      if (isLineEnding(code)) return this.interrupt ? fail(code) : nextLine(code)
      if (code === BACKSLASH) return effects.attempt(closingBracket, after, bracketEscape)(code)
      effects.enter('mathFlowValue')
      return bracketValue(code)
    }
    const bracketValue: State = (code) => {
      if (code === null || isLineEnding(code) || code === BACKSLASH) {
        effects.exit('mathFlowValue')
        return bracketLine(code)
      }
      if (!isSpace(code) && !isDigit(code) && code !== COMMA) citation = false
      return take(code, bracketValue)
    }
    // A backslash that does not end the block is TeX's own, with the
    // character after it.
    const bracketEscape: State = (code) => {
      effects.enter('mathFlowValue')
      citation = false
      return take(code, escapedCharacter)
    }
    const escapedCharacter: State = (code) => {
      if (code === RIGHT_SQUARE_BRACKET) return fail(code)
      if (code === null || isLineEnding(code)) return bracketValue(code)
      return take(code, bracketValue)
    }

    const take = (code: Code, next: State): State | undefined => {
      if (++length > MAX_DISPLAY_MATH) return fail(code)
      if (!isSpace(code)) content = true
      effects.consume(code)
      return next
    }
    const after: State = (code) => {
      if (!content || (bracket && citation)) return fail(code)
      effects.exit('mathFlow')
      return ok(code)
    }

    // Spaces and tabs, in a token the tree builder passes over.
    function space(next: State): State {
      const first: State = (code) => {
        if (!isSpace(code)) return next(code)
        effects.enter('whitespace')
        return rest(code)
      }
      const rest: State = (code) => {
        if (isSpace(code)) {
          effects.consume(code)
          return rest
        }
        effects.exit('whitespace')
        return next(code)
      }
      return first
    }

    // Each closing line ends with nothing but spaces after its marker.
    function closingEnd(effects: Effects, ok: State, nok: State): State {
      const end: State = (code) => {
        if (code !== null && !isLineEnding(code)) return nok(code)
        effects.exit('mathFlowFence')
        return ok(code)
      }
      return (code) => {
        if (!isSpace(code)) return end(code)
        effects.enter('whitespace')
        const rest: State = (next) => {
          if (isSpace(next)) {
            effects.consume(next)
            return rest
          }
          effects.exit('whitespace')
          return end(next)
        }
        return rest(code)
      }
    }

    function tokenizeClosingDollars(effects: Effects, ok: State, nok: State): State {
      const indent: State = (code) => {
        if (isSpace(code)) {
          effects.consume(code)
          return indent
        }
        effects.exit('whitespace')
        return marker(code)
      }
      const marker: State = (code) => {
        if (code !== DOLLAR) return nok(code)
        effects.enter('mathFlowFenceSequence')
        effects.consume(code)
        return secondMarker
      }
      const secondMarker: State = (code) => {
        if (code !== DOLLAR) return nok(code)
        effects.consume(code)
        effects.exit('mathFlowFenceSequence')
        return closingEnd(effects, ok, nok)
      }
      return (code) => {
        effects.enter('mathFlowFence')
        if (!isSpace(code)) return marker(code)
        effects.enter('whitespace')
        return indent(code)
      }
    }

    function tokenizeClosingBracket(effects: Effects, ok: State, nok: State): State {
      const marker: State = (code) => {
        if (code !== RIGHT_SQUARE_BRACKET) return nok(code)
        effects.consume(code)
        effects.exit('mathFlowFenceSequence')
        return closingEnd(effects, ok, nok)
      }
      return (code) => {
        effects.enter('mathFlowFence')
        effects.enter('mathFlowFenceSequence')
        effects.consume(code)
        return marker
      }
    }

    function tokenizeNonLazyLine(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
      return (code) => {
        if (code === null) return ok(code)
        effects.enter('lineEnding')
        effects.consume(code)
        effects.exit('lineEnding')
        return (next) => (this.parser.lazy[this.now().line] ? nok(next) : ok(next))
      }
    }

    return start
  },
}

const mathSyntax = {
  // remark-math's own constructs give way to these; its tree builder stays.
  disable: { null: ['mathFlow', 'mathText'] },
  flow: { [DOLLAR]: displayMath, [BACKSLASH]: displayMath },
  text: { [DOLLAR]: inlineMath(true), [BACKSLASH]: inlineMath(false) },
}

/** Remark plugin, after remark-math: the delimiters a reply's math is read with. */
export function remarkMathDelimiters(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] }
  data.micromarkExtensions ??= []
  data.micromarkExtensions.push(mathSyntax)
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
export function InlineMath({ tex: written, codeClassName }: { tex: string; codeClassName: string }): ReactNode {
  const tex = written.trim()
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
  tex: written,
  streaming,
  className,
  fallback,
}: {
  tex: string
  streaming: boolean
  className: string
  fallback: (note?: string) => ReactNode
}): ReactNode {
  const tex = written.trim()
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
