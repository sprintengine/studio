import type { IMarker } from '@xterm/xterm'

/**
 * OSC 133 — the shell telling the terminal where its prompt begins and ends,
 * where a command started running, and what it exited with.
 *
 * `ESC ] 133 ; A ST` prompt start, `;B` prompt end, `;C` pre-execution,
 * `;D` or `;D;<status>` command finished. Our own shell integration emits all
 * four (`terminal-launch.ts`), for `shell` panes only.
 *
 * **This is not a status source for agents, and must never become one.** Agent
 * phase comes from `agent-state.ts` over the state socket — decision of record
 * 2026-08-31, hooks only — and the marks here are armed for a plain shell
 * alone. What they buy is shell ergonomics: prompt boundaries you can jump
 * between, and a per-command exit status. Nothing in this module writes to a
 * store, and nothing outside a `shell` pane reads it.
 *
 * Like every other OSC payload, this one is attacker-controlled: any program
 * with a pane can print it, which in this app includes every agent CLI and
 * every file one of them `cat`s. So the parser is total and strict — an
 * unrecognised mark, a non-numeric status, a status with a sign or an exponent
 * are all simply not a mark — and the tracker below never allocates without
 * bound no matter what it is fed.
 */

export type TerminalShellMark =
  | { kind: 'prompt-start' }
  | { kind: 'prompt-end' }
  | { kind: 'command-start' }
  | { kind: 'command-end'; exitCode: number | null }

/**
 * The mark a payload carries, or null when it carries none.
 *
 * The payload is what xterm hands an OSC 133 handler: everything after
 * `133;`. Emitters in the wild append `key=value` parameters to any of the
 * four marks (`A;aid=7`, `D;0;err=…`), so extra fields are ignored rather than
 * treated as malformed — but the FIRST field has to be exactly one letter we
 * know, which is what keeps iTerm2's `133;P` (a different feature entirely)
 * from being read as a prompt.
 */
export function parseTerminalShellMark(data: string): TerminalShellMark | null {
  const fields = data.split(';')
  // A switch, not a lookup table: `data` is attacker-controlled, and an object
  // keyed by it answers `__proto__`, `constructor` and `toString` with
  // something truthy off Object.prototype. That is a real payload — the first
  // version of this function had it, and `terminalShellMarks.test.ts` failed on
  // exactly those three strings.
  switch (fields[0]) {
    case 'A':
      return { kind: 'prompt-start' }
    case 'B':
      return { kind: 'prompt-end' }
    case 'C':
      return { kind: 'command-start' }
    case 'D':
      return { kind: 'command-end', exitCode: parseExitCode(fields[1]) }
    default:
      return null
  }
}

/**
 * The exit status a `133;D` reported, or null when it reported none we believe.
 *
 * Digits only, and at most ten of them. A shell's `$?` is 0–255, but emitters
 * that pass a raw waitpid status or a Windows exit code send larger values, so
 * the range is left wide and only the SHAPE is enforced — `-1`, `1e3`, `0x10`,
 * ` 1`, `1.0` and a megabyte of digits are each "no status", not a status. An
 * absent field (`133;D`) is the shell saying it does not know, which is the
 * same answer.
 */
function parseExitCode(field: string | undefined): number | null {
  if (field === undefined || !/^[0-9]{1,10}$/u.test(field)) return null
  const code = Number(field)
  return Number.isSafeInteger(code) ? code : null
}

/** A command the shell ran between two prompts, once it has finished. */
export type TerminalShellCommand = {
  /** Buffer line the prompt it was typed at begins on; -1 once that line has scrolled out. */
  promptLine: number
  /** Buffer line the prompt ends on (`133;B`), or null when none arrived. */
  promptEndLine: number | null
  /** Buffer line its output begins on, or null when no `133;C` arrived. */
  outputLine: number | null
  /** What the shell said it exited with, or null when it said nothing usable. */
  exitCode: number | null
}

/**
 * The slice of xterm this module touches.
 *
 * Narrow on purpose: a tracker that could reach the whole terminal would be
 * one edit away from writing to it, and nothing here should ever write. The
 * `IMarker | undefined` return is xterm's real behaviour rather than its
 * typing — `registerMarker` returns undefined on the alternate buffer and for
 * a disposed terminal — so the guard is forced by the type.
 */
export type TerminalShellMarkTerminal = {
  registerMarker: (cursorYOffset?: number) => IMarker | undefined
  readonly buffer: { readonly active: { readonly type: 'normal' | 'alternate' } }
}

/**
 * How many prompts are remembered.
 *
 * A bound rather than a tuning knob: the marks are printable by anything in the
 * pane, so a stream of `133;A` is a memory-growth primitive unless the oldest
 * entries fall off. 512 is comfortably more prompts than a scrollback of
 * `TERMINAL_RECENT_SCROLLBACK_LINES` can hold anyway, so nothing a real shell
 * produces is ever evicted early.
 */
const MAX_TRACKED_PROMPTS = 512

type PromptBlock = {
  promptStart: IMarker
  promptEnd: IMarker | null
  commandStart: IMarker | null
  exitCode: number | null
  finished: boolean
}

