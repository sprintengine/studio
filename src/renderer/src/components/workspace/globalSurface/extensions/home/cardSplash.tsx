// The splash: the slot a card's picture goes in, and the three pieces of
// furniture that sit on top of it.
//
// Layout C (epic ruling R3, `2026-09-06-extensions-home.html` Frame 3): the
// title sits ON the picture, in a scrim that carries it down into the card
// body. The caption-under-picture and three-column variants were considered
// and rejected, so the overlay is not a variant here — it is the treatment.
//
// That choice buys the poster look and costs two safe areas, and both belong to
// whoever commissions the artwork rather than to this file. The bottom third of
// the plate is where the title lands, so nothing the eye needs may happen down
// there; the top-right corner belongs to the stamp for the same reason. The
// mockup draws the first of these as a dashed band over Frame 1 (`.safe .band`,
// `height: 38%`). It is a brief, not a constant: the scrim below is a fade, not
// a floor, so the band is where the artwork must go quiet rather than where the
// page stops showing it.
//
// The pieces are separate components rather than slots on one, because the
// card composes them and the card is item 2468's business. They carry no
// z-index: every one of them is absolutely positioned inside the splash, so
// painting order IS DOM order, and the order the card must use is artwork,
// then scrim, then title, then stamp. The one exception is the stamp, which
// takes a layer of its own so a card that puts it first still gets it on top.

import React from 'react'

/**
 * Where the scrim finishes fading.
 *
 * It is a fade, and it is worth being exact about what that means for the title
 * rather than claiming more than it does. `linear-gradient(to top, S 0%, S 10%,
 * transparent 64%)` is flat surface for the bottom tenth of the plate and then
 * a straight ramp to nothing at 64%. The title band starts at 38%, where the
 * scrim is still about half opaque — so the FIRST line of a heading sits on
 * near-flat ground and the LAST line sits in the fade, over whatever the
 * picture is doing there.
 *
 * That is the mockup's own rendering and it is the right one: a gradient that
 * went flat at the top of the band would put its steepest slope directly behind
 * the heading, which is the artefact you actually see. The cost is that the
 * artwork has to hold up its end, which is exactly why the shot list asks for a
 * quiet bottom third and why the title is clamped to two lines below — a third
 * line would climb further into the fade than the picture can be trusted for.
 *
 * It is exported as a NUMBER as well as a string because the hero's floor below
 * is derived from it rather than guessed at, and `cardSplash.test.tsx` re-does
 * that arithmetic: a change to the stop that did not carry to the floor would
 * put the hero's words back over open artwork, which is the bug of
 * `2026-09-06-the-hero-keeps-its-words-on-its-plate` arriving by a second door.
 */
export const SCRIM_CLEAR_STOP_FRACTION = 0.64

/** Where the scrim stops being flat and starts to ramp. */
const SCRIM_FLAT_STOP_FRACTION = 0.1

const SCRIM_CLEAR_STOP = `${SCRIM_CLEAR_STOP_FRACTION * 100}%`

/**
 * How opaque the scrim is at a height measured UP FROM THE BOTTOM of the plate,
 * as a fraction of the plate's height. 1 is the plate's own surface colour and
 * 0 is bare artwork.
 *
 * This is the gradient above, read back as a function, and it exists so a test
 * can ask the question the eye asks — "is there anything behind this word?" —
 * of a geometry no headless DOM will lay out for it.
 */
export function scrimAlphaAt(fractionFromBottom: number): number {
  if (fractionFromBottom <= SCRIM_FLAT_STOP_FRACTION) return 1
  if (fractionFromBottom >= SCRIM_CLEAR_STOP_FRACTION) return 0
  return (
    (SCRIM_CLEAR_STOP_FRACTION - fractionFromBottom) /
    (SCRIM_CLEAR_STOP_FRACTION - SCRIM_FLAT_STOP_FRACTION)
  )
}

