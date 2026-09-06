// The card, assembled. The splash primitives beside this file are the pieces
// (item 2467); this is the object the Extensions home actually draws.
//
// It is an advert and it is allowed to behave like one (epic ruling R2,
// `2026-09-06-extensions-home.html` Frame 2): the picture does most of the
// work, the title sits ON the picture in the scrim (layout C, ruling R3), the
// words are a claim rather than a description, there is a quiet credit line,
// and there is exactly one thing to press. What it must never be is a list of
// steps — a card that explains itself has stopped being an invitation — which
// is why the actions a card carries are nowhere in this file.
//
// **The accent is spent once, on the hero.** The design system's accent budget
// (principles, "The accent budget") gives a view ONE solid accent fill, on its
// primary action, and the Extensions home has seven cards and five tiles in it
// — the tiles' own glyphs are neutral ink for exactly this reason. So the hero,
// which is the card the feed promoted and the only one the page ranks, carries
// the filled `Go`, and every other card carries the outlined one. The mockup
// draws all seven accented; it drew one card at a time. The rule the mockup
// itself states in the same breath — "the card's only control and the view's
// only accent" — is kept here by the outline, not broken by it, and the
// hierarchy the grid already has is what pays for it: a page needing a second
// accent is missing hierarchy, and this page is not.
//
// **The whole card is the target, and hover is a background change only** — the
// task-card family contract: no lift, no shadow, no scale.
//
// The target is a STRETCHED OVERLAY, and the article itself is inert. The first
// build hung `onClick` on the `<article>` with `cursor-pointer` over it and
// nothing else, which is the half of the contract a mouse can see: no tab stop,
// no key handler, no focus ring, so a keyboard could not reach a card at all.
// The obvious repair — `role="button" tabIndex={0}` on the article, the way
// `ui/TaskCard.tsx` does it — is not available here, because a card CONTAINS a
// real `<button>` and a button inside `role="button"` is markup no assistive
// technology is required to make sense of.
//
// So `Go` is the one tab stop and the one control, and the card is the area it
// answers for:
//
//   The ordinary card stretches `Go`'s own `::after` over the whole shell. The
//   button sits in normal flow inside the body, so the nearest positioned
//   ancestor of that pseudo-element is the article — which is exactly the box
//   the overlay should cover.
//
//   The hero cannot use it. Its row of words is absolutely positioned over the
//   picture, so the same `::after` would resolve against that row and cover a
//   sixth of the card. The hero gets the overlay as a DIRECT CHILD of the
//   article instead: one pointer surface, aria-hidden, carrying no keyboard
//   duty, because the keyboard already has `Go`.
//
// The focus ring goes on the CARD, keyed to that one button
// (`has-[button:focus-visible]:focus-ring`, the wrapper idiom `ui/tokens.ts`
// documents for `InboxSearchInput`). A 2px ring around a 30px pill is the wrong
// answer to "what will Enter do here" when Enter opens the whole card, and two
// rings for one tab stop is the failure that idiom's own note warns about — so
// `Go` gives its ring up and the card wears it.

import React from 'react'

import type { HostedCard } from '../../../../../../../shared/hosted-card-feed'
import { cardStampLabel } from '../../../../extensions/homeCards'
import { OutlineButton, PrimaryButton } from '../../../../ui/Buttons'
import { CardArt } from './cardArt'
import { CardSplash, CardSplashScrim, CardSplashStamp, CardSplashTitle } from './cardSplash'

/**
 * The card's shell, both shapes.
 *
 * A hairline and the surface do the containing, and the two things that move on
 * hover are the ground and that hairline. The ground is what a person sees on
 * an ordinary card, where the body is real estate the picture does not cover;
 * on the hero the picture covers everything, so the hairline is the whole of
 * the hover. Both are in the mockup's own rule (`.card:hover`) and neither
 * moves a pixel of layout.
 */
// `has-[button:focus-visible]:focus-ring` is written out here as ONE literal and
// never assembled, for the reason `ui/tokens.ts` sets out at length: Tailwind
// generates a rule only for a candidate it can see as literal text, so a variant
// built from a constant and a prefix ships no CSS and no focus indicator at all.
// It stays here rather than joining the constants in `tokens.ts` because it is
// this card's own composition — the card is the ring's box, the button is its
// trigger — and the accessibility contract test enumerates that file exactly.
const SHELL =
  'relative flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border ' +
  'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] ' +
  'transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)] ' +
  'has-[button:focus-visible]:focus-ring'

/**
 * The overlay that makes the card the target, in the two shapes it takes.
 *
 * No layer of its own in either: painting order is DOM order here, and both sit
 * after the plate they cover. The one piece of furniture that DID have a layer —
 * the stamp — now stands out of the pointer's way instead (`cardSplash.tsx`), so
 * the top-right corner of a card is not the one square of poster that does
 * nothing when you press it.
 *
 * Both spelled out in full, and neither assembled from the other: `after:` is a
 * variant, and a variant Tailwind cannot read as literal text in a source file
 * produces no CSS (`ui/tokens.ts` has the long version of this).
 */
const HERO_OVERLAY = 'absolute inset-0'
const GO_OVERLAY = 'after:absolute after:inset-0'

