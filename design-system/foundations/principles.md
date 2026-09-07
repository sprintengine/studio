# Principles

The rules this system enforces that tokens alone cannot. Tokens decide what a
value is; these decide when you are allowed to reach for it.

This file is the authority on how Multicode looks. Where it and your instincts
disagree, it wins. Where it is silent, decide, and add the rule here.

## Restraint

Restraint is the whole craft. The default failure of a generated interface is
not ugliness — it is genericness: many accents, decorative chrome, a
happy-path-only screen. Density is bought by removing elements, words, and
chrome, never by shrinking type or crushing rhythm.

**The accent budget.** Solid, saturated color is the strongest signal the system
has, so it is spent on almost nothing:

- `accent.primary` as a **solid fill** appears on the **primary action** and
  nowhere else. One per view — an inspector aside counts as its own view.
- `accent.primary` as **ink or a hairline** may mark focus (`focus.ring`) and a
  genuinely live process.
- Everything else earns its weight from the neutral ink and surface ramps.

If a surface needs a second accent, it is missing hierarchy, not color. Status
hues (`status.*`) are not accents: never a button background, section border,
chrome tint, or category code. (Identity hues on vendor marks and file-type
glyphs are a different thing — see "Identity colour" below.)

**The storefront exception** (2026-09-06). A grid of offers — cards in a
catalogue, each with one identical action in the same place — takes the accent on
*every* card's action, not on one. The budget above is a rule about a **working**
surface, where a second accent means the hierarchy is missing; in a storefront
the picture and the title do the ranking and the button is furniture that has to
be findable. Spending the accent once there leaves every card but one with its
call to action as the quietest thing on it.

Two conditions, and both are load-bearing: the actions must be **the same action
repeated** (a row of unlike accented controls is a category code, which the rule
above forbids), and the surrounding chrome must stay neutral — the Extensions
home accents its cards' buttons and deliberately leaves its tile glyphs in
neutral ink for exactly this reason.

**Identity colour** (ruled 2026-09-06, revising the 2026-09-02 monochrome
ruling for two families). Two kinds of glyph carry a colour of their own, and
the accent budget does not count them, because the colour is not ours: it
names something.

- **A vendor's mark wears the vendor's colour.** The VS Code and IntelliJ marks
  on the open-in-editor control, the CLI badges, the product mark. A
  monochrome logo is a drawing of a logo; every other app on the machine shows
  the real one, and the neutral version read as a placeholder. These are brand
  assets with hex of their own, exempted by file from the token guard.
- **A file-type glyph may wear its language's hue** — the `color.mark.*`
  tokens (blue for TypeScript, yellow for JavaScript, orange for HTML …), so a tree of forty files scans by colour before it is read. This
  is opt-in per surface (`FileTypeGlyph tone="kind"`) and the condition is
  load-bearing: **only where nothing else in the row is coloured.** The File
  Explorer qualifies. The Git changes list does not — there the filename's
  status tint is the row's one colour, and the glyph stays in ink.

What does not change: the hue identifies, it never grades. `color.mark.*` is
not a status ramp, not an accent, and never a category code on a control, a
row, a section, or a background. A gear, a plain document, or a folder — glyphs
that name no language — stay in the row's ink; colour that says nothing is
still chrome.

**Selection is neutral.** A selected row uses `bg.selected` — a neutral fill —
and lifts its title to `text.primary`. It does not use the accent, and it does
not carry a left bar, a border box, or a glow. A row that is merely *chosen*
must never outrank the one action worth taking. The Backlog rows' epic-colour
left bar was retired on 2026-09-02 under this rule: the `EpicColorDot` carries
epic identity, and the skeleton no longer reserves the bar.

## Quantified restraint

Ceilings, not guidelines. Exceeding one signals missing hierarchy; when a view
exceeds one, model the domain again rather than adding chrome.