/**
 * The floor under the hero plate, and the whole of the fix for
 * `2026-09-06-the-hero-keeps-its-words-on-its-plate` (2026-09-06).
 *
 * **The bug.** The hero's four elements — title, dek, credit, `Go` — are one
 * absolutely-positioned stack of CONTENT height, and the plate under them was a
 * pure ratio with no floor. So the plate shrank with the card region and the
 * stack did not, and two failures arrived in order: the stack climbed out of
 * the band the scrim quietens (a 187px plate clears at y=67, and the stack
 * started at y=36 — the title drawn over open artwork), and then at a 169px
 * plate the 173px stack was simply taller than the frame and `overflow-hidden`
 * took the top off the title.
 *
 * **Why a floor, and not the other two answers the item offered.** A hero scrim
 * of its own would darken the plate but could not stop the clip: at 456px the
 * words are taller than the picture whatever colour is behind them. Dropping to
 * the ordinary card layout below a breakpoint keeps the composition but has to
 * move the dek, the credit and the button out of the plate and into a body —
 * and the title has to stay ON the plate to keep layout C (ruling R3), so the
 * stack has to split across the splash boundary at one width and not the other.
 * That is a restructure of the card to fix a number that was missing.
 *
 * **Why the item's "1 alone is not enough" does not hold, and what it missed.**
 * The item read a floor as "min-h at the height the overlay actually needs" and
 * concluded, correctly for that number, that the scrim is a percentage and so a
 * floor equal to the stack's height leaves the stack exactly where it was
 * relative to the fade. But the height the overlay needs is not its own height:
 * it is its height DIVIDED BY the scrim's clear stop, and at that value the
 * percentage works for the plate instead of against it. With `H` the plate's
 * height and `Ho` the stack's, the stack's top sits at `Ho / H` from the bottom;
 * `H >= Ho / 0.64` therefore puts it at or under 0.64 — inside the scrim — at
 * EVERY width, because `H` only ever grows from the floor.
 *
 * **The number.** The tallest stack the hero can legally draw is two title
 * lines, two dek lines and a credit, inside the stack's own padding. Against
 * the app's type steps that is 48 of padding + 60 of title + 10 of gap + 42 of
 * dek + 24 of credit = 184px, so the floor has to be at least 184 / 0.64 = 288.
 * 296 is that rounded up, which leaves the worst case sitting at 0.62 of the
 * plate rather than exactly on the stop. Both clamps are what make "legally" a
 * fact rather than an assumption: the title's is below, the dek's is in
 * `CardPoster.tsx`, and `cardSplash.test.tsx` re-does the whole sum so the day
 * a step of the type scale moves is the day this number is challenged.
 *
 * The item this fixes named a THREE-line dek as the tallest a card can be. That
 * premise is what the dek's clamp replaces, and the arithmetic is the reason:
 * three lines needs a 321px floor under the mockup's 330px cap, which leaves the
 * 2.7:1 crop nine pixels of plate height to govern and makes the hero a
 * fixed-height band with a ratio written on it. Two lines is also
 * the shape the hero already has wherever the plate is wide — `max-w-[62ch]`
 * caps the dek's column, so a shipped dek wraps twice and stops — and it is the
 * same device, at the same count, as the title's own clamp.
 *
 * **Where the floor bites.** 296 × 2.7 = 799px of card region, so the ratio
 * governs from there up to the cap and the floor takes over below it. That line
 * falls between the widths the item measured: the 806px region it called fine
 * is untouched, and the 606, 506 and 456px regions it caught losing their scrim
 * and then clipping are all floored. The floor repairs everything that was
 * broken and moves nothing that was not.
 */
export const HERO_PLATE_MIN_HEIGHT_PX = 296

/**
 * The mockup's cap on the hero plate (`2026-09-06-extensions-home.html`,
 * `.card--wide-hero .splash`), and the hero's crop.
 *
 * Exported only so the floor above has something to be measured against: a
 * floor that had drifted up past the cap would be a plate with no ratio left,
 * and a test that did not know the cap could not say so.
 */
export const HERO_PLATE_MAX_HEIGHT_PX = 330

/** The hero's crop, as a number the plate's height can be computed from. */
export const HERO_PLATE_ASPECT = 2.7

/**
 * How tall the hero's plate actually comes out at a given card-region width —
 * the ratio, held between the floor and the cap.
 *
 * The browser does this in three CSS declarations; this restates it so a test
 * can walk the widths the app can produce without a layout engine.
 */
export function heroPlateHeightPx(regionWidthPx: number): number {
  return Math.min(
    HERO_PLATE_MAX_HEIGHT_PX,
    Math.max(HERO_PLATE_MIN_HEIGHT_PX, regionWidthPx / HERO_PLATE_ASPECT),
  )
}

