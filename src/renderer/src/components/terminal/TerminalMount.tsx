import { forwardRef } from 'react'

/**
 * The element an xterm is opened into — deliberately its own box, with no
 * padding of its own, sitting inside the pane's padded chrome container.
 *
 * This exists because of how `@xterm/addon-fit` measures the space it may
 * use. `FitAddon.proposeDimensions()` reads
 * `getComputedStyle(terminal.element.parentElement).height` and subtracts only
 * the padding of `terminal.element` (`.xterm`, which has none) — never the
 * parent's. That is correct ONLY if the parent's computed height is its
 * content box.
 *
 * Under `box-sizing: border-box` — Tailwind's preflight default, so every
 * element in this app — Chromium resolves `getComputedStyle(el).height` to the
 * BORDER box. So a terminal opened straight into the pane's `p-2 pb-4`
 * container had its rows and columns computed against the full pane, padding
 * included: `rows = floor(paneHeight / cellHeight)`. The rendered grid then
 * started one padding-top (8px) down and ran 8px past the bottom of the pane,
 * where `overflow-hidden` sliced it off. Whether that showed depended purely
 * on the leftover `paneHeight % cellHeight`: with less than 8px of slack the
 * CLI's bottom row — Codex's model/branch status line, Claude Code's
 * permissions line — was drawn cut in half. Measured against this xterm build,
 * a 900px-wide pane sliced its bottom row at heights of 300-307px and 517px
 * and got away with it at 400px and 640px: the same window, a different tab
 * height, and the bug appears or does not. Columns overran the side gutters by
 * the same 8px but never showed it, because `proposeDimensions` happens to
 * subtract a scrollbar width from the available WIDTH and that covered it.
 *
 * The pane's `pb-4` was an attempt at this and could never have worked:
 * padding the fit does not read is padding that changes nothing.
 *
 * Opening into a box whose border box IS its content box makes the measurement
 * true again under any `box-sizing`, which is why this is a separate element
 * rather than a `box-content` class on the container: a later `h-full` there,
 * or a stray `box-border`, would quietly bring the clipping back.
 *
 * Sized with `h-full w-full` — percentages resolve against the container's
 * CONTENT box, so this is exactly the space inside the padding. It must not be
 * `absolute inset-0`: an absolutely positioned child is laid out against its
 * containing block's PADDING box, which would hand back the full pane and
 * restore the bug.
 */
export const TerminalMount = forwardRef<HTMLDivElement>(function TerminalMount(_props, ref) {
  return <div ref={ref} className="h-full w-full" />
})
