# Modal

The one surface allowed to stop the page. A modal takes the keyboard, dims
everything behind a scrim, and holds the floor until the person answers — so
it is spent only on decisions that cannot be deferred and cannot be made in
place: confirming a destruction, naming a thing before it can exist, a task
that must complete or be abandoned. Extracted from the source product's
`Modal` and `ConfirmDialog` primitives (`src/renderer/src/components/ui/`).

Use a popover when the task is anchored to a control and light-dismiss is
acceptable. Use a drawer when the person needs the page visible while they
work. A modal that merely *shows* something — a preview, a detail — is a
drawer wearing a scrim.

## Anatomy

| Part | Class | Required |
|---|---|---|
| Scrim | `.ds-modal-scrim` | yes — `overlay.scrim` at `z.modal`, centring the shell; a pointer-down on it closes |
| Shell | `.ds-modal` | yes — `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the title, `tabindex="-1"` |
| Header | `.ds-modal-header` | yes — title `.ds-modal-title`, optional subtitle `.ds-modal-subtitle`, optional close button |
| Body | `.ds-modal-body` | no — a confirm with a self-explaining title needs none |
| Footer | `.ds-modal-footer` | yes — the actions, right-aligned, built from `ds-button` |

**Header, content, actions — separated by space.** No rule under the title and
none above the buttons: the shell already draws its own edge, and it scrolls as
one piece (`max-height` on the shell, not on the body), so neither rule would
even be a scroll affordance. A divided dialog is on the reject-on-sight list.

The shell sits on `bg.surface` — not `bg.surface-raised` — because the scrim
and `shadow.modal` already do the separating; a tone step on top would be a
third signal for the same fact. Width is a content measure, not a token:
`560px` default, `460px` for the confirm variant, both capped at `95vw`.

## Variants

- `.ds-modal--confirm` — the two-button question, `460px`. Title, optional one
  or two sentences of body, then exactly **cancel** (`ds-button--ghost`) and
  **confirm** (`ds-button--primary`). The confirm button takes initial focus:
  Enter answers the question the dialog asked.
- **Danger tone** — a destructive confirm swaps the confirm fill to
  `status.danger` with `text.on-accent` ink (the swap `button/component.md`
  already prescribes). The scrim, shell, and title do not turn red: the tone
  lives on the one control that does the damage.
- **Pending** — while the confirmed action runs: both buttons disabled, the
  confirm label swapped for its pending form ("Deleting…"), and every close
  path (Escape, scrim, close button) suppressed, because half-done destruction
  is worse than a short wait.

A prompt (one text field under the title) is a confirm with an input: the
dialog title names what is being asked for, so the field carries **no visible
label** — its accessible name repeats the ask for screen readers — and an
empty required field shows no error; the disabled confirm button already says
"not yet". Validation appears after the first keystroke, never before.

## States

| State | Treatment |
|---|---|
| Closed | Not in the document |
| Open | Scrim plus shell, immediately — a modal has **no entrance animation**: the three sanctioned motions are the switch thumb, hover/press, and a popover's entrance, and an interruption should not also perform one |
| Scrolled | The shell scrolls as one piece at `max-height: 92vh`; header and footer scroll with it |
| Pending (confirm) | Actions disabled, close paths suppressed |

## Usage

**One modal at a time.** A dialog opening a dialog means the first one asked
its question too early. The shipped confirm provider enforces this by
resolving (as cancelled) any confirm still open when the next one is requested.

**Three ways out, all equivalent to cancel.** Escape, a pointer-down on the
scrim, and the header close button all mean "no". The footer's cancel button
is the same answer with a label. Anything destructive therefore only ever
happens through the one explicitly labelled confirm.

**The footer holds two buttons, rarely three.** Cancel then confirm, in that
order, right-aligned. A third action ("Don't save") is the ceiling; a fourth
means the dialog is a form pretending to be a question.

**Copy rules apply with less room to hide.** The title is the question
("Delete workspace?"), sentence case, no terminal narration. The body earns
its place only by carrying a consequence the person cannot see — what will be
lost, what cannot be undone from here. A body restating the title is deleted.

**Rebuilding it in a framework:** what must survive is the focus contract
below, the scrim-press-not-scrim-click distinction (`pointerdown` on the scrim
itself, so a drag that ends outside the shell does not dismiss), and the
pending-state lockout.

## Accessibility

- `role="dialog"` with `aria-modal="true"` and `aria-labelledby` pointing at
  the title. The shell takes `tabindex="-1"` so focus can land on it when the
  content has no obvious first control.
- **Focus is trapped while open.** Tab from the last focusable element wraps
  to the first; Shift+Tab from the first wraps to the last (sentinel elements
  before and after the shell, as the shipped Drawer does). The page behind the
  scrim is never reachable by keyboard while the modal holds the floor.
- Initial focus: the confirm button in a confirm, the input in a prompt, the
  shell itself otherwise. On close, focus returns to the element that opened
  the modal.
- Escape closes — unless a popover is open inside the modal, in which case the
  popover consumes it first: Escape closes the topmost surface only.
- The scrim is `aria-hidden` plumbing, never `backdrop-filter` — separation
  comes from `overlay.scrim` plus `shadow.modal`.

## Shipped implementation

`src/renderer/src/components/ui/Modal.tsx`, with `ConfirmDialog.tsx` as the
`--confirm` variant above: its `title` / `body` / `confirmLabel` /
`cancelLabel` / `pendingLabel` / `tone` / `pending` options are this entry's
confirm and prompt specs, and `ConfirmDialogProvider` + `useConfirmDialog()` are how a caller asks the
question without mounting a dialog of its own.

## Known drift

- ~~`Modal.tsx` ships `z-50` against the token ladder's 70.~~ **Resolved
  2026-08-05 (MC-2119):** the token ladder is canonical and `Modal` consumes
  `--z-modal`. It mattered more than it looked — at 50 the modal sat a tier
  *below* the menu layer at 60, so a context menu opened over a dialog painted
  on top of it.
- `Modal.tsx` ships **no focus trap**: focus moves into the shell but Tab
  walks out into the scrimmed page behind it. The trap specified above is the
  contract; the gap is **MC-2109**.
- `Modal.tsx` ships shadowless (vs `--sem-shadow-modal`), `rounded-[8px]` (a
  radius on no ramp step, vs `radius.shell` 9px), and a 20px inset (vs
  `space.3xl` 24px, which the token's own metadata names as the modal inset).
  All **MC-2110**.
