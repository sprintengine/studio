import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { TERMINAL_CELL_GEOMETRY_OPTIONS, TERMINAL_UNICODE_VERSION } from '../shared/terminal-options'
import { buildReplaySnapshot, SNAPSHOT_RENDER_TAIL_UNITS, snapshotRenderTail } from './terminal-replay-snapshot'
import { test } from 'vitest'

test('terminal-replay-snapshot', async () => {
  const ESC = '\x1b'

  // Render a byte stream into a headless terminal and read back its non-empty
  // visible buffer lines — used to assert what a serialized snapshot reconstructs.
  function visibleLines(data: string, cols = 80, rows = 24): Promise<string[]> {
    return new Promise((resolve) => {
      // The same geometry block the snapshot renderer uses, or this verifier would
      // measure a stream laid out one way against a snapshot laid out another.
      const term = createPaneLikeTerminal(cols, rows)
      term.write(data, () => {
        const buffer = term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < term.rows; i++) {
          const line = buffer.getLine(i)
          if (!line) continue
          const text = line.translateToString(true).trimEnd()
          if (text.trim()) lines.push(text)
        }
        term.dispose()
        resolve(lines)
      })
    })
  }

  /**
   * A terminal built the way a LIVE PANE is built — the shared cell-geometry
   * block plus the two lines that put it on the shared Unicode version.
   *
   * `createStudioTerminal.ts` does exactly this against `@xterm/xterm` and
   * `terminal-replay-snapshot.ts` does it against `@xterm/headless`. The whole
   * point of `shared/terminal-options.ts` is that those two cannot drift, and
   * these tests are where that is checked: a verifier built any other way would
   * measure a stream laid out one way against a snapshot laid out another.
   */
  function createPaneLikeTerminal(cols: number, rows: number): Terminal {
    const term = new Terminal({
      ...TERMINAL_CELL_GEOMETRY_OPTIONS,
      cols,
      rows,
      scrollback: 1000,
    })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = TERMINAL_UNICODE_VERSION
    return term
  }

  /** Each row's text and whether it is a soft-wrap continuation — i.e. the layout
   *  the user is looking at, not just the words. */
  function rowLayout(term: Terminal): Array<{ text: string; wrapped: boolean }> {
    const buffer = term.buffer.active
    const rows: Array<{ text: string; wrapped: boolean }> = []
    for (let y = 0; y < term.rows; y += 1) {
      const line = buffer.getLine(y)
      if (!line) continue
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
    }
    return rows
  }

  /**
   * Render a stream and read back its layout. `paneWidths: false` deliberately
   * leaves the terminal on xterm's default Unicode 6 table — the negative control
   * that shows the wrap agreement below is caused by the shared version rather
   * than by the fixture being too easy.
   */
  function layoutOf(
    data: string,
    cols: number,
    rows: number,
    { paneWidths = true }: { paneWidths?: boolean } = {},
  ): Promise<Array<{ text: string; wrapped: boolean }>> {
    return new Promise((resolve) => {
      const term = paneWidths
        ? createPaneLikeTerminal(cols, rows)
        : new Terminal({ ...TERMINAL_CELL_GEOMETRY_OPTIONS, cols, rows, scrollback: 1000 })
      term.write(data, () => {
        const layout = rowLayout(term)
        term.dispose()
        resolve(layout)
      })
    })
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
    await run('reconstructs an alternate-screen TUI faithfully', async () => {
      // Enter alt-screen, clear, then position text — the exact pattern that a raw
      // replay garbles but a render+serialize snapshot must reproduce.
      const tui =
        `${ESC}[?1049h${ESC}[2J${ESC}[H` +
        `${ESC}[1;1HClaude Code` +
        `${ESC}[3;1H> waiting for your reply` +
        `${ESC}[5;1H[ tokens: 1234 ]`
      const snapshot = await buildReplaySnapshot(tui, 80, 24)
      assert.ok(snapshot, 'expected a non-null snapshot for alt-screen content')

      const reconstructed = await visibleLines(snapshot as string)
      assert.deepEqual(reconstructed, ['Claude Code', '> waiting for your reply', '[ tokens: 1234 ]'])
    })

    await run('round-trips later cursor overwrites (last paint wins)', async () => {
      // A TUI repaints the same cell region; the snapshot must reflect the final
      // state, not an earlier frame.
      const stream =
        `${ESC}[?1049h${ESC}[H` +
        `${ESC}[1;1HThinking…` +
        `${ESC}[1;1H${ESC}[K` + // clear the line
        `${ESC}[1;1HDone.`
      const snapshot = await buildReplaySnapshot(stream, 80, 24)
      assert.ok(snapshot)
      const reconstructed = await visibleLines(snapshot as string)
      assert.deepEqual(reconstructed, ['Done.'])
    })

    await run('reconstructs a plain (non-alt-screen) shell stream', async () => {
      const stream = 'line one\r\nline two\r\nline three\r\n'
      const snapshot = await buildReplaySnapshot(stream, 80, 24)
      assert.ok(snapshot)
      const reconstructed = await visibleLines(snapshot as string)
      assert.deepEqual(reconstructed, ['line one', 'line two', 'line three'])
    })

    await run('returns null for empty input so the caller falls back to raw replay', async () => {
      assert.equal(await buildReplaySnapshot('', 80, 24), null)
    })

    await run('an emoji-heavy agent frame wraps identically live and on replay', async () => {
      // The item this test exists for: under xterm's default Unicode 6 table an
      // emoji is ONE column, under 11 it is two. A snapshot rendered on a
      // different table than the pane wraps the frame somewhere else, and the
      // replayed screen looks corrupted rather than merely misconfigured.
      const cols = 24
      const rows = 10
      const frame =
        '🙂 Reading src/app.ts…\r\n' +
        '✅ 🙂 🙂 🙂 done in 12s\r\n' +
        '世界 wide text that has to wrap somewhere\r\n' +
        '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 tail\r\n'

      const live = await layoutOf(frame, cols, rows)
      const snapshot = await buildReplaySnapshot(frame, cols, rows)
      assert.ok(snapshot, 'expected a snapshot for an emoji frame')
      const replayed = await layoutOf(snapshot as string, cols, rows)

      assert.deepEqual(replayed, live, 'replayed rows must wrap exactly as the live pane did')
      // Not vacuous: the frame really does soft-wrap at this width.
      assert.ok(
        live.some((row) => row.wrapped),
        'the fixture must actually wrap',
      )
    })

    await run('the wrap agreement is the Unicode version, not a coincidence', async () => {
      // Negative control for the test above. Replay the same snapshot into a
      // terminal left on xterm's default table and the layout must come apart —
      // otherwise the previous assertion would still pass with the version
      // removed from either process.
      const cols = 24
      const rows = 10
      const frame = '🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂 tail\r\n'

      const live = await layoutOf(frame, cols, rows)
      const snapshot = await buildReplaySnapshot(frame, cols, rows)
      assert.ok(snapshot)
      const onDefaultWidths = await layoutOf(snapshot as string, cols, rows, { paneWidths: false })

      assert.notDeepEqual(
        onDefaultWidths,
        live,
        'a Unicode 6 reader must NOT reproduce a Unicode 11 layout, or this suite proves nothing',
      )
    })

    await run('clamps degenerate dimensions instead of throwing', async () => {
      const snapshot = await buildReplaySnapshot('hello', 0, 0)
      assert.ok(snapshot)
      const reconstructed = await visibleLines(snapshot as string)
      assert.deepEqual(reconstructed, ['hello'])
    })

    console.log('terminal-replay-snapshot tests passed')
  }

  const suiteRun = main()

  await suiteRun
})

