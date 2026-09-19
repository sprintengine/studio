import assert from 'node:assert/strict'
import type { IMarker } from '@xterm/xterm'

import {
  createTerminalShellMarkTracker,
  parseTerminalShellMark,
  terminalPromptSearchAnchor,
  type TerminalShellMarkTerminal,
} from './terminalShellMarks'
import { test } from 'vitest'

test('terminalShellMarks', async () => {
  /**
   * A terminal whose cursor line the test moves by hand.
   *
   * Markers are the only thing the tracker takes from xterm, and the two
   * properties that matter are the ones this double reproduces: a marker
   * remembers the line it was made on, and a marker whose line leaves the buffer
   * reports -1 for ever afterwards.
   */
  function createFakeTerminal(): TerminalShellMarkTerminal & {
    cursorLine: number
    bufferType: 'normal' | 'alternate'
    markers: Array<{ line: number; disposed: boolean }>
    refuseMarkers: boolean
    trim: (line: number) => void
  } {
    const markers: Array<{ line: number; disposed: boolean }> = []
    const fake = {
      cursorLine: 0,
      bufferType: 'normal' as 'normal' | 'alternate',
      markers,
      refuseMarkers: false,
      buffer: {
        get active() {
          return { type: fake.bufferType }
        },
      },
      registerMarker: (): IMarker | undefined => {
        if (fake.refuseMarkers) return undefined
        const record = { line: fake.cursorLine, disposed: false }
        markers.push(record)
        return {
          id: markers.length,
          get line() {
            return record.line
          },
          isDisposed: false,
          onDispose: (() => ({ dispose: () => {} })) as unknown as IMarker['onDispose'],
          dispose: () => {
            record.disposed = true
          },
        } as IMarker
      },
      /** Everything at or above `line` scrolled out of the buffer. */
      trim: (line: number) => {
        for (const record of markers) if (record.line <= line) record.line = -1
      },
    }
    return fake
  }

  /** One full prompt→command→exit cycle, as the shells actually emit it. */
  function runCommand(
    terminal: ReturnType<typeof createFakeTerminal>,
    tracker: ReturnType<typeof createTerminalShellMarkTracker>,
    { promptLine, outputLine, status }: { promptLine: number; outputLine: number; status: string },
  ): void {
    terminal.cursorLine = promptLine
    tracker.handleOsc133('A')
    tracker.handleOsc133('B')
    terminal.cursorLine = outputLine
    tracker.handleOsc133('C')
    tracker.handleOsc133(`D;${status}`)
  }

  function testTheFourMarksParse(): void {
    assert.deepEqual(parseTerminalShellMark('A'), { kind: 'prompt-start' })
    assert.deepEqual(parseTerminalShellMark('B'), { kind: 'prompt-end' })
    assert.deepEqual(parseTerminalShellMark('C'), { kind: 'command-start' })
    assert.deepEqual(parseTerminalShellMark('D;0'), { kind: 'command-end', exitCode: 0 })
    assert.deepEqual(parseTerminalShellMark('D;130'), { kind: 'command-end', exitCode: 130 })

    // Emitters attach their own parameters to every mark; extra fields are not a
    // reason to drop a sequence we understand the front of.
    assert.deepEqual(parseTerminalShellMark('A;aid=7'), { kind: 'prompt-start' })
    assert.deepEqual(parseTerminalShellMark('D;1;err=boom'), { kind: 'command-end', exitCode: 1 })

    // A D with no status is the shell saying it does not know.
    assert.deepEqual(parseTerminalShellMark('D'), { kind: 'command-end', exitCode: null })
    assert.deepEqual(parseTerminalShellMark('D;'), { kind: 'command-end', exitCode: null })
  }

  // The payload is printable by anything holding a pane — every agent CLI, every
  // file one of them `cat`s. Every shape below has to come back as "not a mark"
  // or "no status", never as a value or a throw.
  function testAHostilePayloadIsIgnoredRatherThanBelieved(): void {
    for (const payload of [
      '',
      ';',
      'P;Cwd=/etc',
      'a',
      'AA',
      'A ',
      ' A',
      'Å',
      '0',
      'D2',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      assert.equal(parseTerminalShellMark(payload), null, `refused: ${JSON.stringify(payload)}`)
    }

    for (const status of [
      '-1',
      '+1',
      ' 1',
      '1 ',
      '1.0',
      '1e3',
      '0x10',
      'NaN',
      'Infinity',
      '99999999999',
      '<script>',
      '\u0000',
    ]) {
      assert.deepEqual(
        parseTerminalShellMark(`D;${status}`),
        { kind: 'command-end', exitCode: null },
        `no status from ${JSON.stringify(status)}`,
      )
    }

    // The prototype-chain shapes above are not decoration: keyed lookup answers
    // `__proto__`, `constructor` and `toString` with something truthy off
    // Object.prototype, and the first version of the parser did exactly that.
    assert.equal(parseTerminalShellMark('valueOf'), null)
    assert.equal(parseTerminalShellMark('hasOwnProperty'), null)
  }

  function testACycleRecordsWhereItRanAndWhatItReturned(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    runCommand(terminal, tracker, { promptLine: 10, outputLine: 11, status: '0' })
    runCommand(terminal, tracker, { promptLine: 20, outputLine: 21, status: '1' })

    assert.deepEqual(tracker.finishedCommands(), [
      { promptLine: 10, promptEndLine: 10, outputLine: 11, exitCode: 0 },
      { promptLine: 20, promptEndLine: 20, outputLine: 21, exitCode: 1 },
    ])
    assert.deepEqual(tracker.promptLines(), [10, 20])
    tracker.dispose()
  }

  // bash's `PROMPT_COMMAND` fires on a bare Enter and before the very first
  // prompt, so a D with no C in front of it is the common case — and believing it
  // would pin the LAST command's status onto a command nobody ran.
  function testADWithNoCIsNotACommand(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    // The first prompt: bash emits D;0 before there has been anything to finish.
    tracker.handleOsc133('D;0')
    assert.deepEqual(tracker.finishedCommands(), [], 'nothing was open')

    runCommand(terminal, tracker, { promptLine: 5, outputLine: 6, status: '2' })

    // A bare Enter: prompt, prompt end, then straight to D carrying the STALE
    // status of the command before it.
    terminal.cursorLine = 7
    tracker.handleOsc133('A')
    tracker.handleOsc133('B')
    tracker.handleOsc133('D;2')

    assert.deepEqual(
      tracker.finishedCommands(),
      [{ promptLine: 5, promptEndLine: 5, outputLine: 6, exitCode: 2 }],
      'the bare Enter added nothing, and did not re-close the command before it',
    )
    assert.deepEqual(tracker.promptLines(), [5, 7], 'the prompt itself is still navigable')
  }

  function testRepeatedMarksNeverMoveABoundary(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    terminal.cursorLine = 3
    tracker.handleOsc133('A')
    tracker.handleOsc133('B')
    terminal.cursorLine = 4
    tracker.handleOsc133('C')
    // Everything below arrives after the command started and must change nothing.
    terminal.cursorLine = 99
    tracker.handleOsc133('B')
    tracker.handleOsc133('C')
    tracker.handleOsc133('D;7')
    tracker.handleOsc133('D;0')
    tracker.handleOsc133('D;0')

    assert.deepEqual(
      tracker.finishedCommands(),
      [{ promptLine: 3, promptEndLine: 3, outputLine: 4, exitCode: 7 }],
      'the first D closes it; a second cannot rewrite the status',
    )
  }

  // A full-screen application owns the alternate buffer, and a marker registered
  // against it points at a line that ceases to exist when the app exits.
  function testTheAlternateBufferIsNotAPrompt(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    terminal.bufferType = 'alternate'
    for (const payload of ['A', 'B', 'C', 'D;0']) assert.equal(tracker.handleOsc133(payload), true)
    assert.deepEqual(tracker.promptLines(), [])
    assert.equal(terminal.markers.length, 0, 'no markers were registered at all')

    terminal.bufferType = 'normal'
    runCommand(terminal, tracker, { promptLine: 2, outputLine: 3, status: '0' })
    assert.deepEqual(tracker.promptLines(), [2])
  }

  // xterm hands back `undefined` rather than a marker for a disposed terminal;
  // the tracker has to stay usable rather than record a prompt it cannot find.
  function testARefusedMarkerIsNotAPrompt(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    terminal.refuseMarkers = true
    runCommand(terminal, tracker, { promptLine: 1, outputLine: 2, status: '0' })
    assert.deepEqual(tracker.promptLines(), [])
    assert.deepEqual(tracker.finishedCommands(), [])

    terminal.refuseMarkers = false
    runCommand(terminal, tracker, { promptLine: 8, outputLine: 9, status: '0' })
    assert.deepEqual(tracker.promptLines(), [8])
  }

  function testNavigationFindsTheNearestPromptOnEachSide(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    for (const line of [10, 20, 30]) {
      terminal.cursorLine = line
      tracker.handleOsc133('A')
    }

    assert.equal(tracker.previousPromptLine(25), 20)
    assert.equal(tracker.previousPromptLine(20), 10, 'strictly above, so a second press keeps moving')
    assert.equal(tracker.previousPromptLine(10), null, 'nothing above the first prompt')
    assert.equal(tracker.nextPromptLine(10), 20)
    assert.equal(tracker.nextPromptLine(30), null)
    assert.equal(tracker.nextPromptLine(-1), 10, 'the top of the buffer still finds the first prompt')
  }

  // Scrollback is finite: a marker whose line is trimmed reports -1, and -1 is
  // not a line anyone can be scrolled to.
  function testTrimmedPromptsStopBeingNavigable(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    for (const line of [10, 20, 30]) {
      terminal.cursorLine = line
      tracker.handleOsc133('A')
    }
    terminal.trim(20)

    assert.deepEqual(tracker.promptLines(), [30])
    assert.equal(tracker.previousPromptLine(35), 30)
    assert.equal(tracker.previousPromptLine(30), null, 'the trimmed prompts are gone, not at line -1')
  }

  // The payload is printable by anything in the pane, so an unbounded stream of
  // prompt starts is a memory-growth primitive unless the oldest fall off.
  function testPromptsAreBounded(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    for (let line = 0; line < 5_000; line += 1) {
      terminal.cursorLine = line
      tracker.handleOsc133('A')
    }

    const lines = tracker.promptLines()
    assert.equal(lines.length, 512)
    assert.equal(lines[lines.length - 1], 4_999, 'the newest prompts are the ones kept')
    assert.equal(
      terminal.markers.filter((marker) => !marker.disposed).length,
      512,
      'an evicted prompt has its marker disposed, not merely dropped',
    )
  }

  function testDisposeReleasesEveryMarker(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)

    runCommand(terminal, tracker, { promptLine: 1, outputLine: 2, status: '0' })
    runCommand(terminal, tracker, { promptLine: 3, outputLine: 4, status: '0' })
    assert.equal(terminal.markers.length, 6, 'three markers per cycle: A, B, C')

    tracker.dispose()
    assert.equal(
      terminal.markers.every((marker) => marker.disposed),
      true,
    )
    assert.deepEqual(tracker.promptLines(), [])
    assert.deepEqual(tracker.finishedCommands(), [])
  }

  // Whatever arrives, the handler claims the sequence: nothing else in the app
  // wants OSC 133, and returning false would only put it back on xterm's floor.
  function testEveryPayloadIsClaimed(): void {
    const terminal = createFakeTerminal()
    const tracker = createTerminalShellMarkTracker(terminal)
    for (const payload of ['A', 'B', 'C', 'D;0', 'D;nonsense', 'P;Cwd=/etc', '', '\u0000']) {
      assert.equal(tracker.handleOsc133(payload), true, `claimed: ${JSON.stringify(payload)}`)
    }
  }

  // `scrollToLine` clamps at the bottom of the buffer, so a jump into the last
  // screenful lands short of its target. Searching from the viewport again would
  // then find the same prompt every time — Next would stop moving.
  function testTheSearchAnchorSurvivesAClampedJump(): void {
    const anchor = (lastJumpLine: number | null, viewportY: number): number =>
      terminalPromptSearchAnchor({ viewportY, rows: 24, lastJumpLine })

    assert.equal(anchor(null, 100), 100, 'with no jump behind it, the viewport is the anchor')
    assert.equal(anchor(105, 102), 105, 'the clamped jump still aimed at 105, so Next resumes from there')
    assert.equal(anchor(105, 105), 105, 'an unclamped jump agrees with the viewport')
    assert.equal(anchor(105, 400), 400, 'a scroll that left the target behind drops the stale aim')
    assert.equal(anchor(105, 60), 60, 'the target is below the viewport bottom, so it is not the anchor')
    assert.equal(anchor(80, 100), 100, 'a target above the viewport is stale too')
    assert.equal(
      terminalPromptSearchAnchor({ viewportY: 5, rows: 0, lastJumpLine: 5 }),
      5,
      'a zero-row terminal still answers rather than dividing the viewport by nothing',
    )
  }

  testTheFourMarksParse()
  testTheSearchAnchorSurvivesAClampedJump()
  testAHostilePayloadIsIgnoredRatherThanBelieved()
  testACycleRecordsWhereItRanAndWhatItReturned()
  testADWithNoCIsNotACommand()
  testRepeatedMarksNeverMoveABoundary()
  testTheAlternateBufferIsNotAPrompt()
  testARefusedMarkerIsNotAPrompt()
  testNavigationFindsTheNearestPromptOnEachSide()
  testTrimmedPromptsStopBeingNavigable()
  testPromptsAreBounded()
  testDisposeReleasesEveryMarker()
  testEveryPayloadIsClaimed()

  console.log('ok - terminalShellMarks')
})
