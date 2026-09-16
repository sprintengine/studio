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
// **Every card's action carries the accent** (owner, 2026-09-06), and the
// exception is written into the system rather than argued here — see
// `principles.md`, "The accent budget", the storefront paragraph.
//
// This file spent the accent once, on the hero, and outlined the rest. That was
// a correct reading of the budget and the wrong reading of the page: the budget
// is a rule about a WORKING surface, where a second accent means missing
// hierarchy. A grid of posters is not one. There the picture and the title do
// the ranking and the button is furniture that has to be findable — and an
// outlined 26px pill under three lines of grey dek was the quietest thing on a
// card whose whole job is to have one thing to press. Every storefront the
// review compared accents every row's primary action.
//
// What is NOT constant across those rows is the word. See `cardActionLabel`.
//
// **The whole card is the target, and hover is a background change only** — the
// task-card family contract: no lift, no shadow, no scale.
//
// **Unless there is nothing to target.** A card whose `go` is empty draws no
// button, no glass, no hover and no cursor — it is a poster, which is what the
// schema means by "a showcase card can be pure marketing" (item
// `2026-09-06-a-card-with-nothing-to-run-has-no-go`). Everything in the two
// paragraphs above is about a card that ACTS, and the reasoning for the other
// kind is beside `acts` in `CardPoster`.
//
// **`Go` opens the model picker, and choosing a row is what runs the card**
// (owner ruling R4b, 2026-09-06, item 2473). The button is the picker's
// trigger: nothing installs and nothing runs until a row is chosen, and the row
// that is chosen carries the cli, model, reasoning and permission preset the
// run launches on. What that is NOT is the consent screen R4 removed — the
// reasoning is in `CardGoPicker.tsx`, which is the surface this opens.
//
// **On a card that spawns.** R4b is about how to run an agent, so it applies
// where an agent runs: a card whose `go` holds no `open.chat` gets a plain
// button and one press runs it (`cardRunsAModel`, and item
// `2026-09-06-go-asks-which-model-only-when-a-model-runs`). Two hosts, one
// button — `goButtonProps` below is everything they share, so the label, the
// disabled rule and the busy state cannot drift apart — and the glass over the
// card keeps doing whatever the button does.
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
// answers for: ONE pointer surface, a direct child of the article, aria-hidden,
// carrying no keyboard duty because the keyboard already has `Go`.
//
// Both shapes take that same overlay now, and the ordinary card's `::after`
// went with the picker. A pseudo-element resolves against the nearest
// POSITIONED ancestor, and `Go` is wrapped by the picker's own
// `relative inline-flex` anchor from the moment it became a popover trigger —
// so the stretch that used to cover the whole card would cover a 30px pill.
// The hero never had the option for the same reason on a different box: its row
// of words is absolutely positioned over the picture.
//
// `Go` is RAISED OUT of the glass by the ladder's in-card step (`--z-sticky`,
// the rung `WizardProgress` uses to lift painted text over its own track). Both
// the glass and the picker's anchor are positioned with an automatic level, so
// they paint in tree order and the glass — which has to be last, to cover the
// card — was covering the button too. That cost the button its own hover tint,
// and it cost more than that: a pointer could not reach `Go` at all, and the
// only press that could close the picker was one outside the card. One rung is
// the whole fix, and the card stays one target because the glass opens exactly
// what the button opens.
//
// The focus ring goes on the CARD, keyed to that one button
// (`has-[button:focus-visible]:focus-ring`, the wrapper idiom `ui/tokens.ts`
// documents for `InboxSearchInput`). A 2px ring around a 30px pill is the wrong
// answer to "what will Enter do here" when Enter opens the whole card, and two
// rings for one tab stop is the failure that idiom's own note warns about — so
// `Go` gives its ring up and the card wears it.

import React from 'react'

import type { HostedCard } from '../../../../../../../shared/hosted-card-feed'
import { cardActionLabel, cardStampLabel } from '../../../../extensions/homeCards'
import { PrimaryButton } from '../../../../ui/Buttons'
import { NewChip } from '../../../../ui/NewChip'
import { Popover } from '../../../../ui/Popover'
import { CardArt } from './cardArt'
import {
  CardGoPicker,
  cardRunsAModel,
  useCardLaunchDefaults,
  type CardLaunchChoice,
} from './CardGoPicker'
import { CardSplash, CardSplashScrim, CardSplashStamp, CardSplashTitle } from './cardSplash'

