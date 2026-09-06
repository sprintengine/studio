// The splash: the slot a card's picture goes in, and the three pieces of
// furniture that sit on top of it.
//
// Layout C (epic ruling R3, `2026-09-06-extensions-home.html` Frame 3): the
// title sits ON the picture, in a scrim that carries it down into the card
// body. The caption-under-picture and three-column variants were considered
// and rejected, so the overlay is not a variant here — it is the treatment.
//
// That choice buys the poster look and costs two safe areas, and both are
// encoded below rather than left to whoever commissions the artwork. The
// bottom 38% of the plate is where the title lands, so nothing the eye needs
// may happen there; the top-right corner belongs to the stamp for the same
// reason. The mockup draws the first of these as a dashed band over Frame 1
// (`.safe .band`, `height: 38%`) — here it is a number the scrim is built from
// and a constant a future artwork pass can assert against.
//
// The pieces are separate components rather than slots on one, because the
// card composes them and the card is item 2468's business. They carry no
// z-index: every one of them is absolutely positioned inside the splash, so
// painting order IS DOM order, and the order the card must use is artwork,
// then scrim, then title, then stamp. The one exception is the stamp, which
// takes a layer of its own so a card that puts it first still gets it on top.

import React from 'react'

/**
 * The share of the plate's height the title lands in. The artwork has to stay
 * quiet down here; the scrim below is how the page enforces it in the meantime.
 */
export const SPLASH_TITLE_SAFE_AREA = 0.38

/**
 * Where the scrim finishes fading. Deliberately past the safe area rather than
 * level with it: a gradient that ended exactly at the top of the title band
 * would put its steepest slope right behind the first line of the heading. The
 * fade completes at 64% of the plate's height, well clear of the 38% band, so
 * the title reads over flat colour and the transition happens above it.
 */
const SCRIM_CLEAR_STOP = '64%'

/**
 * The frame. A card is 16:9; the hero is a wider crop of the same picture,
 * 2.7:1, capped so it cannot grow into a billboard on a wide window.
 *
 * The ratio is on the frame and the frame clips, so no amount of title or dek
 * can push it out of shape — the overlay is absolutely positioned inside it and
 * contributes nothing to its height.
 *
 * The ground is the raised surface plus a 20px hairline grid, which is what
 * makes an empty corner of a plate read as a surface rather than as a blank.
 * Both come from tokens, so both modes are correct with no override.
 */
export function CardSplash({
  shape = 'card',
  children,
}: {
  shape?: 'card' | 'hero'
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      className={`relative w-full overflow-hidden bg-[color:var(--bg-surface-raised)] ${
        shape === 'hero' ? 'aspect-[2.7/1] max-h-[330px]' : 'aspect-[16/9]'
      }`}
      style={{
        backgroundImage:
          'linear-gradient(to right, var(--border-subtle) 1px, transparent 1px),' +
          'linear-gradient(to bottom, var(--border-subtle) 1px, transparent 1px)',
        backgroundSize: '20px 20px, 20px 20px',
      }}
    >
      {children}
    </div>
  )
}

/**
 * The scrim that carries the picture into the card body.
 *
 * It ends on `--bg-surface`, which is exactly what the card body paints, so the
 * bottom of the plate and the top of the body meet at one colour in both modes.
 * A scrim that faded to a colour the card did not actually paint would read as
 * a hard edge in whichever mode disagreed, which is the failure this note
 * exists to prevent.
 */
export function CardSplashScrim(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `linear-gradient(to top, var(--bg-surface) 0%, var(--bg-surface) 10%, transparent ${SCRIM_CLEAR_STOP})`,
      }}
    />
  )
}

/**
 * The title, over the picture, in the safe area the scrim has quietened. The
 * hero wears the same treatment at a larger size and with room beside it for
 * the dek and the button — hence the two shapes rather than two components.
 *
 * The hero's size is derived from the title step rather than typed as a pixel
 * value, so a change to the type scale carries it.
 */
export function CardSplashTitle({
  shape = 'card',
  title,
  children,
}: {
  shape?: 'card' | 'hero'
  title: string
  children?: React.ReactNode
}): JSX.Element {
  if (shape === 'hero') {
    return (
      <div className="absolute inset-x-0 bottom-0 flex items-end gap-5 p-6">
        <div className="min-w-0 flex-1">
          <h3 className="m-0 max-w-[18ch] text-[length:calc(var(--text-size-lg)*1.5)] leading-tight font-semibold tracking-tight text-balance text-[color:var(--text-strong)]">
            {title}
          </h3>
          {children}
        </div>
      </div>
    )
  }
  return (
    <div className="absolute inset-x-0 bottom-0 px-4 pt-5 pb-3">
      <h3 className="m-0 text-title font-semibold tracking-tight text-balance text-[color:var(--text-strong)]">
        {title}
      </h3>
      {children}
    </div>
  )
}

/**
 * The stamp: one word, top right, saying what the card is.
 *
 * The mockup sets it in uppercase with tracking. The design system rejects
 * uppercase letter-spaced labels as hierarchy (`principles.md` "Type", policed
 * as the `uppercase-tracked` conformance rule), so the stamp keeps the
 * mockup's geometry — the pill, the hairline, the corner — and drops the
 * transform. The label is passed in already cased.
 */
export function CardSplashStamp({ label }: { label: string }): JSX.Element {
  return (
    <span className="absolute top-2.5 right-2.5 z-10 inline-flex h-5 items-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-1.5 text-micro font-medium text-[color:var(--text-muted)]">
      {label}
    </span>
  )
}