| Ceiling | Limit |
|---|---|
| Product accents visible per view | 1 |
| Status idioms | 1 — the 6px dot or a lifecycle glyph, never both |
| Font families | 2 — `font.family.ui`, `font.family.mono` |
| Font weights per view | 3 |
| Font sizes per view | 3, repeating title / body / meta |
| Border radii per view | 2 |
| Controls above the first content row of a panel | 5 |
| Visual elements per repeated row at rest | 4 |
| Trailing actions a row may reveal on hover | 2 |
| Motion treatments animating at any moment | 1 |

## Selection and focus

Selection answers "what did I pick?". Focus answers "where am I typing?". A
**cursor** answers a third question — "which row would Enter act on?" — in a
list that is one tab stop and walks with `aria-activedescendant` rather than
moving DOM focus. Three questions, three treatments, never shared.

- **Focused selection** — `bg.selected`, title at `text.primary`. The list the
  user is driving right now.
- **Resting selection** — `bg.selected-resting`, title at `text.default`. Every
  other pane's selection: it remembers the choice without competing.
- **A multi-pane surface has exactly one focused selection.** In a
  rail → list → detail layout, two of the three panes are always resting. Three
  panes rendering a full-strength selection at once is the defect this rule
  exists to prevent.
- **Focus** is `focus.ring` — a 2px `border.focus` **outline at
  `focus.ring-offset`** — on `:focus-visible`, and it is the product's only
  focus indicator. Never on `:focus`: a mouse click must not draw it. Never
  suppressed, and never at a zero offset. The offset exists because
  `border.focus` and `accent.primary` are the same value: drawn tight against
  an accent-filled control the indicator has nothing to contrast with, and
  focused renders identically to unfocused. An **outline**, not an offset ring —
  the gap is transparent and shows whatever surface is actually behind, where
  `ring-offset-color` has to be told that background and gets it wrong the
  moment the control changes surface. A control that clips its own overflow
  (the halves of a split button) uses a negative `focus.ring-offset` rather
  than a second treatment.
- **Hover** is a background change to `bg.hover`. No shadow, no scale, no glow,
  no border appearing on hover and shifting the layout.
- **The cursor** is a 2px mark in the row's leading gutter, `text.primary`,
  inset from the row's top and bottom edges. It is deliberately neither a fill
  nor an outline: it has to compose on top of a selected row, a hovered row and
  a plain one, and both of those channels are already spoken for. It is not the
  accent either — `border.focus` and `accent.primary` are the same value in all
  but one theme, so an accent bar in the gutter reads as focus.
  Added 2026-09-02, when a conformance sweep replaced two lists' cursors with
  `bg.hover` and made them invisible on the rows a person had already picked.
  A list that moves real DOM focus with its cursor does not need this: there
  the focus ring is the mark, and one idiom is better than two.

## Progressive disclosure

What you withhold is as deliberate as what you show. No screen confronts a
person with everything at once.

- Each screen gets one visual priority. High-signal status and the default
  reading path are visible; secondary detail and lower-frequency configuration
  are revealed as the user reaches for them, behind nearby disclosure.
- **Prefer per-row and per-cell actions revealed on hover or focus over
  always-on controls.** Delete, roll back, close, reveal-in-folder, and the rest
  belong to the row you are pointing at — not to every row simultaneously.
- Anything revealed on hover **must also appear on keyboard focus**, and must
  have a non-hover path (an overflow menu, a context menu, or the detail pane).
  Hover-only is a bug, not a style.
- Revealing an action must not resize or reflow the row. Reserve its space, or
  reveal it over the row's trailing padding.
- Disclosure is not concealment: destructive or state-changing actions stay
  discoverable, and a state a person must act on is never hidden behind hover.

## Hairlines carry the structure

- Borders do the structural work. Cards, fills, and shadows do not. Group with
  space and a heading before reaching for a container; a card inside a card
  needs a real containment reason.
- Hairlines are 1px at canonical zoom. No doubled borders where surfaces meet,
  no 2px divider as decoration.
- **Elevation is a three-step ramp, and every step is an overlay:**
  `shadow.popover` for trigger-anchored surfaces, `shadow.drawer` for drawers
  and side panels, `shadow.modal` for centred dialogs. Nothing in the document
  flow — no card, row, or hover state — takes a shadow.
