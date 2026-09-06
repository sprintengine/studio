// The artwork a card resolves to, and the ruling that a card which cannot
// resolve one does not render.
//
// A card's `art` field is a NAME, never a URL (src/shared/hosted-card-feed.ts).
// The name is looked up here, against artwork this build already shipped, and
// that is the whole of the mechanism: a card can never point the app at an
// arbitrary image host, and the feed stays a small text file. New artwork rides
// along with a release, the way the rest of the product's assets do.
//
// The owner's ruling (2026-09-06, `2026-09-06-card-splashes.html` Frame 3) is
// the other half: **a card whose artwork this build does not have is not
// rendered, and does not fall back to a grey rectangle with a word on it.** A
// home page of grey rectangles teaches nobody anything and would be worse than
// the catalogue it replaced, so fewer and better is the correct trade. The
// ruling is enforced in `renderableCards.ts`; `hasCardArt` below is the
// predicate it asks.
//
// What is drawn here are STAND-INS, and they are deliberately obvious about it.
// A shipped card carries a real capture — the studio over the Unreal editor, a
// board mid-run, an agent clicking through an app — and the shot list that says
// which is in the mockup. Until those exist the plates are line drawings in
// `currentColor` over token-built grounds, which is why they are correct in
// both modes with no per-mode override and cost nothing to ship. Real captures
// replace these plate-for-plate later; this record is the seam they replace
// them at.
//
// Every plate is decoration. Not one of them carries a fact a reader needs, and
// the strings inside them are fake window chrome, so the whole picture is
// hidden from assistive technology — see `CardArt` at the foot of this file.

import React from 'react'

import { CARD_ART_NAMES, type CardArtName } from './cardArtNames'

export { CARD_ART_NAMES, type CardArtName }

/**
 * The two plate treatments the mockup uses, and every plate is one of them.
 *
 * A `Shot` is the framed "app window": a title bar with three dots and a label
 * over a body, bleeding off the bottom edge of the splash the way a promo
 * screenshot does. It is a picture OF the product, not a panel IN the card,
 * which is why it has no bottom border and no bottom inset.
 *
 * A `Scene` is the lit plate: a ground that lifts towards the top, a wash in
 * the accent (or the warm tone, for a card that is showing something the studio
 * made rather than the studio itself), an optional horizon, and one thing
 * standing on it.
 */

/**
 * The plates that are line art, which is all of them but `board`: the board is
 * built out of real elements because the four lanes and the tones in them ARE
 * the picture, and a drawing of a board is not a board.
 */
type GlyphName = Exclude<CardArtName, 'board'>

/** Line art at 96×96 in `currentColor`, ported from the mockup's sprite. */
function Glyph({
  name,
  className,
  strokeWidth = 2,
}: {
  name: GlyphName
  className?: string
  strokeWidth?: number
}): JSX.Element {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH_PATHS[name]}
    </svg>
  )
}