/**
 * The card's shell, both shapes and both temperaments.
 *
 * A hairline and the surface do the containing, and that is all a card is
 * unconditionally. Everything about being PRESSED lives in the second constant,
 * because a card with no actions is not pressed — see `CardPoster` below.
 */
const SHELL =
  'relative flex w-full flex-col overflow-hidden rounded-lg border ' +
  'border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)] transition-colors'

/**
 * The half of the shell that says "this is a target": the cursor, the two
 * things that move on hover, and the ring.
 *
 * The ground is what a person sees on an ordinary card, where the body is real
 * estate the picture does not cover; on the hero the picture covers everything,
 * so the hairline is the whole of the hover. Both are in the mockup's own rule
 * (`.card:hover`) and neither moves a pixel of layout.
 *
 * Held apart from `SHELL` for item
 * `2026-09-06-a-card-with-nothing-to-run-has-no-go`: a card whose `go` is empty
 * draws no button, so a pointer cursor and a hover tint would be the card
 * promising a press it has nothing to answer with — the same lie the dead
 * button was, moved into the styling.
 */
// `has-[button:focus-visible]:focus-ring` is written out here as ONE literal and
// never assembled, for the reason `ui/tokens.ts` sets out at length: Tailwind
// generates a rule only for a candidate it can see as literal text, so a variant
// built from a constant and a prefix ships no CSS and no focus indicator at all.
// It stays here rather than joining the constants in `tokens.ts` because it is
// this card's own composition — the card is the ring's box, the button is its
// trigger — and the accessibility contract test enumerates that file exactly.
const SHELL_PRESSABLE =
  'cursor-pointer hover:border-[color:var(--border-default)] hover:bg-[color:var(--bg-hover)] ' +
  'has-[button:focus-visible]:focus-ring'

/**
 * The overlay that makes the card the target, in the one shape both cards take.
 *
 * No layer of its own: painting order is DOM order here, and it sits after the
 * plate it covers. The one piece of furniture that DID have a layer — the stamp
 * — now stands out of the pointer's way instead (`cardSplash.tsx`), so the
 * top-right corner of a card is not the one square of poster that does nothing
 * when you press it.
 */
const CARD_OVERLAY = 'absolute inset-0'

/**
 * The rung `Go` is lifted onto so the card's glass paints UNDER it rather than
 * over it — see the note at the top of this file. The popover host wears it on
 * the anchor it wraps the trigger in; the direct host has no anchor, so it
 * wears the same `relative inline-flex` box itself, and both shapes therefore
 * occupy the same box in the same layout.
 */
const GO_ANCHOR = 'relative inline-flex z-[var(--z-sticky)]'

/**
 * Everything about the button that is the same whether or not a model runs.
 *
 * Its accessible name carries the card's title after the word on the button, so
 * a reader working through the page hears which card each button belongs to
 * rather than seven identical ones. The visible label leads it, which is what
 * keeps the name a superset of the label rather than a replacement for it.
 *
 * The word itself is `cardActionLabel(card)` — derived from what the card does,
 * never from a string the feed carries. `Install`, `Create`, `See it`,
 * `Open Skills`: the button is the card's entire disclosure, because R2
 * forbids the step list that would otherwise carry it.
 *
 * Shared rather than written twice on purpose: the two hosts below differ in
 * what a press DOES and in nothing else, and a card that opened a picker would
 * otherwise be allowed to drift from one that runs on the label, the disabled
 * rule or the busy state a reader is told about.
 */