- In light mode, `bg.surface-raised` is deliberately the same white as
  `bg.surface`: raised surfaces separate by shadow and `border.strong`, not by
  tone. In dark mode the tone step does the work.
- **Inside an overlay, space separates — rules do not.** A dialog's title, its
  content, and its buttons are divided by padding. A rule under the title and
  another above the buttons cuts a small surface into three boxed strips and
  buys nothing: the shell already draws its own edge, and a shell that scrolls
  as one piece never needed the rules as scroll affordances.
- **One chrome row per content region.** Everything that is chrome for the same
  content shares a band — status on the left, controls on the right. A tools bar
  stacked on a status bar spends a second band of vertical space to say what the
  first could hold. When you reach for a second row, the question is which row
  the new control belongs in, not where to put the new row.
- **A notice carries its tone with a glyph, not a coloured edge.** A 2px stripe
  down one side of an error or warning card is decoration wearing a hairline's
  clothes: it doubles the card's own border, breaks the 1px rule, and leaves the
  tone carried by colour alone. Use a 1px neutral hairline, the soft tone tint,
  and the tone glyph at the leading edge — which is what makes it survive
  greyscale.

## Space and size

- Every padding, gap, and margin comes from `sem.space.*` — a 2px grid at the
  dense end opening to 4px steps at panel scale. A raw pixel value in a
  component means the scale is missing a step; add it here rather than locally.
- Controls come from `sem.size.control.*`: `xs` (26px) for icon buttons and
  in-row triggers, `sm` (30px) as the default for anything with a label, `md`
  (34px) for overlay primary actions. An input and a select side by side must
  share a height.
- Nothing interactive is drawn below `sem.size.hit-target-min`. A small glyph
  pads out to it with a transparent hit area rather than shrinking its target.
- An indent that aligns text to a reserved glyph slot (the 28px a leading
  16px glyph plus its gap occupies) is structure, not rhythm: it keeps its
  computed value, off the space scale if need be, with a one-line comment
  saying what it lines up with. Moving it to the nearest step misaligns the
  column it exists to align.
- At most 2 radii per view. `radius.control` (5px) is the default; larger radii
  belong to overlay and modal shells. Marketing radii (`rounded-2xl` and up)
  never appear on operational chrome.
- A capped column is centred or it is a bug. When a `max-width` element IS the
  page's content — a wizard step, a settings body, a door canvas — it centres
  (`max-w-*` + `mx-auto`), and its footer actions cap to the same measure so
  they align with the content edges. A reading-measure cap *inside* a
  left-anchored composition (prose under an uncapped heading, beside a figure)
  stays anchored with its siblings; centring it alone would misalign the page.

## Type

**Two families, permanently.** `font.family.ui` (Inter) for everything a person
reads; `font.family.mono` (JetBrains Mono) for identifiers, paths, hashes,
code, and `kbd`. There is no third family, and no serif anywhere in the
product. Introducing one is a system change, not a styling choice.

- Sentence case everywhere except real keyboard shortcuts. No uppercase
  letter-spaced labels as hierarchy — not on section headers, metadata,
  breadcrumbs, or chips.
- The scale repeats title / body / meta. Primary content does not go below
  `font.size.body` (13px).
- Tracking is optical, not decorative: `tracking.tight` on titles at 14px and
  up, `tracking.wide` on mono identifiers and micro labels, `tracking.normal`
  everywhere else.
- Line height by context: `line.tight` for display, `line.default` for UI,
  `line.relaxed` for prose. Not a single default applied everywhere.

**The micro-typography pass** — run before any surface is called done:

- `tabular-nums` on every numeric column: counts, ids, timestamps, durations.
- Mono for identifiers only, never for prose.
- Numbers, ids, and percentages right-align in columns; titles left-align.
  Dense data is never centre-aligned.
- Curly quotes and em-dashes in copy, no double spaces. Code is exempt.

## Copy

Copy is the last resort, not the first. A sentence in the interface is an
admission that the interface did not carry the meaning on its own.