/**
 * The frame. A card is 16:9; the hero is a wider crop of the same picture,
 * 2.7:1, floored so its words always have plate to sit on and capped so it
 * cannot grow into a billboard on a wide window.
 *
 * The ratio is on the frame and the frame clips, so no amount of title or dek
 * can push it out of shape — the overlay is absolutely positioned inside it and
 * contributes nothing to its height. What the floor buys is the other half of
 * that bargain: the frame is now never smaller than the overlay it clips.
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
      // design-tokens-allow: 330px is the mockup's cap on the hero plate
      // (`2026-09-06-extensions-home.html`, `.card--wide-hero .splash`) and
      // 320px is the floor `HERO_PLATE_MIN_HEIGHT_PX` derives above. Both are
      // the size of a picture, not a step of spacing: the ratio does the work
      // between them, the cap stops a very wide window turning the hero into a
      // billboard and the floor stops a narrow one clipping its own words, so
      // there is no scale either could be taken from.
      //
      // Written out as literal class text and never assembled from
      // `HERO_PLATE_MIN_HEIGHT_PX`, for the reason `ui/tokens.ts` sets out:
      // Tailwind generates a rule only for a candidate it can see. The constant
      // and this literal are held together by `cardSplash.test.tsx`, which
      // asserts the class the frame actually ships carries the number the
      // arithmetic above produced.
      className={`relative w-full overflow-hidden bg-[color:var(--bg-surface-raised)] ${
        shape === 'hero' ? 'aspect-[2.7/1] max-h-[330px] min-h-[296px]' : 'aspect-[16/9]'
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
 * The title, over the picture, in the band the scrim has quietened. The hero
 * wears the same treatment at a larger size and with room beside it for the dek
 * and the button — hence the two shapes rather than two components.
 *
 * Clamped to two lines in both shapes. The overlay is absolutely positioned, so
 * a long title cannot push the plate out of shape whatever happens; what it CAN
 * do is climb out of the band the scrim quietens and set its top line over the
 * open picture. Two lines is where the band ends, so two lines is where the
 * title ends.
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
          <h3 className="m-0 line-clamp-2 max-w-[18ch] text-[length:calc(var(--text-size-lg)*1.5)] leading-tight font-semibold tracking-tight text-balance text-[color:var(--text-strong)]">
            {title}
          </h3>
          {children}
        </div>
      </div>
    )
  }
  return (
    <div className="absolute inset-x-0 bottom-0 px-4 pt-5 pb-3">
      <h3 className="m-0 line-clamp-2 text-title font-semibold tracking-tight text-balance text-[color:var(--text-strong)]">
        {title}
      </h3>
      {children}
    </div>
  )
}

/** Where the stamp sits, and the fact that it takes no clicks. */
const STAMP_CORNER = 'pointer-events-none absolute top-2.5 right-2.5 z-10'

/** The stamp's own drawing: the mockup's pill, minus the letter-spacing. */
const STAMP_PILL =
  'inline-flex h-5 items-center rounded-full border border-[color:var(--border-default)] ' +
  'bg-[color:var(--bg-surface)] px-1.5 text-micro font-medium uppercase text-[color:var(--text-muted)]'

/**
 * The stamp: one word, top right, saying what the card is.
 *
 * It takes no clicks. The card that composes these puts a stretched overlay over
 * the whole plate so the poster is one target (`CardPoster.tsx`), and the stamp
 * is the one piece of furniture with a layer of its own — without this it would
 * be the single square of a card that does nothing when you press it. A label is
 * not a control, so it has nothing to lose by standing out of the way.
 *
 * The mockup sets it in uppercase with tracking, and it is the PAIRING the
 * design system rejects — `principles.md` "Type" refuses uppercase letter-spaced
 * labels as hierarchy, policed as the `uppercase-tracked` conformance rule and
 * as `no-uppercase-tracking` in the token lint. Uppercase on its own is neither
 * rule's business. So the stamp keeps the mockup's drawing — the pill, the
 * hairline, the corner, the case — and drops the letter-spacing alone. The
 * label is passed in already cased; the transform is what makes it look drawn
 * rather than typed.
 */
export function CardSplashStamp({
  label,
  /**
   * A mark that belongs beside the stamp rather than in the words — today the
   * New chip (`CardPoster.tsx` says why the corner is where it goes). Nothing
   * is drawn around it when there is none, so a card without one keeps exactly
   * the single positioned pill it has always been.
   */
  mark,
}: {
  label: string
  mark?: React.ReactNode
}): JSX.Element {
  if (!mark) {
    return (
      <span className={`${STAMP_CORNER} ${STAMP_PILL}`}>{label}</span>
    )
  }
  return (
    <span className={`${STAMP_CORNER} inline-flex items-center gap-1.5`}>
      <span className={STAMP_PILL}>{label}</span>
      {mark}
    </span>
  )
}