function goButtonProps({
  card,
  running,
  disabled,
}: {
  card: HostedCard
  running: boolean
  disabled: boolean
}): Record<string, unknown> {
  // What this card offers, in one word — `Install`, `Create`, `Open Skills`.
  // Derived from the card's own actions and kind, so it cannot disagree with
  // what the press does (`cardActionLabel`).
  const action = cardActionLabel(card)
  return {
    'aria-label': `${action} — ${card.title}`,
    // Disabled for exactly as long as a run is in flight, which is the whole of
    // what this card shows about a run in progress: Go goes, and R4 rules out
    // a plan, a progress modal and any other ceremony between the press and the
    // work. `aria-busy` says the same thing to a reader without putting a
    // spinner on a poster.
    disabled,
    'aria-busy': running || undefined,
    // The UA outline off, discharged by the card: `SHELL` above draws the shared
    // ring on the article whenever this button is focus-visible, which is one
    // indicator on one tab stop rather than two. The card is what Enter acts on,
    // so the card is what the ring should outline.
    //
    // PLAIN `outline-none`, never the `focus-visible:` form — the wrapper idiom
    // this borrows from writes it exactly this way (`InboxSearchInput`'s inner
    // input). `ui/tokens.ts` states the reason: the `focus-ring` utility's
    // outline REPLACES the UA one, so a focus-scoped `outline-none` beside it is
    // an equal-specificity rule and which of the two wins becomes a matter of
    // stylesheet order. It is also what `accessibility-contracts.test.ts`
    // polices as a hand-rolled focus treatment — this line was the app's only
    // offender, found on 2026-09-06 once the assertion above it stopped aborting
    // that suite at its first failure.
    className: 'outline-none',
    children: action,
  }
}

/**
 * `Go` on a card that runs no model: a plain button, and one press runs the
 * card (item `2026-09-06-go-asks-which-model-only-when-a-model-runs`).
 *
 * The gate is `cardRunsAModel`, which reads the card's ACTIONS — see its note
 * in `CardGoPicker.tsx` for why the picker has nothing to ask a card that
 * spawns nothing, and why `kind` would be the same bug with a different key.
 *
 * The launch it sends is `useCardLaunchDefaults()`, the app's own defaults, and
 * the wire shape is unchanged: `CardLaunchChoice` is still required, still
 * carries four fields, and `runCardGo` reads none of them outside the branch a
 * card with no `open.chat` cannot reach. No second envelope, and nothing
 * downstream has to learn that a second kind of press exists.
 */
function CardGoDirect({
  card,
  hero,
  running,
  disabled,
  onPress,
}: {
  card: HostedCard
  /** The wide plate at the top of the page: the same accent, a larger control. */
  hero: boolean
  running: boolean
  disabled: boolean
  onPress: () => void
}): JSX.Element {
  const props = {
    ...goButtonProps({ card, running, disabled }),
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      // Same guard the popover trigger carries, for the same reason: the glass
      // is a sibling painted under this button, and stopping here is what keeps
      // one press one run whatever a later shape does with the pointer surface.
      event.stopPropagation()
      onPress()
    },
  }
  return (
    <span className={GO_ANCHOR}>
      {/* Same button either way — the hero's is a size larger because its plate
          is, not because it is the only one that counts. */}
      <PrimaryButton size={hero ? 'md' : 'sm'} {...props} />
    </span>
  )
}

/**
 * `Go` on a card that spawns: the picker's trigger, and choosing a row is the
 * press that runs the card (R4b).
 */
