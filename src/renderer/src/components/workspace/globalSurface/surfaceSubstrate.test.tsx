import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'

import type { SurfaceRailRow } from './surfaceSubstrate'

// MC-2098 — the rail's leading icon slot is the SUBSTRATE's contract, not the
// door's. Every door rail shares the same scrollport inset and the same row
// padding/gap, so a row title's x-offset reduces to
// `10 (scrollport) + 8 (row pad) + iconWidth + 8 (gap)`. Before this, iconWidth
// was whatever the door handed over — 16px on Sprints/Roadmap/Automations, 13px
// on Extensions' bare `icon-xs` svgs, 12px on Design's identity chip — so
// opening a different door in the SAME physical column slid every row title
// between 38px and 42px. One column, three left edges.
//
// The failure is invisible to a per-door suite: each rail is internally
// consistent and looks correct on its own. It only exists BETWEEN doors, which
// is why the claims below compare two rails against each other rather than
// checking one against a number.
//
// jsdom applies no stylesheet, so "same x-offset" cannot be measured as pixels
// here. The provable form is structural and is in fact the stronger claim: the
// slot element is identical across doors and its width comes from the icon ramp
// token, so no door CAN move the title — rather than merely happening not to
// today at the sizes currently shipped.

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost',
  pretendToBeVisual: true,
})

const anyGlobal = globalThis as unknown as Record<string, unknown>
const domWindow = dom.window as unknown as Record<string, unknown>
anyGlobal.window = domWindow
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.HTMLInputElement = dom.window.HTMLInputElement
anyGlobal.HTMLTextAreaElement = dom.window.HTMLTextAreaElement
anyGlobal.Node = dom.window.Node
anyGlobal.MouseEvent = dom.window.MouseEvent
anyGlobal.KeyboardEvent = dom.window.KeyboardEvent
anyGlobal.getComputedStyle = dom.window.getComputedStyle
anyGlobal.localStorage = dom.window.localStorage
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
  addListener: () => {},
  removeListener: () => {},
})) as unknown as typeof dom.window.matchMedia
class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
anyGlobal.ResizeObserver = NoopResizeObserver
dom.window.ResizeObserver = NoopResizeObserver as unknown as typeof dom.window.ResizeObserver
domWindow.api = { platform: 'darwin' }