**The UI does not explain the UI.** If a control needs a sentence beside it to
say why it exists or what will happen, the control is wrong — redesign it. The
generated-interface tell is a screen where every element has a caption. Delete,
in this order:

- A subtitle that restates the title. "Add a skill source" / "A public GitHub
  repository. We walk it and find the skills" says the same thing twice.
- A field label that restates the dialog title. One field under "New horizon"
  does not need a "Horizon name" label above it — pass the name to the control
  as its accessible name and let the placeholder do the visible work.
- Helper text that restates the placeholder. A field showing `owner/repo` does
  not need "a github.com address, or owner/repo" beneath it.
- A closing paragraph reassuring the user about what just happened. "X is now
  one of your sources. Nothing is installed yet — take skills from it when you
  want them" is three sentences replacing a state the screen already shows.

A line of copy earns its place only by carrying something the screen cannot:
a consequence the user cannot see (where a file will be written), or a fact
they cannot infer (which project this adopted as its home).

**The product does not name itself.** UI copy never says the application's
name. "Multicode will run this command", "cannot be undone from Multicode",
"while Multicode is open" — every one of these is the app narrating itself in
the third person, and no serious product does it. Write the sentence without
the name: "Will run:", "cannot be undone from here", "while the app is open".
The name belongs in exactly four places: the window title, the About/version
line, the sign-in and account surfaces, and first-run onboarding.

The one carve-out is the brand **wordmark**, which may appear exactly once, as
window chrome at the top of the left column. A mark is not a sentence: it
identifies the window the way a title bar does, and it does not narrate. The
rule above is unchanged for copy — no label, message, tooltip, or empty state
gains the name because the wordmark exists — and "exactly once" is literal, so
a second placement retires the first rather than joining it.

**Report the result, not the inventory.** When an operation finishes, show the
one fact that answers "did it work?" — a count, a name, a state. Everything
else the operation happens to know (file counts, commit hashes, byte sizes,
which internal layout was chosen) is stored, not displayed. Metadata dumped
into a success message reads as a machine reporting to itself.

**Empty is not invalid.** A required field nobody has filled in yet is not an
error. Do not mark it with a red "Required" or an asterisk on open — the
disabled confirm button already says "not yet". Validation messages appear
after the first keystroke, never before.

## Composition

Tokens govern values and components govern parts. Neither one governs how parts
are assembled into a surface — and that is where generated interfaces actually
fail. A screen can use every correct token, every approved component, and still
be wrong because it has two toolbars, a search detached from the list it
filters, and a heading over a group of one.

So the system fixes canonical **anatomies**. An anatomy is not a suggestion:
where one exists, build to it, and if a surface cannot fit it, the surface is
the thing to reconsider.

**The list surface** — every rail, column, and panel whose job is "find a thing
in a list" is built from exactly these parts, in exactly this order:

1. **The create affordance.** "New …", full width, at the very top. Never below
   the scroll.
2. **The search field, with the filter glyph beside it.** One row. Search is the
   only at-rest narrowing control; every other axis — project, view, sort,
   group — is an option inside the glyph's menu. Because collapsing them hides
   that a filter is applied, the glyph marks itself active whenever any axis is
   off its default.
3. **One divider.** Directly under the search row, and nowhere else in the
   header. This is the line that means "the list starts here" — it is the only
   rule the surface gets.
4. **The rows.**

Two consequences follow, and both were real defects:

- **A second full-width control never stacks above the search.** A project
  Select sitting over the field it narrows is a control competing with the
  control beside it, and it puts the same choice in two different shapes on two
  different surfaces.
- **The search belongs to the column it narrows, not to the screen.** In a
  list-plus-detail layout, a search bar spanning the full width reads as "search
  this screen" while it only ever filters the left column. Constrain it — and
  its divider — to the column it acts on.

**One chrome band per region of content.** Everything that is chrome for the
same content shares a row: status on the left, controls on the right. Reaching
for a second band means asking which band the new control belongs in, not where
to put the new band.