/**
 * The button, and the only control on the card.
 *
 * Its accessible name carries the card's title after the word on the button, so
 * a reader working through the page hears which card each `Go` belongs to
 * rather than seven identical buttons. The visible label leads it, which is
 * what keeps the name a superset of the label rather than a replacement for it.
 */
function CardGo({
  title,
  accent,
  stretch,
  onGo,
}: {
  title: string
  accent: boolean
  /** Own the card-wide hit area as a pseudo-element. The ordinary card only. */
  stretch: boolean
  onGo: () => void
}): JSX.Element {
  const props = {
    'aria-label': `Go — ${title}`,
    // `focus-visible:outline-none` discharged by the card, not left dangling:
    // `SHELL` above draws the shared ring on the article whenever this button is
    // focus-visible, which is one indicator on one tab stop rather than two.
    // The card is what Enter acts on, so the card is what the ring should
    // outline.
    className: `focus-visible:outline-none ${stretch ? GO_OVERLAY : ''}`,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      // The overlay is this button's own pseudo-element on an ordinary card, so
      // there is nothing to stop; on the hero the overlay is a sibling and this
      // press never reaches it either. Kept anyway, and cheap: it is the guard
      // that makes one press one run whatever a later shape does with the
      // pointer surface.
      event.stopPropagation()
      onGo()
    },
    children: 'Go',
  }
  return accent ? <PrimaryButton size="md" {...props} /> : <OutlineButton {...props} />
}

/**
 * A card, in the shape the grid gave it: the hero spanning the width at 2.7:1,
 * or one of the two columns at 16:9.
 *
 * The hero keeps its words on the picture — title, dek, credit and button all
 * inside the scrim — because a 2.7:1 plate with a body under it would be a
 * billboard with a caption. An ordinary card puts the title on the picture and
 * everything after it in the body, which is what the scrim's fade into
 * `--bg-surface` exists to join.
 */
export function CardPoster({
  card,
  shape = 'card',
  onGo,
}: {
  card: HostedCard
  shape?: 'card' | 'hero'
  onGo: () => void
}): JSX.Element {
  const stamp = cardStampLabel(card.kind)
  // Painting order IS DOM order for the splash's furniture (cardSplash.tsx):
  // artwork, then scrim, then title. The stamp takes its own layer, so it may
  // come last and still sit over everything.
  if (shape === 'hero') {
    return (
      <article className={SHELL}>
        <CardSplash shape="hero">
          <CardArt name={card.art} />
          <CardSplashScrim />
          <CardSplashTitle shape="hero" title={card.title}>
            <div className="mt-2.5 flex items-end gap-5">
              <div className="min-w-0 flex-1">
                <p className="m-0 max-w-[62ch] text-body leading-relaxed text-[color:var(--text-default)]">
                  {card.dek}
                </p>
                {card.credit ? (
                  <p className="m-0 mt-1.5 truncate text-micro text-[color:var(--text-subtle)]">
                    {card.credit}
                  </p>
                ) : null}
              </div>
              <CardGo title={card.title} accent stretch={false} onGo={onGo} />
            </div>
          </CardSplashTitle>
          <CardSplashStamp label={stamp} />
        </CardSplash>
        {/* The hero's pointer surface. It is a direct child of the article
            because every other candidate is absolutely positioned inside the
            splash, and an overlay resolves against the nearest positioned
            ancestor rather than against the card it means. `aria-hidden` and no
            tab stop: this is glass for a mouse, and the keyboard's way in is the
            `Go` inside it.

            Last, and so over the `Go` as well — deliberately, and at the cost of
            that one button's own hover tint. Lifting the button back out from
            under it would take a z-index the ladder does not have a rung for,
            and the card is ONE target: a press on the glass over the button runs
            exactly what the button runs, and the hover a person sees is the
            card's ground and hairline moving, which is the whole of the hover
            the task-card family allows anyway. */}
        <span aria-hidden="true" className={HERO_OVERLAY} onClick={() => onGo()} />
      </article>
    )
  }
  return (
    <article className={SHELL}>
      <CardSplash>
        <CardArt name={card.art} />
        <CardSplashScrim />
        <CardSplashTitle title={card.title} />
        <CardSplashStamp label={stamp} />
      </CardSplash>
      {/* The scrim has already carried the title down onto this ground, so the
          body starts close to it rather than at a full step — the mockup's
          `.card--overlay .card-body` rule. The foot is pushed to the bottom so
          that a row of cards with deks of different lengths still lines its
          buttons up. */}
      <div className="flex flex-1 flex-col px-4 pt-1 pb-4">
        <p className="m-0 text-meta leading-relaxed text-[color:var(--text-muted)]">{card.dek}</p>
        <div className="mt-auto flex items-center gap-2.5 pt-4">
          {/* A credit, not a manifest: one line, truncated rather than wrapped,
              because it tells somebody who knows the tool that this is the
              tool and tells everybody else nothing they need. */}
          {card.credit ? (
            <span className="min-w-0 flex-1 truncate text-micro text-[color:var(--text-subtle)]">
              {card.credit}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0">
            <CardGo title={card.title} accent={false} stretch onGo={onGo} />
          </span>
        </div>
      </div>
    </article>
  )
}
