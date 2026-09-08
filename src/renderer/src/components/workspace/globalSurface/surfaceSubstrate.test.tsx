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

  // ── 4b. a row's standing mark is a FACT, not a hover control ──────────────
  // `actions` fades in under the pointer because it is a control you reach for.
  // `mark` is the Design door's "3 new" roll-up: something true about the row,
  // and a fact that only appears on hover is a fact nobody reads.

  {
    const rows: SurfaceRailRow[] = [
      {
        id: 'marked',
        title: 'A system with a very long name that has to give way first',
        stateLine: '2.4.0',
        mark: <span data-standing-mark="true">3 new</span>,
        actions: <button type="button">…</button>,
      },
      { id: 'plain', title: 'Plain', stateLine: 'no mark' },
    ]
    const rail = mount(
      <SurfaceRail
        label="Door"
        rows={rows}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New thing', onActivate: () => undefined }}
      />,
    )
    const mark = rail.container.querySelector('[data-standing-mark="true"]')
    assert.ok(mark, 'the mark renders')
    // Nothing between the mark and the row button hides it until hover — the
    // opacity-0 wrapper belongs to `actions` and must not have swallowed this.
    for (let node = mark!.parentElement; node && node.tagName !== 'BUTTON'; node = node.parentElement) {
      assert.ok(
        !/opacity-0/.test(node.getAttribute('class') ?? ''),
        'a standing mark is never gated on hover the way an action is',
      )
    }
    // It shares the title's line, and the title is what gives way.
    const line = mark!.parentElement
    const title = line?.querySelector('span:first-child')
    assert.match(title?.getAttribute('class') ?? '', /\bflex-1\b/, 'the title takes the slack')
    assert.match(title?.getAttribute('class') ?? '', /\btruncate\b/, 'and truncates rather than pushing the mark out')
    // A row that passes none renders the title exactly as it always did — no
    // wrapper, so every other door's rail markup is untouched.
    const plainRow = rail.container.querySelectorAll('li')[1]
    const plainTitle = [...plainRow!.querySelectorAll('span')].find(
      (node) => node.textContent === 'Plain',
    )
    assert.ok(plainTitle, 'the unmarked row renders its title')
    assert.equal(
      plainTitle!.parentElement?.querySelectorAll('span').length,
      2,
      'title and state line only: an unmarked row grew no extra box',
    )
    console.log('ok - a standing mark shows without hover, and only the marked row pays for it')
    rail.unmount()
  }

  // ── 5. the ruled alignment grid (MC-2101) ─────────────────────────────────
  // patterns/context-rail.html, "The alignment grid": a row title sits 36px from
  // the column edge, as 4 (scrollport) + 8 (row padding) + 16 (icon slot) + 8
  // (gap). Asserted as the ARITHMETIC rather than as four unrelated class names,
  // because the number is the contract and the four terms are just how it is
  // currently spelled — and because 36px is also where the app sidebar's
  // workspace rows put their text, which is what makes a drill-in not re-flow.

  {
    const view = mount(railWith(<svg className="icon-sm" />))
    const px = (classes: string, prefix: string): number | null => {
      // Tailwind spacing: `px-1` = 4px, `px-2` = 8px, `px-2.5` = 10px, `gap-2` = 8px.
      const found = classes.match(new RegExp(`(?:^|\\s)${prefix}-(\\d+(?:\\.\\d+)?)(?:\\s|$)`))
      return found ? Number(found[1]) * 4 : null
    }
    const scrollport = view.container.querySelector('.overflow-y-auto')
    const rowButton = view.container.querySelector('li button')
    assert.ok(scrollport && rowButton, 'the rail renders a scrollport with a row in it')

    const scrollInset = px(scrollport!.getAttribute('class') ?? '', 'px')
    const rowClasses = rowButton!.getAttribute('class') ?? ''
    const rowInset = px(rowClasses, 'px')
    const rowGap = px(rowClasses, 'gap')
    assert.equal(scrollInset, 4, 'scrollport inset is space.2xs (4px) — the pattern\'s .rail-rows padding')
    assert.equal(rowInset, 8, 'row padding is space.sm (8px) — .cr-row, unchanged')
    assert.equal(rowGap, 8, 'the icon-to-title gap is space.sm (8px) — .cr-row, unchanged')
    assert.equal(
      (scrollInset ?? 0) + (rowInset ?? 0) + 16 + (rowGap ?? 0),
      36,
      'so a row title lands 36px from the column edge, where the app sidebar puts its workspace rows',
    )

    // Two-line row type, per list-surface's `.rail-row`. Both steps shipped one
    // smaller (meta title over micro state line).
    const title = rowButton!.querySelector('span > span')
    assert.match(title?.getAttribute('class') ?? '', /\btext-body\b/, 'the row title is body (13px)')
    assert.match(
      title?.nextElementSibling?.getAttribute('class') ?? '',
      /\btext-meta\b/,
      'and the state line under it is meta (12px)',
    )

    // The head is deliberately WIDER than the scrollport: full-width controls
    // against inset row fills. Equal insets here would be the bug in reverse.
    const head = view.container.querySelector('.border-b')
    assert.equal(px(head?.getAttribute('class') ?? '', 'px'), 8, 'the head insets at space.sm (8px)')
    console.log('ok - rail rows land on the ruled 36px text grid')
    view.unmount()
  }

  // ── 6. the empty-filter notice lives in the scrollport ────────────────────
  // It used to be a sibling of a `flex-1` rail in five doors, which put it at the
  // BOTTOM of the column exactly when the list was empty — furthest from the
  // search field that emptied it, and at a different inset from the rows it
  // explains. Both halves are asserted: inside the scrollport, and at row inset.

  {
    const withNotice = mount(
      <SurfaceRail
        label="Door"
        rows={[]}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New thing', onActivate: () => undefined }}
        emptyNotice="No things match."
      />,
    )
    const scrollport = withNotice.container.querySelector('.overflow-y-auto')
    const notice = Array.from(withNotice.container.querySelectorAll('p')).find((p) =>
      p.textContent?.includes('No things match.'),
    )
    assert.ok(notice, 'the notice renders when a narrowed rail has no rows')
    assert.ok(
      scrollport!.contains(notice!),
      'inside the scrollport — a sibling of the flex-1 rail gets pushed to the bottom of the column',
    )
    assert.equal(
      notice!.previousElementSibling,
      null,
      'and it is the scrollport\'s first child, so it sits under the head where the rows would have been',
    )
    assert.equal(
      notice!.getAttribute('class')?.match(/(?:^|\s)px-(\d+)/)?.[1],
      '2',
      'at the row inset (8px), not the 8px-from-column-edge a sibling had',
    )
    withNotice.unmount()

    // A rail with rows says nothing: the notice explains an empty list only.
    const withRows = mount(
      <SurfaceRail
        label="Door"
        rows={[{ id: 'a', title: 'A row', stateLine: 'here' }]}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New thing', onActivate: () => undefined }}
        emptyNotice="No things match."
      />,
    )
    assert.ok(
      !(withRows.container.textContent ?? '').includes('No things match.'),
      'a rail that has rows never shows the empty-filter notice',
    )
    withRows.unmount()
    console.log('ok - the empty-filter notice renders in the scrollport under the head')
  }

  // ── 7. a two-level rail: one scrollport, one outer-context group ──────────
  // A two-level door lists containers and, under them, the selected container's
  // contents. Both were in one column but only one was in the scrollport, so they
  // scrolled independently (MC-2099).
  //
  // The second claim is the subtler one, and it is a regression this change
  // could easily have introduced: `[data-rail-group="outer-context"]` is a
  // DESCENDANT selector that rests every selection beneath it. It used to sit on
  // a wrapper around the whole rail, which was harmless only while the plan was
  // a sibling. Moving the plan inside the rail would have put it under that
  // marker too — and the plan's selection is the FOCUSED one, the single thing
  // on screen that should read as chosen. So the marker moved onto the rows.

  {
    const twoLevel = mount(
      <SurfaceRail
        label="Projects"
        rows={[{ id: 'h1', title: 'Q3 platform', stateLine: 'active' }]}
        selectedId="h1"
        onSelect={() => undefined}
        newAffordance={{ label: 'New project', onActivate: () => undefined }}
        outerContext
        afterRows={
          <section data-testid="plan">
            <button type="button" data-testid="plan-step" aria-current="true">
              A step
            </button>
          </section>
        }
      />,
    )
    const scrollport = twoLevel.container.querySelector('.overflow-y-auto')
    const plan = twoLevel.container.querySelector('[data-testid="plan"]')
    assert.ok(plan, 'the second level renders')
    assert.ok(
      scrollport!.contains(plan!),
      'inside the rail scrollport — a sibling scrolls separately from the list it hangs off',
    )
    assert.equal(
      twoLevel.container.querySelectorAll('.overflow-y-auto').length,
      1,
      'and the column has exactly one scroll region',
    )

    const marker = twoLevel.container.querySelector('[data-rail-group="outer-context"]')
    assert.ok(marker, 'the outer level is marked')
    assert.equal(marker!.tagName, 'UL', 'the marker is on the ROWS, not on a wrapper around the whole rail')
    assert.ok(
      !marker!.contains(twoLevel.container.querySelector('[data-testid="plan-step"]')),
      'so the inner level is outside it and keeps the one focused selection, instead of resting like context',
    )
    console.log('ok - a two-level rail has one scrollport and rests only its outer rows')
    twoLevel.unmount()

    // A search that narrows the OUTER level to nothing hides the inner one with
    // it. The row that owns the second level is off screen too, so leaving the
    // plan rendered put it directly under "No projects match." — a plan for a
    // project the filter had just hidden.
    const narrowed = mount(
      <SurfaceRail
        label="Projects"
        rows={[]}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New project', onActivate: () => undefined }}
        outerContext
        emptyNotice="No projects match."
        afterRows={<section data-testid="plan">A plan</section>}
      />,
    )
    assert.match(narrowed.container.textContent ?? '', /No projects match\./, 'the notice explains the empty list')
    assert.equal(
      narrowed.container.querySelector('[data-testid="plan"]'),
      null,
      'and the orphaned second level is not rendered beneath it',
    )
    console.log('ok - narrowing the outer level to nothing hides the inner one')
    narrowed.unmount()

    // But an outer level that is legitimately empty with no notice (nothing to
    // narrow) still shows its second level — this must not become "a rail with
    // no rows never shows afterRows".
    const noRowsNoNotice = mount(
      <SurfaceRail
        label="Projects"
        rows={[]}
        selectedId={null}
        onSelect={() => undefined}
        newAffordance={{ label: 'New project', onActivate: () => undefined }}
        afterRows={<section data-testid="plan">A plan</section>}
      />,
    )
    assert.ok(
      noRowsNoNotice.container.querySelector('[data-testid="plan"]'),
      'an empty rail that is not NARROWED still carries its second level',
    )
    noRowsNoNotice.unmount()

    // Without the flag there is no marker at all: a one-level rail's selection
    // is the focused one, and a stray marker would rest it.
    const oneLevel = mount(railWith(<svg className="icon-sm" />))
    assert.equal(
      oneLevel.container.querySelector('[data-rail-group]'),
      null,
      'a rail with one level marks no outer-context group',
    )
    oneLevel.unmount()
  }

  // ── 8. the Automations glyph fits its own box ─────────────────────────────
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