async function main(): Promise<void> {
  const React = await import('react')
  const { act } = React
  const { createRoot } = await import('react-dom/client')
  const { SurfaceRail } = await import('./surfaceSubstrate')

  const document = dom.window.document

  function mount(node: React.ReactNode): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(node)
    })
    return {
      container: container as unknown as HTMLElement,
      unmount: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  /** A rail carrying whatever glyph a door would hand it. */
  function railWith(icon: React.ReactNode | undefined, id = 'a'): React.ReactNode {
    const rows: SurfaceRailRow[] = [{ id, title: 'A row', stateLine: 'a state line', icon }]
    return (
      <SurfaceRail
        label="Door"
        rows={rows}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New thing', onActivate: () => undefined }}
      />
    )
  }

  const slotOf = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[data-rail-icon-slot="true"]')

  // ── 1. two doors, two glyph sizes, one slot ────────────────────────────────
  // The Design door's 12px identity chip and the Sprints door's 16px lifecycle
  // glyph are both legitimate — MC-2098 explicitly lets a door keep its own mark
  // size. What must not differ is the box they sit in.

  {
    // Design's chip: a 12px rounded square.
    const design = mount(railWith(<span className="size-3 shrink-0 rounded-[3px]" />))
    // Sprints' lifecycle glyph: a 16px svg.
    const sprints = mount(railWith(<svg viewBox="0 0 16 16" className="icon-sm shrink-0" />))

    const designSlot = slotOf(design.container)
    const sprintsSlot = slotOf(sprints.container)
    assert.ok(designSlot, 'a rail row with a 12px chip still renders the reserved slot')
    assert.ok(sprintsSlot, 'a rail row with a 16px glyph renders the reserved slot')
    assert.equal(
      designSlot!.getAttribute('class'),
      sprintsSlot!.getAttribute('class'),
      'the slot is byte-identical across doors — the title x-offset cannot vary by which glyph a door passes',
    )
    // And the glyph really is INSIDE the slot; a sibling would reintroduce the
    // variable width the slot exists to remove.
    assert.equal(designSlot!.childElementCount, 1, "the door's glyph renders inside the slot")
    assert.equal(
      designSlot!.firstElementChild?.getAttribute('class'),
      'size-3 shrink-0 rounded-[3px]',
      'and the door keeps its own mark size inside that fixed box',
    )
    console.log('ok - a 12px chip and a 16px glyph occupy the same reserved slot')

    // ── 2. the slot's width is the icon ramp, not a literal ──────────────────
    // `h-4 w-4` would be 16px today and silently wrong the moment the ramp
    // moves. `size-icon-sm` and `.icon-sm` are one ramp (assets/index.css).
    const slotClasses = designSlot!.getAttribute('class') ?? ''
    assert.match(
      slotClasses,
      /\bsize-icon-sm\b/,
      'the slot takes its width from the icon-size ramp token, not a raw Tailwind literal',
    )
    assert.ok(
      !/\b[hw]-\d+\b/.test(slotClasses),
      'so no bare h-4/w-4 literal pins the slot to a number the ramp does not own',
    )
    assert.match(slotClasses, /\bshrink-0\b/, 'and a long title cannot squeeze the slot narrower')
    console.log('ok - the slot is sized from the icon ramp token')

    design.unmount()
    sprints.unmount()
  }

  // ── 3. a rail with nothing to mark reserves nothing ───────────────────────
  // The slot buys cross-door alignment; on a rail where NO row carries a mark
  // it would only buy a dead 24px gutter in front of every title.

  {
    const bare = mount(railWith(undefined))
    assert.equal(
      slotOf(bare.container),
      null,
      'a rail whose rows carry no mark reserves no slot — no empty gutter in front of the titles',
    )
    console.log('ok - an unmarked rail reserves no slot')
    bare.unmount()
  }

  // ── 4. a partly-marked rail reserves on EVERY row ─────────────────────────
  // The same defect one level down: if only marked rows got a slot, a rail
  // holding both kinds would ladder its own titles against each other.

  {
    const rows: SurfaceRailRow[] = [
      { id: 'marked', title: 'Marked', stateLine: 'has a glyph', icon: <svg className="icon-sm" /> },
      { id: 'bare', title: 'Bare', stateLine: 'has none' },
    ]
    const mixed = mount(
      <SurfaceRail
        label="Door"
        rows={rows}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New thing', onActivate: () => undefined }}
      />,
    )
    const slots = mixed.container.querySelectorAll('[data-rail-icon-slot="true"]')
    assert.equal(
      slots.length,
      2,
      'once any row in a rail carries a mark, every row reserves the slot — titles in one rail align with each other too',
    )
    assert.equal(slots[1]?.childElementCount, 0, 'the unmarked row holds the space open and draws nothing in it')
    console.log('ok - one marked row reserves the slot for all of them')
    mixed.unmount()
  }

  // ── 5. the Automations glyph fits its own box ─────────────────────────────
  // `AutomationTypeGlyph` drew an `icon-md` (18px) svg inside a 16px flex box —
  // a 2px overflow on every automation row and in the editor head. Read from the
  // source because the sizes are class names jsdom never resolves to pixels.

  {
    const glyphSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/panels/AutomationsPanel/AutomationTypeGlyph.tsx'),
      'utf8',
    )
    const boxStep = glyphSource.match(/className="flex (size-icon-\w+)/)?.[1]
    const svgStep = glyphSource.match(/<svg viewBox="0 0 16 16" fill="none" className="(icon-\w+)"/)?.[1]
    assert.ok(boxStep, 'the glyph box is sized from the icon ramp')
    assert.ok(svgStep, 'the glyph svg is sized from the icon ramp')
    assert.equal(
      svgStep,
      boxStep!.replace('size-', ''),
      'the svg and the box it sits in are the same icon step — the svg cannot overflow its own wrapper',
    )
    console.log('ok - the automation type glyph fits inside its box')
  }

  console.log('surface substrate: all checks passed')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
