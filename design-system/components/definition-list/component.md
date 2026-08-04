# Definition list

Label/value pairs: the facts a detail pane, a dialog, or an inspector states
about one thing. Extracted from the shipped `DefinitionList` primitive
(`src/renderer/src/components/ui/DefinitionList.tsx`).

Use it when each label appears once, describing one subject. Rows of many
subjects sharing the same columns are a table; a user-editable pair is a
form field. And a definition list is the *replacement* for the caption
disease the copy principles reject — a screen where every element gets a
sentence. State the fact, not a paragraph about it.

## Anatomy

| Part | Class | Required |
|---|---|---|
| List | `.ds-definition-list` | yes — a real `<dl>` |
| Pair | `.ds-definition-pair` | yes — groups each `<dt>`/`<dd>` (and is the grid's cell unit in the compact layout) |
| Term | `.ds-definition-term` | yes — a `<dt>`, `font.size.micro`, `text.muted`, sentence case |
| Definition | `.ds-definition-detail` | yes — a `<dd>`, `font.size.meta`, `text.primary` |

The hierarchy is inverted from prose: the *value* is the content and takes
the stronger ink; the label is scaffolding and steps down to `text.muted`
micro type. A layout where the labels shout and the values whisper has it
backwards.

## Variants

Three layouts — same parts, same tokens, different geometry:

- **`--columns`** (default) — terms in a `max-content` column, definitions
  beside them. The reading layout for a detail pane: scan the label column,
  land on the value.
- **`--stack`** — label above value, one column. For narrow rails where the
  columns layout would starve the values.
- **`--compact`** — a two-column grid of stacked pairs, values at
  `font.weight.medium`. For short stat groups in a dialog or detail header
  — four to six facts, glanceable. Values wrap anywhere
  (`overflow-wrap: anywhere`) because these cells hold hashes and paths that
  have no spaces to break at.

## States

None. A definition list is display-only: no hover, no selection, no
disabled. If a value needs to be actionable, the action is a control placed
in the `<dd>` — the list itself never becomes interactive chrome.

## Usage

**Sentence-case terms, no trailing colon.** The layout already says "label:
value"; punctuation restating it is noise. No uppercase letter-spaced labels
— that hierarchy idiom is banned everywhere, including here.

**Identifiers are mono inside the definition.** A hash, path, or id in a
`<dd>` keeps the micro-typography rules: mono family, `tabular-nums`,
`tracking.wide` — the same treatment as `list-row`'s identifier. Prose
values stay in the UI family.

**Empty is a stated fact.** A pair whose value is unknown says so ("Not
set", "—") in `text.subtle`; omitting the row makes absence indistinguishable
from oversight. But omit rows whose fact is genuinely inapplicable — a `—`
column of inapplicables is inventory, not information.

**Do not header a single group.** A heading over one definition list groups
nothing; the pane's own title carries the label. Headings appear when two or
more lists must be told apart.

## Accessibility

- Real `<dl>`/`<dt>`/`<dd>` semantics — screen readers announce term and
  definition as a pair, which is the entire point of not using divs. The
  pair wrapper `<div>` inside `<dl>` is valid HTML and preserves the
  association.
- Terms are unique within one list. The same term twice reads as an error
  because it is one.
- Give a `<dd>` an `id` when something references the value
  (`aria-describedby` from a control the fact explains).
- Color never carries a value's meaning alone: a status value pairs its
  status ink with the word ("Failing"), per the status principles.

## Known drift

- `DefinitionList.tsx`'s compact-grid layout renders terms in
  `text-disabled` while the other two layouts use `text-muted`. One label
  ink per component: canon is `text.muted` everywhere. Unfiled.
