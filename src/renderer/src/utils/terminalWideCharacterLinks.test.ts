import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { Terminal as XtermTerminal } from '@xterm/xterm'
import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION } from '../../../shared/terminal-options'
import { findTerminalFileReferences, rangeForTerminalFileReference, readWrappedLogicalLine } from './terminalFileLinks'

// Wide characters against the file-link provider.
//
// Under xterm's default Unicode 6 table an emoji is ONE column; under 11 it is
// two. Claude Code's TUI is emoji and box-drawing throughout, so switching the
// version moves nearly every wrap boundary in an agent frame — and the file-link
// provider is built on those boundaries. Two things then have to hold:
//
//   1. `readWrappedLogicalLine` must rebuild the same text xterm would render,
//      because that string is what paths are matched against.
//   2. The offsets in that string must map back to the CELLS the characters
//      came from, because that is what draws the underline and what a click is
//      resolved against. A cell is not a code unit: an emoji is 2 columns / 2
//      code units, `世` is 2 columns / 1 code unit, a blank is 1 / 1. Counting
//      characters puts the link on the wrong cells the moment a line contains a
//      CJK character.
//
// A headless terminal is a real xterm buffer built from the SHARED option block
// and the shared Unicode version, so these run against the same widths the live
// panes use.

const ROOTS = { workspaceRoot: '/repo', executionRoot: null }

function createTerminal(cols: number): Terminal {
  const terminal = new Terminal({
    ...TERMINAL_CELL_GEOMETRY_OPTIONS,
    cols,
    rows: 12,
    scrollback: 100,
  })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION
  return terminal
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()))
}

/** `readWrappedLogicalLine` wants the renderer's `Terminal`; a headless buffer
 *  is the same buffer API, and using it is the point — see the header. */
function asXterm(terminal: Terminal): XtermTerminal {
  return terminal as unknown as XtermTerminal
}