const GLYPH_PATHS: Record<GlyphName, JSX.Element> = {
  browser: (
    <>
      <rect x="10" y="18" width="76" height="56" rx="5" />
      <path d="M10 32h76" />
      <circle cx="19" cy="25" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="26" cy="25" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="33" cy="25" r="1.6" fill="currentColor" stroke="none" />
      <path d="M22 44h26M22 53h18" />
      <path d="M58 44l16 20-7 1 4 8-4 2-4-8-5 5z" fill="currentColor" fillOpacity=".14" />
      <circle cx="58" cy="44" r="11" strokeDasharray="3 5" />
    </>
  ),
  city: (
    <>
      <circle cx="72" cy="24" r="8" />
      <path d="M8 76h80" />
      <path d="M16 76V50l12-8 12 8v26" />
      <path d="M28 42V32" />
      <path d="M46 76V58l10-7 10 7v18" />
      <path d="M70 76V62l8-5 8 5v14" />
      <path d="M23 76v-9h10v9M53 76v-8h6v8" />
      <path d="M4 84h88" strokeDasharray="4 6" />
    </>
  ),
  split: (
    <>
      <rect x="8" y="36" width="24" height="24" rx="4" fill="currentColor" fillOpacity=".12" />
      <path d="M32 48h12M44 48V22h12M44 48v26h12M44 48h12" />
      <rect x="60" y="12" width="26" height="20" rx="4" />
      <rect x="60" y="38" width="26" height="20" rx="4" />
      <rect x="60" y="64" width="26" height="20" rx="4" />
      <path d="M66 22h14M66 48h14M66 74h14" strokeOpacity=".55" />
    </>
  ),
  tokens: (
    <>
      <rect x="12" y="16" width="20" height="20" rx="3" fill="currentColor" fillOpacity=".22" />
      <rect x="38" y="16" width="20" height="20" rx="3" fill="currentColor" fillOpacity=".14" />
      <rect x="64" y="16" width="20" height="20" rx="3" fill="currentColor" fillOpacity=".06" />
      <path d="M12 50h72M12 62h52M12 74h34" />
      <path d="M12 44v-4M38 44v-4M64 44v-4M84 44v-4" />
    </>
  ),
  braces: (
    <>
      <path d="M34 20c-8 0-8 8-8 14s-6 14-6 14 6 0 6 14 0 14 8 14" />
      <path d="M62 20c8 0 8 8 8 14s6 14 6 14-6 0-6 14 0 14-8 14" />
      <path d="M40 40h16M40 56h10" />
      <circle cx="58" cy="56" r="4" fill="currentColor" fillOpacity=".2" />
    </>
  ),
  plane: (
    <>
      <path
        d="M14 60h34a6 6 0 0 0 6-6V30a6 6 0 0 0-6-6H14a6 6 0 0 0-6 6v24a6 6 0 0 0 6 6z"
        strokeOpacity=".5"
      />
      <path d="M20 74l-4 10 10-4" />
      <path d="M88 22L56 42l10 6 4 14 8-12 10 4z" fill="currentColor" fillOpacity=".14" />
      <path d="M88 22L66 48" />
    </>
  ),
  clock: (
    <>
      <circle cx="44" cy="50" r="24" />
      <path d="M44 36v14l10 6" />
      <path d="M70 20a34 34 0 0 1 12 22" />
      <path d="M74 14l8 6-7 7" />
    </>
  ),
  graph: (
    <>
      <circle cx="18" cy="48" r="8" fill="currentColor" fillOpacity=".12" />
      <circle cx="48" cy="24" r="8" />
      <circle cx="48" cy="72" r="8" />
      <circle cx="78" cy="48" r="8" />
      <path d="M25 44l16-13M25 52l16 13M55 29l16 13M55 67l16-13" />
    </>
  ),
  spark: (
    <>
      <path d="M40 16l7 19 19 7-19 7-7 19-7-19-19-7 19-7z" fill="currentColor" fillOpacity=".14" />
      <path d="M70 54l4 10 10 4-10 4-4 10-4-10-10-4 10-4z" />
    </>
  ),
}

/**
 * The wash that sits over the whole plate.
 *
 * It is a layer rather than a pseudo-element so the tone is a prop rather than
 * a class the caller has to remember, and it is painted by the ARTWORK rather
 * than by the splash frame. That is a trade, and it is worth writing down: the
 * mockup hangs temperature on the frame (`.splash--warm`), which would make it
 * a per-card field the feed could set, and we hang it on the picture instead.
 * The frame knows the shape of the plate; the plate knows its own temperature.
 * The consequence is that a card cannot warm or cool the artwork it names —
 * `city` is warm because a picture of somebody's street is warm, and no card
 * that names `city` may decide otherwise. If a card ever needs that knob it
 * belongs on the feed's schema and on the frame, not smuggled in here.
 */
function PlateWash({ tone }: { tone: PlateTone }): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: `linear-gradient(150deg, ${tone === 'warm' ? 'var(--tone-warn-soft)' : 'var(--accent-primary-soft-strong)'}, transparent 62%)`,
      }}
    />
  )
}

type PlateTone = 'accent' | 'warm'

/**
 * The framed app window. Inset on three sides and flush with the bottom edge:
 * a promo screenshot runs off the frame, and a shot that stopped short of it
 * would read as a panel inside the card instead of a picture of software.
 *
 * The label is CHROME, not copy. It is the strip of text a window manager would
 * be drawing, so it says where the window is — an app name, a URL, a file path
 * — and it never says what the software just did. A label that made a claim
 * would be a second, unedited headline sitting two centimetres above the card's
 * real one, free to contradict it: the same plate serves whichever card names
 * it, and the card's title is the only place the product speaks.
 */
function Shot({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-5 top-5 bottom-0 flex flex-col overflow-hidden rounded-t-[var(--radius-sm)] border border-b-0 border-[color:var(--border-default)] bg-[color:var(--bg-surface)] shadow-[var(--shadow-drawer)]"
    >
      <div className="flex flex-none items-center gap-1.5 border-b border-[color:var(--border-subtle)] px-2 py-1.5 text-micro text-[color:var(--text-subtle)]">
        <i className="size-1.5 rounded-full bg-[color:var(--border-strong)]" />
        <i className="size-1.5 rounded-full bg-[color:var(--border-strong)]" />
        <i className="size-1.5 rounded-full bg-[color:var(--border-strong)]" />
        <span className="ml-1.5 truncate">{label}</span>
      </div>
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  )
}

