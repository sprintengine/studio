import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { expect, test } from 'vitest'
import { livePreviewDecorations, revealedLines } from './markdownLivePreview'

function stateOf(doc: string, selection = EditorSelection.cursor(0)): EditorState {
  return EditorState.create({ doc, selection, extensions: [markdown({ base: markdownLanguage })] })
}

// Each decoration as `kind:text` — `hidden` for markup that is taken off the
// line, `bullet`/`rule` for a mark drawn as something else, a class name for a
// styled run, and `line(class)@n` for a line's own class.
function drawn(doc: string, revealed: number[] = []): string[] {
  const state = stateOf(doc)
  const out: string[] = []
  livePreviewDecorations(state, [{ from: 0, to: doc.length }], new Set(revealed)).between(
    0,
    doc.length,
    (from, to, decoration) => {
      const spec = decoration.spec as { class?: string; widget?: { toDOM(): HTMLElement } }
      if (from === to && spec.class) out.push(`line(${spec.class})@${state.doc.lineAt(from).number}`)
      else if (spec.widget)
        out.push(`${spec.widget.constructor.name === 'BulletWidget' ? 'bullet' : 'rule'}:${state.sliceDoc(from, to)}`)
      else out.push(`${spec.class ?? 'hidden'}:${state.sliceDoc(from, to)}`)
    },
  )
  return out
}

test('a heading off the caret line is drawn at heading size with its hashes gone', () => {
  expect(drawn('# Handoff\nbody')).toEqual(['line(cm-md-heading cm-md-h1)@1', 'hidden:# '])
  expect(drawn('#### Deep')).toEqual(['line(cm-md-heading cm-md-h3)@1', 'hidden:#### '])
})

test('the line the caret is on shows its markup, dimmed rather than hidden', () => {
  expect(drawn('# Handoff\nbody', [1])).toEqual(['line(cm-md-heading cm-md-h1)@1', 'cm-md-syntax:# '])
  expect(drawn('a **b** c', [1])).toEqual(['cm-md-strong:**b**', 'cm-md-syntax:**', 'cm-md-syntax:**'])
})

test('bold, italic, strikethrough and inline code lose their markers and keep their style', () => {
  // Sorted: a hidden mark and the styled run it opens start at one position,
  // and which of the two the set yields first is the set's business.
  const sorted = (doc: string) => drawn(doc).sort()
  expect(sorted('a **b** c')).toEqual(['cm-md-strong:**b**', 'hidden:**', 'hidden:**'])
  expect(sorted('an *aside*')).toEqual(['cm-md-em:*aside*', 'hidden:*', 'hidden:*'])
  expect(sorted('~~gone~~')).toEqual(['cm-md-strike:~~gone~~', 'hidden:~~', 'hidden:~~'])
  expect(sorted('run `npm ci`')).toEqual(['cm-md-code:`npm ci`', 'hidden:`', 'hidden:`'])
})

test('a fence keeps its backticks on screen, so the block has no empty first and last line', () => {
  expect(drawn('```ts\nlet a\n```')).toEqual([
    'line(cm-md-fence cm-md-fence-first)@1',
    'cm-md-syntax:```',
    'cm-md-syntax:ts',
    'line(cm-md-fence)@2',
    'line(cm-md-fence cm-md-fence-last)@3',
    'cm-md-syntax:```',
  ])
})

test('an inline link shows its words as a link; a reference link is left as typed', () => {
  expect(drawn('see [docs](https://example.com) now')).toEqual([
    'hidden:[',
    'cm-md-link:docs',
    'hidden:](https://example.com)',
  ])
  expect(drawn('see [docs][1]\n\n[1]: https://example.com')).not.toContain('cm-md-link:docs')
})

test('a bullet is drawn as a bullet off the caret line; a number stays a number', () => {
  expect(drawn('- one\n- two', [2])).toEqual(['bullet:-', 'cm-md-syntax:-'])
  expect(drawn('1. one')).toEqual(['cm-md-list-number:1.'])
})

test('a quote keeps its rule on every line and loses its markers', () => {
  expect(drawn('> quoted\n> more')).toEqual(['line(cm-md-quote)@1', 'hidden:> ', 'line(cm-md-quote)@2', 'hidden:> '])
})

test('a field nobody is typing in reveals nothing; a selection reveals every line it touches', () => {
  const state = stateOf('one\ntwo\nthree', EditorSelection.range(1, 9))
  expect([...revealedLines(state, false)]).toEqual([])
  expect([...revealedLines(state, true)]).toEqual([1, 2, 3])
  expect([...revealedLines(stateOf('one\ntwo', EditorSelection.cursor(5)), true)]).toEqual([2])
})