function CardGo({
  card,
  hero,
  running,
  disabled,
  open,
  onOpenChange,
  onLaunch,
}: {
  card: HostedCard
  /** The wide plate at the top of the page: the same accent, a larger control. */
  hero: boolean
  /** This card's own run is in flight. */
  running: boolean
  /** A run is in flight — this card's or another's. */
  disabled: boolean
  /** The picker's open state, owned by the card so its glass can open it too. */
  open: boolean
  onOpenChange: (open: boolean) => void
  onLaunch: (choice: CardLaunchChoice) => void
}): JSX.Element {
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel={`Run ${card.title}`}
      popupRole="dialog"
      placement="bottom-end"
      surfaceClassName="overflow-hidden"
      // The anchor Popover wraps the trigger in, raised one rung so the card's
      // glass paints under this button instead of over it — see the note at the
      // top of this file. `relative inline-flex` is Popover's own; only the rung
      // is passed, which is why `GO_ANCHOR` above states all three for the host
      // that has no Popover to inherit them from.
      className="z-[var(--z-sticky)]"
      renderTrigger={({ ref, triggerProps, togglePopover }) => {
        const props = {
          ref,
          ...goButtonProps({ card, running, disabled }),
          onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
            // The glass is a sibling painted UNDER this button, so a press here
            // is this button's alone. Stopped anyway, and cheap: it is the
            // guard that makes one press one popover whatever a later shape
            // does with the pointer surface.
            event.stopPropagation()
            togglePopover()
          },
          ...triggerProps,
        }
        return <PrimaryButton size={hero ? 'md' : 'sm'} {...props} />
      }}
    >
      {/* Rendered only while open, which is what keeps the composer hook — the
          plugin catalogue, the remembered engine defaults — off a page drawing
          seven cards. Choosing a row closes this and starts the run: one
          action, and nothing to agree to afterwards (R4b). */}
      <CardGoPicker
        card={card}
        onChoose={(choice) => {
          onOpenChange(false)
          onLaunch(choice)
        }}
        // The install route opens Settings OVER this popover, and a popover
        // left standing under a modal is what the person finds when the modal
        // closes.
        onNavigate={() => onOpenChange(false)}
      />
    </Popover>
  )
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
  running = false,
  disabled = false,
  isNew = false,
  onLaunch,
}: {
  card: HostedCard
  shape?: 'card' | 'hero'
  /** This card's own run is in flight. */
  running?: boolean
  /** A run is in flight somewhere on the page, so no card may start a second. */
  disabled?: boolean
  /**
   * Published since the person last opened the home, so it wears the New chip
   * (`newHomeCardSlugs`, `homeCards.ts`). Never a hoist and never a sort key —
   * the grid's order is the feed's editorial decision and the chip is the only
   * difference (`design-system/components/badge/component.md`, "The New mark").
   */
  isNew?: boolean
  /**
   * The press that runs the card: a row chosen in the picker on a card that
   * spawns, and the button itself on a card that does not.
   */
  onLaunch: (choice: CardLaunchChoice) => void
}): JSX.Element {
  const stamp = cardStampLabel(card.kind)
  // The New chip rides the CORNER, beside the kind stamp, rather than sitting
  // inline after the title — and both halves of that are deliberate.
  //
  // The accent budget is the first half. The hero keeps everything inside the
  // scrim, `Go` included, so its title block ALREADY spends the page's one
  // accent on the control; a second accent an inch away would put two of them
  // in one band of one plate. The stamp's corner is the card's other label
  // furniture, it is quiet, and it is the same place on both shapes — a mark
  // that moved between the hero and an ordinary card would read as two
  // different marks.
  //
  // The clamp is the second half. Both titles are `line-clamp-2` (cardSplash),
  // so an inline chip after a title that already wraps twice lands on a third
  // line and is clipped away entirely — the mark would be missing on exactly
  // the cards with the longest names.
  //
  // It stays READABLE rather than `decorative`: nothing here writes an
  // accessible name for the card. The one hand-written name on a poster is
  // `Go`'s, which names the BUTTON ("Install — <title>"), so hiding the chip
  // would delete the word "New" for anyone not looking at the picture. It falls
  // after the title in reading order, which is where the badge doc puts it.
  const mark = isNew ? <NewChip /> : null
  // Has this card anything to do at all? (item
  // `2026-09-06-a-card-with-nothing-to-run-has-no-go`.)
  //
  // An empty `go` is legal and `hosted-card-feed.ts` says why — "a showcase card
  // can be pure marketing, so it is not a reason to drop the row". Nothing after
  // that point used to agree with it: `CardPoster` drew a `Go` for every card,
  // `runCard` looped over nothing and reported success, and `runCardGo` took
  // neither of its branches. The button was pressed and NOTHING happened — no
  // toast, no navigation, no error — which is the one outcome the executor's own
  // header says it exists to prevent, arriving by the front door.
  //
  // The answer taken is the item's option 1: **a card that cannot act does not
  // offer to.** It draws no button, and with no button it is a poster, which is
  // what "pure marketing" means and what the schema's own sentence already
  // promises. Option 2 — refusing an empty `go` in `parseCard` and deleting that
  // sentence — was the alternative, and it is the wrong one twice over: it makes
  // the schema narrower than the thing it describes, and it answers a rendering
  // question in the parser, where a build that had simply not shipped a card's
  // button yet would look identical to a feed error. It is also the reading that
  // matches the ruling next door, that a card with no artwork is not rendered
  // rather than rendered badly: the missing piece decides the card's shape, and
  // is not papered over.
  //
  // A toast was explicitly not the answer. "Nothing to do" is not news anybody
  // needs after pressing a button they should never have been offered.
  const acts = card.go.length > 0
  // Which of the two `Go`s this card gets, read from its ACTIONS
  // (`cardRunsAModel`, `CardGoPicker.tsx`; item
  // `2026-09-06-go-asks-which-model-only-when-a-model-runs`). A card that
  // spawns nothing has no model to be asked about, so it is not asked.
  const spawns = cardRunsAModel(card)
  // The defaults a direct press launches on. Read unconditionally, as a hook
  // must be, and cheap: two primitive selectors off the settings the picker
  // would have resolved the same values from.
  const defaults = useCardLaunchDefaults()
  // The picker's open state lives HERE rather than on the button, because the
  // glass over the card opens the same popover the button does and a card is
  // one target. A run in flight closes it and keeps it shut: the popover must
  // not be openable on a card that is already working, and one left standing
  // over a card whose run has started is a second row waiting to be clicked.
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  // Whether the picker was open when the pointer went DOWN, which is the only
  // moment at which this glass can tell an opening press from a closing one.
  //
  // The popover dismisses itself on any mousedown outside its surface and its
  // trigger — and this glass is neither — so by the time the click arrives the
  // picker is already shut and `open` already reads false. A press that read
  // the state at click time would therefore reopen what the person had just
  // closed, every time, and the picker could only be dismissed by clicking off
  // the card altogether. Reading it at mousedown is what makes a second press
  // on the card close the picker, which is what a person means by pressing
  // again.
  const openAtPress = React.useRef(false)
  // No glass on a poster, and the review focus asked the question directly:
  // does the overlay still make sense on a card that opens nothing? It does
  // not. The glass exists to make the whole card press `Go`, so on a card with
  // no `Go` it is a transparent sheet over a picture that swallows the pointer
  // and answers nothing.
  const glass = !acts ? null : (
    /* The card's pointer surface. It is a direct child of the article because
       every other candidate is absolutely positioned inside the splash, and an
       overlay resolves against the nearest positioned ancestor rather than
       against the card it means. `aria-hidden` and no tab stop: this is glass
       for a mouse, and the keyboard's way in is the `Go` inside it.

       Last, and so over everything the card draws — except `Go`, which is
       raised one rung out from under it so the button keeps its own hover tint
       and its own press. The card is still ONE target: the glass DOES WHAT THE
       BUTTON DOES, which is now two different things — it opens the picker on a
       card that spawns and runs the card on one that does not. `openAtPress`
       above is the popover half's business and is read nowhere else; a direct
       card has no state to reopen, so its glass is a plain press. Splitting
       here rather than at the button is what keeps "the card is the target"
       true for both shapes: a glass that always toggled `open` would leave a
       poster card's whole area inert but for its 30px pill. */
    <span
      aria-hidden="true"
      className={CARD_OVERLAY}
      onMouseDown={() => {
        openAtPress.current = open
      }}
      onClick={() => {
        if (disabled) return
        if (spawns) setOpen(!openAtPress.current)
        else onLaunch(defaults)
      }}
    />
  )
  // The one control, or nothing. A poster is not a tab stop and wears no focus
  // ring, and that is the deliberate part of this rather than a gap: the ring is
  // keyed to the button (`has-[button:focus-visible]`, `SHELL_PRESSABLE`), a
  // card with no button has nothing for Enter to do, and a tab stop that
  // answers no key is worse for a keyboard than not being there. The card still
  // reads: its title is a heading, its stamp and its credit are text, and a
  // reader walks it as content because content is what it is.
  const go = !acts ? null : spawns ? (
    <CardGo
      card={card}
      hero={shape === 'hero'}
      running={running}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      onLaunch={onLaunch}
    />
  ) : (
    <CardGoDirect
      card={card}
      hero={shape === 'hero'}
      running={running}
      disabled={disabled}
      onPress={() => onLaunch(defaults)}
    />
  )
  // Painting order IS DOM order for the splash's furniture (cardSplash.tsx):
  // artwork, then scrim, then title. The stamp takes its own layer, so it may
  // come last and still sit over everything.
  if (shape === 'hero') {
    return (
      <article className={acts ? `${SHELL} ${SHELL_PRESSABLE}` : SHELL}>
        <CardSplash shape="hero">
          <CardArt name={card.art} />
          <CardSplashScrim />
          <CardSplashTitle shape="hero" title={card.title}>
            <div className="mt-2.5 flex items-end gap-5">
              <div className="min-w-0 flex-1">
                {/* Two lines, and the clamp is load-bearing rather than tidy.
                    The hero plate's floor (`HERO_PLATE_MIN_HEIGHT_PX`,
                    `cardSplash.tsx`) is derived from the TALLEST stack this
                    overlay can legally draw, and the dek was the one part of
                    that stack with no ceiling on it — a dek long enough to
                    wrap three or four times in a narrow region climbs out of
                    the scrim's band and then out of the plate, which is the
                    failure the floor exists to stop, and no floor can be
                    derived from a height that has no maximum.

                    `max-w-[62ch]` already caps how WIDE the column gets, which
                    is what makes two lines the shape a shipped dek already
                    takes on a wide plate; this caps how TALL it gets when the
                    region is narrow enough to squeeze that column. Same
                    device, at the same count, as the title's own clamp
                    directly above, and for the reason
                    `SCRIM_CLEAR_STOP_FRACTION`'s note gives for that one: past
                    the clamp a line is over open artwork. */}
                <p className="m-0 line-clamp-2 max-w-[62ch] text-body leading-relaxed text-[color:var(--text-default)]">
                  {card.dek}
                </p>
                {card.credit ? (
                  <p className="m-0 mt-1.5 truncate text-micro text-[color:var(--text-subtle)]">
                    {card.credit}
                  </p>
                ) : null}
              </div>
              {go}
            </div>
          </CardSplashTitle>
          <CardSplashStamp label={stamp} mark={mark} />
        </CardSplash>
        {/* Disabled with the button it fronts. The glass is the card's hit
            area, so a run already in flight must not open a picker through it
            either — the button below is where the one press lives. */}
        {glass}
      </article>
    )
  }
  return (
    <article className={acts ? `${SHELL} ${SHELL_PRESSABLE}` : SHELL}>
      <CardSplash>
        <CardArt name={card.art} />
        <CardSplashScrim />
        <CardSplashTitle title={card.title} />
        <CardSplashStamp label={stamp} mark={mark} />
      </CardSplash>
      {/* The scrim has already carried the title down onto this ground, so the
          body starts close to it rather than at a full step — the mockup's
          `.card--overlay .card-body` rule. The foot is pushed to the bottom so
          that a row of cards with deks of different lengths still lines its
          buttons up. */}
      <div className="flex flex-1 flex-col px-4 pt-1 pb-4">
        <p className="m-0 text-meta leading-relaxed text-[color:var(--text-muted)]">{card.dek}</p>
        {/* The foot exists only when it holds something. A card with no credit
            and no button would otherwise leave a step of padding under the dek
            and a `mt-auto` pushing an empty box to the bottom of the body — a
            card that looks like it lost its button rather than one that never
            had one. */}
        {card.credit || go ? (
          <div className="mt-auto flex items-center gap-2.5 pt-4">
            {/* A credit, not a manifest: one line, truncated rather than
                wrapped, because it tells somebody who knows the tool that this
                is the tool and tells everybody else nothing they need. */}
            {card.credit ? (
              <span className="min-w-0 flex-1 truncate text-micro text-[color:var(--text-subtle)]">
                {card.credit}
              </span>
            ) : null}
            {go ? <span className="ml-auto flex shrink-0">{go}</span> : null}
          </div>
        ) : null}
      </div>
      {glass}
    </article>
  )
}