/** One of the placeholder lines that stand in for content inside a shot. */
function Line({ width, tone }: { width: string; tone?: 'ink' | 'accent' }): JSX.Element {
  const fill =
    tone === 'ink'
      ? 'bg-[color:var(--border-default)]'
      : tone === 'accent'
        ? 'bg-[color:var(--accent-primary)] opacity-50'
        : 'bg-[color:var(--border-subtle)]'
  return <span aria-hidden="true" className={`h-1.5 rounded-full ${fill}`} style={{ width }} />
}

/** The narrow column down the left of a shot, so the window reads as an app. */
function ShotRail(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="flex w-[22%] flex-none flex-col gap-1 border-r border-[color:var(--border-subtle)] p-2"
    >
      <Line width="85%" />
      <Line width="70%" />
      <Line width="50%" />
    </div>
  )
}

/**
 * The glyph as a shot stands it: centred in the window body at the size the
 * mockup draws it.
 *
 * One component rather than five call sites, so the plate size is written once.
 * design-tokens-allow: 76px is the mockup's own figure for a glyph inside a
 * shot (`2026-09-06-extensions-home.html`, `.shot-main svg`). It is the size of
 * a picture, not a step of spacing, and the icon ramp it would otherwise come
 * from tops out at 20px because it exists for chrome icons.
 */
function ShotGlyph({ name }: { name: GlyphName }): JSX.Element {
  return <Glyph name={name} className="mx-auto size-[76px] text-[color:var(--text-subtle)]" />
}

/**
 * One lane of the miniature board, and the chiplets standing in it.
 *
 * The mockup labels the lanes — Todo, Ready, Running, Done — at 7px, which is
 * below the 10px floor the design system holds every label to, and a decorative
 * plate is the last thing that should be buying an exception to it. The labels
 * are dropped rather than grown: at card size a lane is a finger wide, the warn
 * and good tones already say which lane is which, and the geometry is what
 * makes the picture read as a board. The alternative on the table was throwing
 * out the whole composition over a caption nobody stops to read.
 *
 * The lane ground is the raised surface where the mockup uses the themed canvas
 * (`--sem-color-bg-app`): a door never paints the canvas — that colour is the
 * sidebar's identity, and the gate at `scripts/lint-door-surfaces.mjs` holds
 * every surface under `globalSurface/` to it. A lane that lifts off the window
 * instead of sinking into it separates just as well, and keeps the plate inside
 * the door's own palette.
 */
function BoardLane({ count, tone }: { count: number; tone?: 'run' | 'done' }): JSX.Element {
  const chiplet =
    tone === 'run'
      ? 'bg-[color:var(--tone-warn-soft)] shadow-[inset_0_0_0_1px_var(--tone-warn)]'
      : tone === 'done'
        ? 'bg-[color:var(--tone-good-soft)] shadow-[inset_0_0_0_1px_var(--tone-good)]'
        : 'bg-[color:var(--bg-surface)] shadow-[inset_0_0_0_1px_var(--border-subtle)]'
  return (
    <div
      aria-hidden="true"
      className="flex flex-col gap-0.5 overflow-hidden rounded-[var(--radius-xs)] bg-[color:var(--bg-surface-raised)] p-1"
    >
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className={`h-3 flex-none rounded-[var(--radius-xs)] ${chiplet}`} />
      ))}
    </div>
  )
}

/**
 * The lit plate. The ground lifts from the selected tone at the top to the
 * surface at the bottom, which is also what the card body paints — so the
 * bottom of the plate and the top of the body are the same colour in either
 * mode and the join never reads as an edge.
 */
function Scene({
  tone = 'accent',
  horizon = false,
  children,
}: {
  tone?: PlateTone
  horizon?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 grid items-end overflow-hidden"
      style={{
        backgroundImage:
          'linear-gradient(to bottom, var(--bg-selected) 0%, var(--bg-surface-raised) 62%, var(--bg-surface) 100%)',
      }}
    >
      <PlateWash tone={tone} />
      {horizon ? (
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-[22%] h-px bg-[color:var(--border-default)]"
        />
      ) : null}
      {children}
    </div>
  )
}