async function run(name: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

async function main(): Promise<void> {
  await run('the shared Unicode version is what a terminal actually ends up on', async () => {
    const terminal = createTerminal(40)
    assert.deepEqual([...terminal.unicode.versions], ['6', '11'])
    assert.equal(terminal.unicode.activeVersion, TERMINAL_UNICODE_VERSION)

    // The behavioural half: version 11 is what makes an emoji two columns. If
    // this ever reads 1 the whole item has silently reverted.
    await write(terminal, '🙂x')
    const line = terminal.buffer.active.getLine(0)
    assert.equal(line?.getCell(0)?.getWidth(), 2, 'an emoji must occupy two cells under Unicode 11')
    assert.equal(line?.getCell(2)?.getChars(), 'x')
    terminal.dispose()
  })

  await run('the logical line reader reproduces xterm’s own rendering of a row', async () => {
    // Pins the column-mapping walk in `readLineWithColumns` against the
    // implementation it reimplements. Blank cells, trailing blanks, wide BMP
    // characters, astral pairs and combining marks each take a different branch
    // of that loop.
    const cases = [
      'plain ascii src/a.ts:1',
      '世界 src/a.ts:1',
      '🙂🙂 src/a.ts:1',
      'a  b   c',
      'é combining src/a.ts:1',
      '   leading blanks',
      'x',
    ]
    for (const text of cases) {
      const terminal = createTerminal(60)
      await write(terminal, text)
      const line = terminal.buffer.active.getLine(0)
      assert.ok(line)
      const logical = readWrappedLogicalLine(asXterm(terminal), 1)
      assert.equal(
        logical?.text,
        line.translateToString(true),
        `logical line diverged from translateToString for ${JSON.stringify(text)}`,
      )
      terminal.dispose()
    }
  })

  await run('a link range after a wide character lands on the right cells', async () => {
    const terminal = createTerminal(60)
    // `世界` is two characters but four columns, so the path starts at column 6
    // while its offset in the rebuilt string is only 3.
    await write(terminal, '世界 src/app.ts:12 changed')
    const logical = readWrappedLogicalLine(asXterm(terminal), 1)
    assert.ok(logical)
    assert.equal(logical.text, '世界 src/app.ts:12 changed')

    const references = findTerminalFileReferences(logical.text, ROOTS)
    assert.equal(references.length, 1)
    const range = rangeForTerminalFileReference(references[0]!, logical.segments)
    assert.ok(range)

    // Read the cells the range names and confirm they really are the path.
    const line = terminal.buffer.active.getLine(0)
    assert.equal(line?.getCell(range.start.x - 1)?.getChars(), 's', 'range must start on the path')
    assert.equal(line?.getCell(range.end.x - 1)?.getChars(), '2', 'range must end on the path')
    assert.equal(range.start.x, 6)
    assert.equal(range.end.x, 6 + 'src/app.ts:12'.length - 1)
    assert.equal(range.start.y, 1)
    assert.equal(range.end.y, 1)

    // The bug this replaces: counting code units puts the underline two cells
    // to the left, on `界 `.
    assert.notEqual(range.start.x, references[0]!.startIndex + 1)
    terminal.dispose()
  })

  await run('emoji shift a link range by the columns they really occupy', async () => {
    const terminal = createTerminal(60)
    // Emoji are 2 columns AND 2 code units, so this case is only correct by
    // coincidence under the old arithmetic — it is here so a future "simplify"
    // that reintroduces character counting still fails on the CJK case above
    // rather than looking half-right.
    await write(terminal, '🙂 src/app.ts:12')
    const logical = readWrappedLogicalLine(asXterm(terminal), 1)
    assert.ok(logical)
    const references = findTerminalFileReferences(logical.text, ROOTS)
    const range = rangeForTerminalFileReference(references[0]!, logical.segments)
    assert.ok(range)
    const line = terminal.buffer.active.getLine(0)
    assert.equal(line?.getCell(range.start.x - 1)?.getChars(), 's')
    assert.equal(range.start.x, 4)
    terminal.dispose()
  })

  await run('a link on the wrapped half of a wide-character line keeps its cells', async () => {
    const cols = 20
    const terminal = createTerminal(cols)
    // Ten CJK characters fill all 20 columns exactly, so the path is pushed onto
    // the wrapped continuation row and the reader has to join two rows whose
    // column maps are different.
    await write(terminal, '世界世界世界世界世界 src/app.ts:12')

    const first = terminal.buffer.active.getLine(0)
    const second = terminal.buffer.active.getLine(1)
    assert.equal(second?.isWrapped, true, 'the row must actually be a soft wrap')
    assert.equal(first?.translateToString(false, 0, cols), '世界世界世界世界世界')

    const logical = readWrappedLogicalLine(asXterm(terminal), 2)
    assert.ok(logical)
    assert.equal(logical.text, '世界世界世界世界世界 src/app.ts:12')

    const references = findTerminalFileReferences(logical.text, ROOTS)
    assert.equal(references.length, 1)
    const range = rangeForTerminalFileReference(references[0]!, logical.segments)
    assert.ok(range)
    assert.equal(range.start.y, 2, 'the path lives on the wrapped row')
    assert.equal(range.start.x, 2, 'after the space the wrapped row starts with')
    assert.equal(second?.getCell(range.start.x - 1)?.getChars(), 's')
    assert.equal(second?.getCell(range.end.x - 1)?.getChars(), '2')
    terminal.dispose()
  })

  await run('a path split across a wide-character wrap is still one link', async () => {
    const cols = 20
    const terminal = createTerminal(cols)
    // Seven CJK characters plus a space put the path's first five characters in
    // columns 16-20 of row 1 and the rest on row 2, so the range straddles the
    // wrap and its two ends come from two different column maps.
    await write(terminal, '世界世界世界世 src/app.ts:12')
    const logical = readWrappedLogicalLine(asXterm(terminal), 1)
    assert.ok(logical)
    assert.equal(logical.text, '世界世界世界世 src/app.ts:12')

    const references = findTerminalFileReferences(logical.text, ROOTS)
    assert.equal(references.length, 1)
    const range = rangeForTerminalFileReference(references[0]!, logical.segments)
    assert.ok(range)
    assert.equal(range.start.y, 1)
    assert.equal(range.start.x, 16, 'the path starts in the last five columns of row 1')
    assert.equal(range.end.y, 2)
    assert.equal(range.end.x, 'src/app.ts:12'.length - 5)

    const first = terminal.buffer.active.getLine(0)
    const second = terminal.buffer.active.getLine(1)
    assert.equal(first?.getCell(range.start.x - 1)?.getChars(), 's')
    assert.equal(second?.getCell(range.end.x - 1)?.getChars(), '2')
    terminal.dispose()
  })
}

void main()
