// The plates and the frame, rendered.
//
// `renderableCards.test.ts` beside this one asks the registry questions without
// drawing anything, which is the right shape for a filter and the wrong shape
// for a picture: it cannot see that a plate throws, that the fake window chrome
// inside one is read aloud, or that a title has grown out of the band the scrim
// quietens. Those are the three faults the first adversarial pass found here,
// and every one of them is a fault you can only see once the DOM exists.
//
// Against a real DOM rather than static markup, the way
// `../catalogue/extensionsCatalogue.test.tsx` does it.

import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost', pretendToBeVisual: true })
const anyGlobal = globalThis as unknown as Record<string, unknown>
anyGlobal.window = dom.window as unknown as Record<string, unknown>
anyGlobal.document = dom.window.document
anyGlobal.navigator = dom.window.navigator
anyGlobal.HTMLElement = dom.window.HTMLElement
anyGlobal.Node = dom.window.Node
anyGlobal.Event = dom.window.Event
anyGlobal.IS_REACT_ACT_ENVIRONMENT = true

import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { CARD_ART, CARD_ART_NAMES, CardArt } from './cardArt'
import {
  CardSplash,
  CardSplashScrim,
  CardSplashStamp,
  CardSplashTitle,
  HERO_PLATE_ASPECT,
  HERO_PLATE_MAX_HEIGHT_PX,
  HERO_PLATE_MIN_HEIGHT_PX,
  heroPlateHeightPx,
  SCRIM_CLEAR_STOP_FRACTION,
  scrimAlphaAt,
} from './cardSplash'

const container = dom.window.document.createElement('div')
dom.window.document.body.appendChild(container)
const root = createRoot(container as unknown as Element)

async function draw(node: React.ReactNode): Promise<void> {
  await act(async () => {
    root.render(node as React.ReactElement)
  })
}

async function run(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

/** Is this element, or anything above it, hidden from assistive technology? */
function hiddenFromReaders(element: Element | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true
  }
  return false
}