// The render reads only the newest SNAPSHOT_RENDER_TAIL_UNITS of the stream.
// Cutting there must not lose the alternate screen a full-screen TUI entered
// long before the cut, or the TUI is painted onto the normal buffer.
test('the render tail re-enters an alternate screen entered before the cut', () => {
  const data = `\x1b[?1049h${'x'.repeat(SNAPSHOT_RENDER_TAIL_UNITS + 10_000)}`
  const tail = snapshotRenderTail(data)
  assert.equal(tail.cut, true)
  assert.ok(tail.text.startsWith('\x1b[?1049h'), 'the switch is put back in front of the tail')
  assert.ok(tail.text.length <= SNAPSHOT_RENDER_TAIL_UNITS + '\x1b[?1049h'.length)

  const exited = `\x1b[?1049h tui \x1b[?1049l${'y'.repeat(SNAPSHOT_RENDER_TAIL_UNITS + 10_000)}`
  assert.equal(
    snapshotRenderTail(exited).text.startsWith('\x1b['),
    false,
    'an alternate screen left again is not re-entered',
  )
})

// A stream that repaints in place can spend the whole tail on a few rows. The
// paused pane must still reopen on the scrollback it had: the render reads the
// whole stream when the tail alone comes up short.
test('a repaint-heavy stream still keeps its scrollback in the snapshot', async () => {
  let data = ''
  for (let line = 0; line < 1_500; line += 1) data += `history line ${line}\r\n`
  const spinner = '\r\x1b[2K\x1b[38;2;200;120;80m⠋ Thinking…\x1b[0m'
  while (data.length < SNAPSHOT_RENDER_TAIL_UNITS * 2) data += spinner
  const snapshot = await buildReplaySnapshot(data, 100, 30)
  assert.ok(snapshot?.includes('history line 1499'), 'the newest history line is kept')
  assert.ok(snapshot?.includes('history line 700'), 'and the scrollback above it, which the tail alone does not reach')
})