**The door surface** — a full-page surface that takes over the content region
(Backlog, Sprints, Reviews, Horizon, Automations, Extensions) — has an anatomy
too, and it has exactly one band of chrome:

1. **The app's top strip is the door's title bar.** The door's name and its
   controls ride the strip that is already there. A door that draws its own
   title row puts two title bars on one screen, with the first one empty.
2. **The name sits on the content gutter (20px).** The title, the leading edge
   of the tab row under it, and the canvas body share one vertical line. A title
   inset to the window chrome's 6px hangs off the left edge of its own page.
3. **The bar is the name and the controls, nothing else.** No status chip, no
   counts line: the page under the bar already shows its own state, and the rail
   row that opened the door already carries its glyph.
4. **Nothing stacks between the bar and the content.** A status sentence or a
   tools row under the strip is the second band this anatomy exists to prevent —
   the controls belong in the strip, and a status belongs to the thing that has
   it. A notice about the content (a stale change, a failed run) is not chrome
   and keeps its own band.

**Surfaces, not modals** (ruled 2026-09-05, reversing the doors→modals ruling
of 2026-09-01). A destination the shell's own chrome offers — anything an app
rail square or a sidebar drawer row opens — is a DOOR: it takes the card region
and owns the top row above it. Automations, Design, Plugins, Skills, Agent CLIs
and the Extensions home are doors. They spent four days as modals, and the
modal was wrong for them twice over: a scrim put a dialog between the person
and the very column they had just navigated with, and a float over the card
region means back, forward and the window's history all step to a destination
that mounts invisibly behind it.

What stays a modal is the shape a modal is actually for — a **pick-and-close
task floated over work that stays put**, reached from inside that work rather
than from the chrome:

- **Settings.** Opened from the rail's foot, changed and dismissed; the
  workspace behind it is the thing being configured and must stay visible.
- **The Diff popout.** The pane's own Diff tab grown to workbench width, opened
  from the pane strip. Routing the region would hide the layout it is a bigger
  view OF.
- **Reviews.** A walkthrough is Monaco beside a transcript; the pane column is
  too narrow to read it in, so picking it there floats the surface instead of
  opening a pane tab.

Three tests, all of which a modal must pass. A destination that fails any of
them is a door.

1. **The thing underneath is still the subject.** The workspace being
   configured, the layout the diff is a bigger view of, the change being
   reviewed. If the surface replaces the subject rather than acting on it, it
   wants the region, not a scrim.
2. **Nothing that names a PLACE leads to it.** No section glyph, no drawer row,
   no history entry — a destination reached by navigation has to be somewhere
   the region can go, or back and forward step to a page that mounts invisibly
   behind the scrim. Note the test is about naming a place, not about being
   chrome: Settings is opened from the rail's FOOT, and the foot is deliberately
   not navigation — the account and the gear belong to the window rather than to
   any section of the product, so they route nothing and no history entry
   records them.
3. **It is a task with an end.** Opened, done, dismissed. A surface a person
   navigates around inside, or comes back to and expects to find as they left
   it, is a place, and places are doors.

**A heading must separate something from something else.** Do not label an
ungrouped list ("Rosters" over a field that already reads "Search rosters…"),
and do not render a group heading when there is only one group — "Recent"
spanning every row groups nothing. Headings appear when there are at least two
groups to tell apart; the list's accessible name carries the label otherwise.

**The app rail** (ruled 2026-09-05; glyphs-only and then three-glyph, same day)
— the window's far-left column of glyphs — is chrome, not a rail in the context-rail sense. It names AREAS of the
product (Home, Extensions) and holds its one standing tool (Automations), never
things inside an area; the sidebar column beside it lists the things, and a
drilled-in surface still replaces that column's content rather than standing
beside it. "One rail, ever" is unchanged: the app rail holds no list a person
walks. Its anatomy:

1. **A fixed set of glyphs on `size.control.md` squares, no captions.** A
   house and a tile grid do not need "Home" and "Extensions" written under
   them, and the caption is what made the first cut 76px wide. The name is the
   glyph's tooltip and accessible name — the idiom the sidebar's collapsed
   rows already use. The column is one square plus a `space.xs` gutter each
   side: 46px, and no wider.
