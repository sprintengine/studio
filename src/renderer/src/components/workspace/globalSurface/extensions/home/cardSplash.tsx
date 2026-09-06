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
      // design-tokens-allow: 330px is the mockup's cap on the hero plate
      // (`2026-09-06-extensions-home.html`, `.card--wide-hero .splash`). It is
      // the size of a picture, not a step of spacing: the ratio does the work
      // and this only stops a very wide window turning the hero into a
      // billboard, so there is no scale it could be taken from.
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
export function CardSplashStamp({ label }: { label: string }): JSX.Element {
  return (
    <span className="pointer-events-none absolute top-2.5 right-2.5 z-10 inline-flex h-5 items-center rounded-full border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-1.5 text-micro font-medium uppercase text-[color:var(--text-muted)]">
      {label}
    </span>
  )
}
