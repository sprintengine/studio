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
// task-card family contract: no lift, no shadow, no scale. The press is carried
// by the article rather than by a stretched hit area inside the button, because
// the hero has no card body at all: its row of words is absolutely positioned
// over the picture, and an overlay inside an absolutely positioned button
// resolves against the button rather than against the card. One mechanism for
// both shapes beats two that differ by where the button happens to sit. `Go`
// stops the click from reaching the article so the handler runs once.

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
const SHELL =
  'relative flex w-full cursor-pointer flex-col overflow-hidden rounded-lg border ' +
  'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] ' +
  'transition-colors hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)]'

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
  onGo,
}: {
  title: string
  accent: boolean
  onGo: () => void
}): JSX.Element {
  const props = {
    'aria-label': `Go — ${title}`,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      // The card is the target too, and both press the same button. Stopping
      // here is what makes one press one run.
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
      <article onClick={onGo} className={SHELL}>
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
              <CardGo title={card.title} accent onGo={onGo} />
            </div>
          </CardSplashTitle>
          <CardSplashStamp label={stamp} />
        </CardSplash>
      </article>
    )
  }
  return (
    <article onClick={onGo} className={SHELL}>
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
            <CardGo title={card.title} accent={false} onGo={onGo} />
          </span>
        </div>
      </div>
    </article>
  )
}