async function main(): Promise<void> {
  // ── The plates ─────────────────────────────────────────────────────────────

  await run('every name the registry publishes draws a plate', async () => {
    for (const name of CARD_ART_NAMES) {
      await draw(
        <CardSplash>
          <CardArt name={name} />
        </CardSplash>,
      )
      const plate = container.querySelector('div > div')
      assert.ok(plate, `${name} drew nothing`)
      assert.ok(
        (plate?.innerHTML.length ?? 0) > 0,
        `${name} drew an empty plate, which is the grey rectangle the ruling forbids`,
      )
    }
    assert.equal(
      Object.keys(CARD_ART).length,
      CARD_ART_NAMES.length,
      'the registry holds a plate for every published name and nothing besides',
    )
  })

  await run('a name this build does not hold draws nothing at all', async () => {
    await draw(
      <CardSplash>
        <CardArt name="holodeck" />
      </CardSplash>,
    )
    const frame = container.firstElementChild
    assert.ok(frame, 'the frame is still there')
    assert.equal(frame?.innerHTML, '', 'no fallback plate, no grey rectangle, nothing (2026-09-06 ruling)')
  })

  await run('a plate is hidden from a screen reader', async () => {
    for (const name of CARD_ART_NAMES) {
      await draw(<CardArt name={name} />)
      const plate = container.firstElementChild
      assert.equal(
        plate?.getAttribute('aria-hidden'),
        'true',
        `${name}'s root must be hidden: it is a picture, and the words in it are fake window chrome`,
      )
    }
  })

  await run('the fake window chrome is never read aloud beside the real title', async () => {
    // The failure this catches: a screen reader working down the grid reading
    // "localhost:5173", "SprintEngine Studio" and the rest interleaved with the
    // titles that actually say what a card is.
    await draw(
      <CardSplash>
        <CardArt name="browser" />
        <CardSplashScrim />
        <CardSplashTitle title="Let an agent drive your browser" />
      </CardSplash>,
    )
    const chrome = [...container.querySelectorAll('*')].filter(
      (element) => element.children.length === 0 && (element.textContent ?? '').includes('localhost'),
    )
    assert.equal(chrome.length, 1, 'the label is drawn')
    assert.ok(hiddenFromReaders(chrome[0] ?? null), 'and it is drawn for the eye only')
    const heading = container.querySelector('h3')
    assert.equal(hiddenFromReaders(heading), false, 'while the card\'s own title is still read')
  })

  // ── The furniture ──────────────────────────────────────────────────────────

  await run('a title cannot grow past the band the scrim quietens', async () => {
    // Two lines, in both shapes. The scrim is a fade rather than a floor, so a
    // third line would set itself over the open picture.
    for (const shape of ['card', 'hero'] as const) {
      await draw(
        <CardSplash shape={shape}>
          <CardSplashTitle
            shape={shape}
            title="A title long enough that it would run to four or five lines if nothing here stopped it"
          />
        </CardSplash>,
      )
      const heading = container.querySelector('h3')
      assert.ok(
        heading?.className.includes('line-clamp-2'),
        `the ${shape} title clamps at two lines (saw: ${heading?.className ?? 'no heading'})`,
      )
    }
  })

  await run('a long title cannot push the plate out of shape', async () => {
    await draw(
      <CardSplash>
        <CardSplashTitle title="A title long enough to reflow" />
      </CardSplash>,
    )
    const frame = container.firstElementChild
    assert.ok(frame?.className.includes('aspect-[16/9]'), 'the ratio is on the frame, which clips')
    const overlay = frame?.querySelector('div')
    assert.ok(overlay?.className.includes('absolute'), 'and the overlay contributes nothing to its height')
  })

  // ── The width dimension ────────────────────────────────────────────────────
  //
  // The two assertions above bound the WORDS and say nothing at all about the
  // plate they sit on, which is the whole of what
  // `2026-09-06-the-hero-keeps-its-words-on-its-plate` caught: the hero's stack
  // is content-height and the plate under it was a bare ratio, so the plate
  // shrank with the card region and the stack did not. At a 187px plate the
  // title was drawn over open artwork; at a 169px one it was clipped. Neither
  // failure needs a long title, and neither is visible to a suite with no width
  // in it.
  //
  // jsdom lays nothing out, so this cannot be a measurement and does not
  // pretend to be one. What it is instead is the ARITHMETIC the fix rests on,
  // re-done against the numbers the components actually ship: the type steps
  // below are the app's own (`--sem-font-size-*` through the `@theme` block in
  // `assets/index.css`, with Tailwind's `leading-*` ratios), and every constant
  // they are compared against is imported rather than restated. A step of the
  // type scale that moved, a clamp that was loosened or a floor that drifted
  // under the stack it was derived from all land here as a failure, which is
  // the most a headless DOM can be asked for and considerably more than none.

  /** The hero's stack, at the tallest every part of it is allowed to be. */
  const HERO_STACK = {
    /** `p-6`, top and bottom. */
    padding: 24 * 2,
    /** `text-[length:calc(var(--text-size-lg)*1.5)] leading-tight`, clamped to 2. */
    title: 2 * (16 * 1.5 * 1.25),
    /** `mt-2.5` between the title and everything under it. */
    gap: 10,
    /** `text-body leading-relaxed`, clamped to 2 in `CardPoster.tsx`. */
    dek: 2 * (13 * 1.625),
    /** `mt-1.5` and one `text-micro` line, truncated so it is always one. */
    credit: 6 + 11 * 1.625,
  }
  const TALLEST_HERO_STACK =
    HERO_STACK.padding + HERO_STACK.title + HERO_STACK.gap + HERO_STACK.dek + HERO_STACK.credit
  /** The stack the SHIPPED hero draws: one title line, two dek lines, a credit. */
  const SHIPPED_HERO_STACK = TALLEST_HERO_STACK - HERO_STACK.title / 2

  /** Where the top of the first WORD sits, as a fraction up from the plate's foot. */
  const wordsTopAt = (stackPx: number, platePx: number): number => (stackPx - 24) / platePx

  await run('the hero plate is never shorter than the words standing on it', async () => {
    // The clip, at its own worst case. `overflow-hidden` is on the frame, so a
    // stack taller than the plate loses the TOP of the title — the reader loses
    // the one sentence the card is for and is given no sign that anything is
    // missing.
    assert.ok(
      TALLEST_HERO_STACK <= HERO_PLATE_MIN_HEIGHT_PX,
      `the tallest legal stack (${TALLEST_HERO_STACK.toFixed(1)}px) must fit the shortest plate (${HERO_PLATE_MIN_HEIGHT_PX}px)`,
    )
    assert.ok(
      HERO_PLATE_MIN_HEIGHT_PX <= HERO_PLATE_MAX_HEIGHT_PX,
      'and the floor must still leave the mockup’s cap something to cap',
    )
  })

  await run('the hero’s words sit on scrimmed ground at every width the app can make', async () => {
    // The legibility failure, which arrives FIRST and is the one a screenshot
    // caught: the scrim is a percentage of the plate, so a plate that shrinks
    // takes its quiet band down with it and leaves the title over the artwork.
    // 320px is a card region narrower than any the app produces with a sidebar
    // open; 1400 is a maximised window with it closed.
    for (let region = 320; region <= 1400; region += 4) {
      const plate = heroPlateHeightPx(region)
      assert.ok(
        TALLEST_HERO_STACK <= plate,
        `a ${region}px card region gives a ${plate.toFixed(0)}px plate, which clips the stack`,
      )
      const alpha = scrimAlphaAt(wordsTopAt(TALLEST_HERO_STACK, plate))
      assert.ok(
        alpha > 0,
        `a ${region}px card region leaves the first line of the title on bare artwork (scrim ${alpha.toFixed(3)})`,
      )
    }
    // And the case the item measured as fine stays fine rather than merely
    // legal: an 806px region is a 1200px window with the sidebar open, where the
    // ratio still governs and the floor never applies.
    const workbench = heroPlateHeightPx(806)
    assert.ok(
      workbench > HERO_PLATE_MIN_HEIGHT_PX,
      'the floor does not reach up into the widths that were already correct',
    )
    assert.ok(
      scrimAlphaAt(wordsTopAt(SHIPPED_HERO_STACK, workbench)) > 0.3,
      'and the shipped hero’s title still sits on ground the picture cannot be seen through',
    )
  })

  await run('the frame ships the numbers the arithmetic above was done on', async () => {
    // Tailwind only emits a rule for a class it can see as literal text, so the
    // frame writes its floor out rather than building it from the constant.
    // This is the join: a floor that was raised in one place and not the other
    // would leave every assertion above passing about a plate that no longer
    // exists.
    // Nothing on the plate: this check reads the frame's own classes.
    await draw(<CardSplash shape="hero">{null}</CardSplash>)
    const hero = container.firstElementChild?.className ?? ''
    assert.ok(hero.includes(`min-h-[${HERO_PLATE_MIN_HEIGHT_PX}px]`), `the hero frame carries its floor (saw: ${hero})`)
    assert.ok(hero.includes(`max-h-[${HERO_PLATE_MAX_HEIGHT_PX}px]`), 'and the mockup’s cap')
    assert.ok(hero.includes(`aspect-[${HERO_PLATE_ASPECT}/1]`), 'and the crop between them')

    // The ordinary card takes no floor, and that is deliberate rather than an
    // omission: it carries a title and nothing else on its plate, its stack is
    // therefore a fraction of the hero's, and a floor there would break the
    // 16:9 ratio in a narrow column for a stack that was never at risk.
    await draw(<CardSplash>{null}</CardSplash>)
    const card = container.firstElementChild?.className ?? ''
    assert.ok(card.includes('aspect-[16/9]'), 'the ordinary card is the 16:9 crop')
    assert.ok(!card.includes('min-h-'), 'and it has no floor, because it never needed one')

    // The scrim's stop is the other half of the arithmetic — the floor is the
    // stack divided by it — so a change to one that skipped the other has to
    // fail somewhere, and this is where.
    await draw(<CardSplashScrim />)
    const scrim = (container.firstElementChild as HTMLElement | null)?.style.backgroundImage ?? ''
    assert.ok(
      scrim.includes(`${SCRIM_CLEAR_STOP_FRACTION * 100}%`),
      `the scrim clears where the floor says it does (saw: ${scrim})`,
    )
    assert.equal(scrimAlphaAt(SCRIM_CLEAR_STOP_FRACTION), 0, 'and at that stop there is nothing behind a word')
  })

  await run('the stamp keeps the case and drops the tracking', async () => {
    // Both lints reject `uppercase` PAIRED WITH `tracking-*`, and neither has
    // anything to say about the case on its own — which is what the mockup
    // draws.
    await draw(<CardSplashStamp label="Automation" />)
    const stamp = container.firstElementChild
    assert.ok(stamp?.className.includes('uppercase'), 'the mockup draws it uppercase')
    assert.doesNotMatch(stamp?.className ?? '', /tracking-/, 'and the pairing is what the design system rejects')
  })

  await act(async () => {
    root.unmount()
  })

  console.log('card splash: ok')
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
