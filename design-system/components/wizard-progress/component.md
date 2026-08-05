# Wizard progress

Where you are in a flow that has a known number of steps, and — once a step is
behind you — a way back to it.

Use it only when the total is known and fixed. A flow whose length depends on
what the person picks needs a different affordance: a count that changes as you
go is worse than no count, because it removes the one thing this component is
for. For an indeterminate wait use [liveness](../liveness/component.md); for
navigation between peers use [tabs](../tabs/component.md).

## Anatomy

| Part | Class | Required |
|---|---|---|
| Strip | `.ds-wizard` | yes — `role="progressbar"` with `aria-valuenow/min/max` |
| Step | `.ds-wizard-step` | yes — one per step, in order |
| Jump control | `.ds-wizard-jump` | no — only over already-completed steps |
| Step label | `.ds-wizard-label` | labeled variant only |

**The progressbar itself is never interactive.** Where back-jumping is offered,
the controls are a sibling group layered over the strip — a `role="progressbar"`
that is also a button is two contracts on one element, and screen readers
announce the wrong one.

## Variants

- **Dashes** (default) — anonymous hairline segments. Right when the steps have
  no names worth reading, or the flow is short enough that position is the whole
  message.
- **Labeled** — each step's name inline, done steps ticked, the current one
  marked. Right past about four steps, where a count stops being orientation and
  people need to know *which* stations they have passed. Requires step names;
  without them it is dashes.

## States

| State | Treatment |
|---|---|
| Done | filled in `accent.primary`; ticked in the labeled variant |
| Current | filled, and the only step carrying `aria-current="step"` |
| Upcoming | `border.default` hairline, unfilled, inert |
| Jumpable | a done step that is also focusable and activates the back-jump |

**Done and current are separable.** By default every step before the active one
counts as done, which is what a simple wizard wants. A flow whose active step
can itself still be working passes the completed count explicitly, so the
current step reads as "in progress" rather than "finished" — the difference
between "you are on step 3" and "you have finished 3".

## Usage

- **Back, never forward.** Completed steps are reachable; upcoming ones are not.
  A wizard exists because the order matters, and a jump-ahead control quietly
  says it does not.
- One strip per flow, at the top of the surface it describes.
- Do not animate the fill between steps. Movement here would mean "alive right
  now", which is not what a step change is.
- Never the only statement of where you are. The surface should also say it in
  words — a heading naming the current step — because a person returning to a
  half-finished flow reads the heading, not the dashes.

## Accessibility

- The strip is `role="progressbar"` with `aria-valuemin`, `aria-valuemax` and
  `aria-valuenow`, and an accessible name that reads "Step 3 of 6" — with the
  current step's own name appended when there is one.
- The current step carries `aria-current="step"`.
- Jump controls are real buttons with their own names ("Back to Project"), not
  bare dashes: "button" repeated six times orients nobody.
- Upcoming steps are not focusable and are not announced as available.
- State is never carried by fill colour alone — done steps tick in the labeled
  variant, and the accessible name always carries the position.

## Shipped implementation

`src/renderer/src/components/ui/WizardProgress.tsx`.