/** The glyph as a scene stands it: centred, large, and running off the bottom. */
function SceneGlyph({ name, strokeWidth }: { name: GlyphName; strokeWidth: number }): JSX.Element {
  return (
    <Glyph
      name={name}
      strokeWidth={strokeWidth}
      className="relative mx-auto mb-[-6%] w-[62%] max-w-[260px] text-[color:var(--text-subtle)]"
    />
  )
}

/**
 * The registry. A name in, a plate out — and nothing else may be added to it
 * but a plate, because the whole safety property of the `art` field is that the
 * set of things a card can ask for is the set of things this build already
 * holds.
 */
export const CARD_ART: Record<CardArtName, () => JSX.Element> = {
  // A · the product working. The browser pane with an agent driving it, which
  // is the card the mockup draws first.
  browser: () => (
    <>
      <PlateWash tone="accent" />
      <Shot label="localhost:5173">
        <ShotRail />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 p-2">
          <Line width="50%" tone="ink" />
          <ShotGlyph name="browser" />
          <Line width="85%" />
        </div>
      </Shot>
    </>
  ),
  // B · the thing it made. The one card that is not our UI at all, and the warm
  // tone is how the page says so without a label.
  city: () => (
    <Scene tone="warm" horizon>
      <SceneGlyph name="city" strokeWidth={1.6} />
    </Scene>
  ),
  // C · both, side by side: the studio on one half and what it drove on the
  // other. The strongest picture the product has and the hardest to frame.
  split: () => (
    <>
      <PlateWash tone="accent" />
      <Shot label="SprintEngine Studio">
        <div className="flex min-w-0 flex-1 flex-col justify-center p-2">
          <ShotGlyph name="split" />
        </div>
      </Shot>
    </>
  ),
  // A · the product working, and the plate the hero wears. The miniature board
  // the mockups put behind the wide card (`2026-09-06-extensions-home.html`
  // `.shot-board`): four lanes, chiplets for the work in them, and the warn and
  // good tones carrying a run that is halfway through. It is the one picture in
  // the set that shows the product's actual shape rather than a symbol for it,
  // which is why the hero gets it and `split` does not.
  board: () => (
    <>
      <PlateWash tone="accent" />
      <Shot label="SprintEngine Studio">
        <div className="grid min-w-0 flex-1 grid-cols-4 gap-1 p-2">
          <BoardLane count={5} />
          <BoardLane count={3} />
          <BoardLane count={4} tone="run" />
          <BoardLane count={4} tone="done" />
        </div>
      </Shot>
    </>
  ),
  tokens: () => (
    <>
      <PlateWash tone="accent" />
      <Shot label="design-system / foundations / tokens.css">
        <div className="flex min-w-0 flex-1 flex-col justify-center p-2">
          <ShotGlyph name="tokens" />
        </div>
      </Shot>
    </>
  ),
  graph: () => (
    <>
      <PlateWash tone="accent" />
      <Shot label="SprintEngine Studio">
        <ShotRail />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-1 p-2">
          <Line width="50%" tone="ink" />
          <ShotGlyph name="graph" />
          <Line width="35%" tone="accent" />
        </div>
      </Shot>
    </>
  ),
  braces: () => (
    <Scene>
      <SceneGlyph name="braces" strokeWidth={1.8} />
    </Scene>
  ),
  plane: () => (
    <Scene>
      <SceneGlyph name="plane" strokeWidth={1.8} />
    </Scene>
  ),
  clock: () => (
    <Scene>
      <SceneGlyph name="clock" strokeWidth={1.8} />
    </Scene>
  ),
  spark: () => (
    <Scene>
      <SceneGlyph name="spark" strokeWidth={1.8} />
    </Scene>
  ),
}

/**
 * Does this build hold the named artwork? The one question the feed's `art`
 * field may ask, and the gate the no-artwork-no-card ruling is enforced with.
 */
export function hasCardArt(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(CARD_ART, name)
}

/**
 * The plate for a name, or null when this build does not hold it. Null rather
 * than a placeholder, on purpose: a caller that has not already dropped the
 * card through `renderableCards` must not be handed something to paint.
 *
 * The wrapper is not decoration. A plate is a picture of software and the words
 * inside it are fake window chrome — a URL, a file path, an app name — so a
 * screen reader working down the home grid would otherwise read four strings of
 * furniture interleaved with the real card titles. One element, hidden, and the
 * whole picture goes quiet; the plates carry `aria-hidden` at their own roots
 * too, because `CARD_ART` is exported and a plate reached directly must be just
 * as inert as one reached through here.
 */
export function CardArt({ name }: { name: string }): JSX.Element | null {
  if (!hasCardArt(name)) return null
  const Plate = CARD_ART[name as CardArtName]
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <Plate />
    </div>
  )
}
