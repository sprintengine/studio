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
  SCRIM_CLEAR_STOP_FRACTION,
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

  await run('the hero frame carries its floor, its cap and its crop', async () => {
    // Nothing on the plate: this check reads the frame's own classes.
    await draw(<CardSplash shape="hero">{null}</CardSplash>)
    const hero = container.firstElementChild?.className ?? ''
    assert.ok(hero.includes('min-h-[296px]'), `the hero frame carries its floor (saw: ${hero})`)
    assert.ok(hero.includes('max-h-[330px]'), 'and the mockup’s cap')
    assert.ok(hero.includes('aspect-[2.7/1]'), 'and the crop between them')

    // The ordinary card takes no floor, and that is deliberate rather than an
    // omission: it carries a title and nothing else on its plate, its stack is
    // therefore a fraction of the hero's, and a floor there would break the
    // 16:9 ratio in a narrow column for a stack that was never at risk.
    await draw(<CardSplash>{null}</CardSplash>)
    const card = container.firstElementChild?.className ?? ''
    assert.ok(card.includes('aspect-[16/9]'), 'the ordinary card is the 16:9 crop')
    assert.ok(!card.includes('min-h-'), 'and it has no floor, because it never needed one')

    // The scrim's stop is the other half of the floor's arithmetic (the floor
    // is the tallest stack divided by it), so the scrim must clear where the
    // constant says it does.
    await draw(<CardSplashScrim />)
    const scrim = (container.firstElementChild as HTMLElement | null)?.style.backgroundImage ?? ''
    assert.ok(
      scrim.includes(`${SCRIM_CLEAR_STOP_FRACTION * 100}%`),
      `the scrim clears where the floor says it does (saw: ${scrim})`,
    )
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
