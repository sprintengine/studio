import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import { CheckboxBox } from '../ui/Checkbox'
import { FOCUS_RING_CLASS } from '../ui/tokens'
import type { HunkBox } from './hunkGutterModel'

// The per-hunk include boxes in Monaco's glyph margin — git-commit-window T7,
// mockup 2522 panel 4.
//
// **Glyph margin WIDGETS, not glyph margin decorations.** A decoration is a CSS
// class Monaco hangs on a node it owns; there is nowhere on it to put a role,
// an accessible name or a checked state, so a decoration-based box would be a
// picture a screen reader never meets. A widget is a DOM node this file
// creates, which is why the box can be a real `role="checkbox"` with the kit's
// drawing inside it — `CheckboxBox`, at 13px, the same square the header strip
// and the Git panel draw.
//
// **The modified editor only.** Monaco draws one editor in unified view and two
// in side-by-side, and the modified one is the editor present in both. Putting
// every box there means the gutter is the same gutter in either view rather
// than half of it vanishing with the layout. A pure deletion has no line on the
// modified side, so its box sits on the last surviving line above the gap
// (`hunkGutterLine`) — beside the removed text in unified view, and beside the
// gap it left in side-by-side.
//
// **React through a portal.** The widget's node is Monaco's to position and
// React's to fill: the effect below creates and destroys the nodes, and the
// portals render into them, so a box changing from empty to ticked is a React
// update and not a widget churn. Monaco is touched only when a hunk MOVES.

/** The slice of Monaco's editor this file uses — narrow enough to fake. */
export type GlyphMarginHost = {
  addGlyphMarginWidget(widget: GlyphMarginWidget): void
  removeGlyphMarginWidget(widget: GlyphMarginWidget): void
}

export type GlyphMarginWidget = {
  getId(): string
  getDomNode(): HTMLElement
  getPosition(): { lane: number; range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; zIndex: number }
}

/** Monaco's `GlyphMarginLane.Center`. Passed in rather than imported so this
 *  file needs no Monaco at module scope — and so a test can drive it. */
export const GLYPH_MARGIN_LANE_CENTER = 2

export function HunkGutter({
  editor,
  boxes,
  lane = GLYPH_MARGIN_LANE_CENTER,
  onToggle,
}: {
  /** The MODIFIED editor. Null until Monaco mounts, and after it is disposed. */
  editor: GlyphMarginHost | null
  boxes: HunkBox[]
  lane?: number
  onToggle: (index: number) => void
}): JSX.Element | null {
  const [nodes, setNodes] = useState<Map<number, HTMLElement>>(() => new Map())

  // Where every box is, as one string. The widgets are rebuilt when a hunk
  // moves — staging one hunk shifts every hunk under it — and never when only
  // its state changed, which is the portal's job.
  const layout = boxes.map((box) => `${box.index}@${box.line}`).join(',')

  useEffect(() => {
    if (!editor) {
      setNodes((current) => (current.size === 0 ? current : new Map()))
      return
    }
    const created = boxes.map((box) => {
      const domNode = document.createElement('div')
      domNode.className = 'flex h-full w-full items-center justify-center'
      const widget: GlyphMarginWidget = {
        getId: () => `multicode.hunk-include.${box.index}`,
        getDomNode: () => domNode,
        getPosition: () => ({
          lane,
          range: {
            startLineNumber: box.line,
            startColumn: 1,
            endLineNumber: box.line,
            endColumn: 1,
          },
          zIndex: 10,
        }),
      }
      editor.addGlyphMarginWidget(widget)
      return { index: box.index, domNode, widget }
    })
    setNodes(new Map(created.map((entry) => [entry.index, entry.domNode])))
    return () => {
      for (const entry of created) {
        // The editor may already be gone — a file switch that disposed it, the
        // window closing — and asking a disposed editor to forget a widget it
        // has already forgotten must not take the unmount down with it.
        try {
          editor.removeGlyphMarginWidget(entry.widget)
        } catch {
          // Nothing to do: the widget went with the editor.
        }
      }
      setNodes(new Map())
    }
    // `boxes` is rebuilt every render; `layout` is the part of it Monaco cares
    // about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, lane, layout])

  if (nodes.size === 0) return null
  return (
    <>
      {boxes.map((box) => {
        const node = nodes.get(box.index)
        if (!node) return null
        return createPortal(<HunkIncludeBox box={box} onToggle={onToggle} />, node, `hunk-${box.index}`)
      })}
    </>
  )
}

/**
 * One box.
 *
 * A `role="checkbox"` span rather than the kit's `Checkbox`, for the reason
 * `CheckboxBox` was extracted in the first place: the kit's control brings a
 * `<label>` wrapper and a real `<input>` with it, and this node lives inside a
 * widget Monaco creates, moves and reparents as the file scrolls. What survives
 * that is a single element carrying the name, the state and the click — so the
 * span IS the control, and `CheckboxBox` is the picture of it, `aria-hidden` as
 * it always is.
 *
 * Keyboard: Space and Enter, the two keys a checkbox answers to. The viewer's
 * own arrow keys are untouched — a box in the margin must not become a second
 * hunk stepper.
 */
function HunkIncludeBox({ box, onToggle }: { box: HunkBox; onToggle: (index: number) => void }): JSX.Element {
  const toggle = (): void => {
    if (!box.busy) onToggle(box.index)
  }
  return (
    <span
      role="checkbox"
      tabIndex={box.busy ? -1 : 0}
      aria-checked={box.checked}
      aria-label={box.label}
      aria-disabled={box.busy || undefined}
      data-hunk-index={box.index}
      className={`flex size-icon-xs cursor-pointer items-center justify-center ${FOCUS_RING_CLASS} aria-disabled:cursor-progress`}
      // Monaco reads mousedown in the margin as "select this line"; the box is
      // a control sitting on top of the gutter, not a place in the text.
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        event.stopPropagation()
        toggle()
      }}
    >
      {/* The kit's box is drawn at 16px and this gutter is 13px wide, so the
          drawing is SCALED rather than redrawn — a second checkbox with its own
          border radius and its own tick is exactly what CheckboxBox exists to
          prevent (components/ui/Checkbox.tsx). */}
      <span className="pointer-events-none flex items-center justify-center [&>span]:scale-[0.8125]">
        <CheckboxBox checked={box.checked} />
      </span>
    </span>
  )
}
