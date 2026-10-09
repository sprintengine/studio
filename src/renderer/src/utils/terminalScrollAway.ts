import type { IDisposable, IEvent } from '@xterm/xterm'

/**
 * Whether a terminal's viewport has been scrolled up away from its newest
 * output — the condition the pane's "Jump to latest" control is shown for.
 *
 * A pane scrolled up keeps its place while output keeps arriving below, which
 * is what reading back through a build log needs, and also how a person loses
 * track of the fact that the program has moved on. The control says so and
 * takes them back in one click.
 *
 * Kept free of a real xterm so plain-Node tests can drive it: the terminal is
 * the handful of members this reads, typed structurally.
 */

/** The parts of `term.buffer.active` the rule reads. */
export type TerminalScrollBuffer = {
  readonly type: 'normal' | 'alternate'
  /** The buffer line at the top of the viewport. */
  readonly viewportY: number
  /** The buffer line at the top of the bottom page — where the viewport sits when it follows output. */
  readonly baseY: number
}

/**
 * The rule. The alternate screen never counts: a full-screen program (an
 * editor, a pager, an agent CLI drawing its own interface) has no scrollback
 * of the terminal's to be away from, and a control floated over the interface
 * it draws would sit on top of that program's own chrome.
 */
export function isTerminalScrolledAway(buffer: TerminalScrollBuffer): boolean {
  return buffer.type === 'normal' && buffer.viewportY < buffer.baseY
}

export type TerminalScrollAwayTerminal = {
  readonly buffer: {
    readonly active: TerminalScrollBuffer
    readonly onBufferChange: IEvent<unknown>
  }
  readonly onScroll: IEvent<number>
  readonly onWriteParsed: IEvent<void>
  readonly onResize: IEvent<{ cols: number; rows: number }>
}

/**
 * Calls `onChange` each time `isTerminalScrolledAway` flips, and only then.
 *
 * The events are the ones that can move either side of the comparison: a
 * scroll moves the viewport; output that arrives while the person is scrolled
 * up moves the bottom away from them without scrolling anything (and a `clear`
 * brings it back); a resize reflows both; and a switch to or from the
 * alternate screen changes which buffer is asked. `onWriteParsed` fires at
 * most once a frame however much is written, and the check is two reads and a
 * compare, so following a busy pane costs nothing — and React only hears about
 * a flip, never about each chunk of output.
 */
export function watchTerminalScrolledAway(
  terminal: TerminalScrollAwayTerminal,
  onChange: (scrolledAway: boolean) => void,
): IDisposable {
  let scrolledAway = isTerminalScrolledAway(terminal.buffer.active)
  const check = (): void => {
    const next = isTerminalScrolledAway(terminal.buffer.active)
    if (next === scrolledAway) return
    scrolledAway = next
    onChange(next)
  }
  const disposables = [
    terminal.onScroll(check),
    terminal.onWriteParsed(check),
    terminal.onResize(check),
    terminal.buffer.onBufferChange(check),
  ]
  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose()
    },
  }
}