2. **Selection is `bg.selected` on the square.** Never the accent, never a
   bar on the window's edge. A section glyph is current while its column
   shows; a tool glyph is pressed while its surface floats. The two can light
   together, and they say different things.
3. **Three glyphs: Home, Automations, Extensions.** Automations stands on the
   rail because it is what the product DOES, not something added to it; it is
   the module's own registered surface, gated on the module's enablement, so a
   turned-off module's glyph is simply absent. Plugins does not: it is one of
   the five things under Extensions, and a glyph of its own said it stood
   beside them.
4. **Extensions opens its home, and the sidebar becomes the drawer.** The
   drawer is five rows in a fixed order — Sprints, Design, Plugins, Skills,
   Agent CLIs — with the same `SidebarNavButton` chrome for all five. The order
   is the ruling's, not the registry's `order`; a module contributes a row's
   name, glyph and behaviour, never its place. The drawer STAYS PUT while the
   card region swaps, which is what makes it the navigation rather than a menu:
   a door that is one of its rows renders its own rail beside its canvas
   instead of taking the column. Only Sprints, which has its own list of runs,
   replaces it for the length of its visit — and Automations, which is not a
   drawer row at all, because the automations it lists ARE the navigation while
   it is open.
   A drawer row reads `aria-current` while its page is showing (it is
   navigation, exactly like a workspace row); the rail's square reads
   `aria-pressed`. Two honest readings of one state — what would be wrong is
   one row of the drawer disagreeing with the row above it.
   **The home is those same five rows, said again as tiles** — glyph, name, a
   one-line summary, a live count, a chevron — resolved from the one function
   the drawer's rows are resolved by, so a tile cannot open something its row
   does not, and a module that is off takes both away together. A count on a
   tile is LIVE or ABSENT: a number nobody has measured yet is no line at all,
   and a number that really is nothing is words ("No runs", "None installed"),
   because "0 running" reads as a counter that has not started rather than as
   an answer. No module list on the page: those switches live in Settings →
   Modules, and one choice in two shapes on two surfaces is two things to keep
   in agreement.
5. **The account and Settings cluster pins to its foot.** They belong to the
   window, not to whichever section the sidebar is showing.
6. **Its top reserves the title strip's height** on every platform, so its
   first glyph sits below the chrome row beside it. On macOS the native
   traffic lights start in that reserve and run past the rail's edge; the
   sidebar's chrome row insets for the remainder.
7. **The divider starts below that reserve, never at the top.** The rail's
   right-hand hairline is a positioned strip from the title row down, not a
   full-height `border-r`: the traffic lights are wider than the rail, so an
   edge that ran the whole height drew a line straight through the green light.
   Across the title row the rail and the chrome beside it are one unbroken
   band.

**A dialog is header, content, actions — separated by space.** No rule under the
title, none above the buttons. See *Hairlines carry the structure*.

## Status is earned

- Status reads by **shape first, color second** — every state survives
  grayscale. Healthy, done, and idle render no mark at all.
- One status idiom per surface. A 6px dot or a lifecycle glyph — never a dot
  and a tinted pill saying the same thing.
- A status is never text-only with no glyph, nor glyph-only with no accessible
  name.
- The accent green (forest) and the success green (bright emerald) are held
  apart by brightness and saturation. Never retune one toward the other.

## Motion

- One easing curve (`motion.ease.standard`) and three durations. Hover and
  focus at `fast`, popovers at `normal`, drawers at `deliberate`.
- **Three eased motions, and that is the whole set:** the switch thumb as it
  crosses its track, the hover/press response every interactive surface shares,
  and a popover's entrance. A surface picks one of the three; it does not
  declare its own transition. A fourth is a system change, argued here first —
  and a per-component `transition` restating a duration the tokens already name
  is the tell that one was added by accident. An entrance a *pattern* owns (a
  rail swapping its contents) is not a fourth motion: it composes the same
  duration and easing pair rather than introducing a curve of its own.