export type TerminalShellMarkTracker = {
  /**
   * The OSC 133 handler, for the factory's `oscHandlers` slot. Always returns
   * true: nothing else in the app wants OSC 133, and reporting it unhandled
   * would only put the sequence back on xterm's floor.
   */
  handleOsc133: (data: string) => boolean
  /** Every live prompt's buffer line, ascending. */
  promptLines: () => number[]
  /** The nearest prompt above `fromLine`, or null when there is none. */
  previousPromptLine: (fromLine: number) => number | null
  /** The nearest prompt below `fromLine`, or null when there is none. */
  nextPromptLine: (fromLine: number) => number | null
  /** The commands that have finished, oldest first. */
  finishedCommands: () => TerminalShellCommand[]
  dispose: () => void
}

export function createTerminalShellMarkTracker(
  terminal: TerminalShellMarkTerminal,
): TerminalShellMarkTracker {
  const blocks: PromptBlock[] = []

  const currentBlock = (): PromptBlock | null => {
    const block = blocks.at(-1)
    return block && !block.finished ? block : null
  }

  const openPrompt = (): void => {
    const marker = terminal.registerMarker()
    if (!marker) return
    blocks.push({ promptStart: marker, promptEnd: null, commandStart: null, exitCode: null, finished: false })
    while (blocks.length > MAX_TRACKED_PROMPTS) disposeBlock(blocks.shift())
  }

  const markCurrent = (field: 'promptEnd' | 'commandStart'): void => {
    const block = currentBlock()
    // Already set wins: our own shell emits each mark once per prompt, so a
    // second one is either a theme printing twice or something hostile, and
    // MOVING the boundary is how a command's output would come to be reported
    // as starting after it ended.
    if (!block || block[field]) return
    const marker = terminal.registerMarker()
    if (marker) block[field] = marker
  }

  const finishCurrent = (exitCode: number | null): void => {
    const block = currentBlock()
    // No `133;C` means nothing ran between the two prompts. bash emits a D on
    // the very first prompt and on every bare Enter — `PROMPT_COMMAND` runs
    // either way and has no way to tell whether a command happened — and zsh
    // suppresses those with a flag its own hook keeps. This is the same rule
    // applied where it cannot be bypassed: the marks arrive from a pty, not
    // from a function we control. Recording one would attribute the previous
    // command's status to a command that never ran.
    if (!block || !block.commandStart) return
    block.exitCode = exitCode
    block.finished = true
  }

  const livePromptLines = (): number[] =>
    blocks
      .map((block) => block.promptStart.line)
      // A marker whose line scrolled out of the buffer reports -1 forever
      // after; the block stays in the list until it is evicted, but it names no
      // line anyone can scroll to.
      .filter((line) => line >= 0)
      .sort((a, b) => a - b)

  return {
    handleOsc133: (data) => {
      const mark = parseTerminalShellMark(data)
      if (!mark) return true
      // The alternate buffer is a full-screen application's canvas — vim, less,
      // a TUI — not a prompt, and a marker registered against it points at a
      // line that vanishes when the app exits. Our shell never emits there;
      // anything that does is not describing a shell.
      if (terminal.buffer.active.type === 'alternate') return true

      switch (mark.kind) {
        case 'prompt-start':
          openPrompt()
          break
        case 'prompt-end':
          markCurrent('promptEnd')
          break
        case 'command-start':
          markCurrent('commandStart')
          break
        case 'command-end':
          finishCurrent(mark.exitCode)
          break
      }
      return true
    },
    promptLines: livePromptLines,
    previousPromptLine: (fromLine) => {
      const above = livePromptLines().filter((line) => line < fromLine)
      return above.length > 0 ? above[above.length - 1] : null
    },
    nextPromptLine: (fromLine) => livePromptLines().find((line) => line > fromLine) ?? null,
    finishedCommands: () =>
      blocks
        .filter((block) => block.finished)
        .map((block) => ({
          promptLine: block.promptStart.line,
          promptEndLine: block.promptEnd?.line ?? null,
          outputLine: block.commandStart?.line ?? null,
          exitCode: block.exitCode,
        })),
    dispose: () => {
      for (const block of blocks) disposeBlock(block)
      blocks.length = 0
    },
  }
}

/**
 * The line a prompt jump should search from.
 *
 * Normally the top of the viewport, because navigating prompts is navigating
 * what you are LOOKING at. The exception is the bottom page: `scrollToLine`
 * clamps at `baseY`, so a jump to a prompt inside the last screenful leaves the
 * viewport short of its target and searching from the viewport again would find
 * the same prompt for ever — press Next twice and nothing moves. Remembering
 * where the last jump was AIMED fixes that, and the visibility test is what
 * stops a stale aim surviving a scroll the user did themselves: once the target
 * is off screen, the viewport is the honest answer again.
 */
export function terminalPromptSearchAnchor({
  viewportY,
  rows,
  lastJumpLine,
}: {
  viewportY: number
  rows: number
  lastJumpLine: number | null
}): number {
  if (lastJumpLine === null) return viewportY
  const visible = lastJumpLine >= viewportY && lastJumpLine < viewportY + Math.max(rows, 1)
  return visible ? Math.max(lastJumpLine, viewportY) : viewportY
}

function disposeBlock(block: PromptBlock | undefined): void {
  block?.promptStart.dispose()
  block?.promptEnd?.dispose()
  block?.commandStart?.dispose()
}
