# Kbd chord

The keyboard-shortcut hint: each key a real `<kbd>` capsule, joined by a
quiet separator. Extracted from the shipped `KbdChord` primitive
(`src/renderer/src/components/ui/KbdChord.tsx`).

It *describes* a shortcut, it never *invokes* one — the control the chord
labels owns the actual handler. Purely presentational, and the one place in
the product exempt from sentence case: keys render as keys ("⌘", "Shift",
"K").

## Anatomy

| Part | Class | Required |
|---|---|---|
| Chord | `.ds-kbd-chord` | yes — `role="img"` with an `aria-label` naming the chord |
| Key | `.ds-kbd-chord-key` | yes — a real `<kbd>`: mono `font.size.micro`, `bg.surface-raised`, `border.subtle` hairline, `radius.chip` |
| Separator | `.ds-kbd-chord-sep` | between keys — a `+` in `text.disabled`, `aria-hidden` |
| Sequence word | `.ds-kbd-chord-then` | between strokes of a multi-stroke chord — the word "then", `aria-hidden` |

The capsule is a 16px-tall micro-type chip — glyph scale, deliberately below
the 24px hit-target floor, because it is not a target. Anything this small
that could be clicked would be a defect; a label cannot be.

## Variants

None. One appearance, in every context — a settings row, a walkthrough
step, a composer's footer. A chord that changes style per surface stops
reading as the same vocabulary.

Not every shortcut hint is a chord. A [menu](../menu/component.md) row
annotates its shortcut as plain mono micro text: there the shortcut is a
footnote to an action, and capsules would out-weigh the label. The chord is
for surfaces where the shortcut itself is the subject.

## States

None. The chord is display-only: no hover, no focus, no pressed state. A
"pressed key" animation would be motion meaning nothing.

## Usage

**Keys are keys, not prose.** Platform-resolved symbols or names per key
("⌘" on macOS, "Ctrl" on Windows), resolved by the consumer before render.
Never a sentence ("press Command and K").

**One key per capsule.** "⌘K" in a single capsule is a string wearing a
costume; the chord's grammar is capsule + separator + capsule.

**Multi-stroke chords say "then".** "⌘K then P" renders as two capsule
groups joined by the sequence word — the `+` separator means "together",
"then" means "in order", and the two are never interchangeable.

**A hint, never the only path.** The chord annotates an action that is
already reachable by click or menu. It sits in the trailing slot at
`text.disabled`-adjacent quietness because it is an accelerator note, not a
call to action.

**Do not decorate identifiers with it.** A capsule around anything that is
not a key — a branch name, a flag — dilutes the vocabulary. Identifiers are
mono text, not keys.

## Accessibility

- The chord carries `role="img"` and an `aria-label` reading the chord in
  words ("Command K", "Command K then P"). Screen readers hear one coherent
  name instead of a stutter of single letters and plus signs.
- Separators and the sequence word are `aria-hidden` — they are spelled out
  by the label instead.
- Real `<kbd>` elements, so the semantics survive wherever the markup
  travels.
- The capsule's micro type is below the body floor, which is acceptable
  only because the chord is supplementary: the action's name — not the
  chord — carries the meaning, and `text.muted` on `bg.surface-raised`
  keeps the keys legible without promoting them.