- At most one thing animates at a time, and it means one of exactly two things:
  *alive right now* (a streaming or running pulse) or *just changed* (a
  reorder, a just-moved flash). Ambient decoration is not motion, it is noise.
- Motion is never the sole signal of a state change — the accessible name and
  the visible label carry it too.
- Every animation honors `prefers-reduced-motion: reduce`, including the
  `:active` press scale.
- Never put `backdrop-filter` on a full-viewport scrim; separation comes from
  `overlay.scrim` plus the shell's shadow. The toast card is the one
  sanctioned glass surface (ruling 2026-09-04): a corner-sized blur, pinned
  to the toast by the conformance lint.

## Accessibility

A gate, not a preference. No design system supplies it for you.

- WCAG 2.1 AA, semantic HTML, and full keyboard operation on every surface.
- Body text clears AA on its own surface. `text.subtle` and `text.disabled`
  never carry actionable copy alone. The ink ramp orders identically in both
  modes — `default` darker than `muted` darker than `subtle` darker than
  `disabled` — so a token means the same thing in either theme.
- Visible focus on everything focusable, in a sensible order, never removed.
- Status conveyed by shape or label, never by color alone.
- Real labels on controls; `aria-label` on every icon-only button. Icons that
  duplicate adjacent text are `aria-hidden`.
- Overlays: Escape closes the topmost surface only, focus is restored to the
  trigger, and a modal traps focus while open.
- Design the states, not the happy path. Every data surface distinguishes
  populated, empty, loading, error, unavailable, and permission-denied. A
  failed dependency must never render identically to an empty list.

## Modes

- Light and dark ship from the same semantic tokens. Consumers style with
  `--sem-*` only and never write a per-mode override.
- Dark surfaces are neutral to slightly warm. Blue-shifted darks (`#0a0d18`,
  `#0c1020`) read as generated-dashboard defaults and are out.
- Dark values keep the anti-dither discipline: solid channel values, no pure
  black surfaces.

## Tokens or nothing

- Never hard-code a color, space, size, radius, duration, or z-index the system
  defines. Pick by the token's documented `role` and `use`, not by its looks.
- The `--ref-*` tier is internal plumbing for the token file. Components and
  patterns consume `--sem-*` only.
- Layering comes from `sem.z.*`. A surface that needs to sit between two
  defined layers is the wrong kind of surface. In-flow depth has its own three
  steps below `drawer` — `sticky` (10), `pane` (20, docked panes and in-canvas
  floating chrome) and `float` (30, panel-internal popovers and HUDs) — so a
  bare `z-20` / `z-30` is a hard-coded z-index like any other.

## Reject on sight

Each of these is a restart signal, not a fix-it-later note. Rebuild the
surface rather than patching it.

- Two or more accent hues competing for primary, or an accent used as a
  selection fill.
- More than two radii or more than three font weights in one view.
- A third font family, or a serif anywhere in the product.
- A badge or tinted pill where a status dot carries the same meaning.
- A card inside a card with no containment reason.
- A hero composition — oversized headline, decorative blob, three-up stat
  row — inside an operational panel.
- A primary button with a gradient fill, inset highlight, or blurred shadow.
- Decorative emoji as iconography, or celebration copy ("✅", "🎉", "Awesome!").
- Placeholder content: "Lorem ipsum", "Card title", "Item 1 / 2 / 3".
- Empty-state copy that explains an obvious interaction ("Click here to
  start"), or marketing copy in operational chrome.
- A subtitle restating the title, a field label restating the dialog title, or
  helper text restating the placeholder.
- The application naming itself in ordinary UI copy.
- A success message that dumps the operation's metadata instead of its result.
- A red "Required" or an asterisk on a field nobody has filled in yet.
- A tone-coloured bar down the left edge of a notice, card, or callout.
- Two stacked bands of chrome above one region of content.
- Dividers separating the sections of a dialog.
- The same count shown in two places where the values could appear to disagree.
- Always-on row actions that should have been revealed on hover — or
  hover-revealed actions with no keyboard path.
