import assert from 'node:assert/strict'
import { Terminal } from '@xterm/headless'
import { buildReplaySnapshot } from './terminal-replay-snapshot'

const ESC = '\x1b'

// Render a byte stream into a headless terminal and read back its non-empty
// visible buffer lines — used to assert what a serialized snapshot reconstructs.
function visibleLines(data: string, cols = 80, rows = 24): Promise<string[]> {
  return new Promise((resolve) => {
    const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 })
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

  await run('clamps degenerate dimensions instead of throwing', async () => {
    const snapshot = await buildReplaySnapshot('hello', 0, 0)
    assert.ok(snapshot)
    const reconstructed = await visibleLines(snapshot as string)
    assert.deepEqual(reconstructed, ['hello'])
  })

  console.log('terminal-replay-snapshot tests passed')
}

void main()
