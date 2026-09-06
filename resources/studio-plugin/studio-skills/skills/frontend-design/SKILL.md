---
name: frontend-design
description: Craft guidance for authoring HTML mockups and design-system bundles that read as one calm, deliberate system instead of AI-generated filler. Use when designing a reviewable mockup, an app screen, or a portable design-system bundle.
---

# Frontend Design

You are turning a brief into a rendered surface a person will judge on sight. The
default failure is not "ugly" — it is generic: many accents, decorative chrome,
placeholder text, a happy-path-only screen. Restraint is the craft.

## Restraint first

- One accent color for selection and the primary action. Everything else earns
  its weight from a warm-neutral ink scale, not from a second hue. Per-section
  tinting and ad-hoc component colors are the top tell of generated UI.
- Hairline borders do structure. Group with space and a heading, not a card
  around a card. No shadow/glow used as structure, no `rounded-2xl/3xl` slabs,
  no gradient or glowing CTAs, no radial-blob atmosphere.
- Warm-neutral surfaces. Cold blue-shifted darks (`#0a0d18`-style) and cool
  "battleship" light greys read as AI-dashboard defaults — avoid them.
- Dense ≠ cramped. Buy density by removing elements, words, and chrome — never
  by shrinking type below ~12px for primary content or crushing rhythm. One
  reading column: lead with a title line, demote the rest to a muted line.
- Sentence case everywhere except keyboard shortcuts. No ALL-CAPS letter-spaced
  labels as hierarchy, no emoji as iconography.

## Hierarchy and real content

- Establish one clear visual hierarchy per screen: a primary action, a primary
  reading path, and quiet supporting meta. If everything is emphasized, nothing
  is.
- Populate with realistic content from the brief — real labels, plausible names,
  concrete numbers and timestamps ("2 min ago", "2026-05-13"). Never ship
  "Lorem ipsum", "Card title", or "Item 1/2/3". Fake content hides real layout
  and spacing problems.
- Copy carries state, so write it like product copy: state first then action
  ("GitHub unavailable. Reconnect to import."), name the source of a failure,
  verb-first action labels. No marketing claims, no exclamation points.

## Token discipline

- When a design-system bundle is attached (`design-system/`), consume its
  semantic tokens and components. Read its `USAGE.md` and use the named
  `sem.*` roles; do not invent a parallel palette, spacing scale, or component
  that duplicates one the bundle already defines.
- When authoring a bundle, keep two tiers: reference values (`ref.*`) and
  semantic roles (`sem.*`) that carry role/use metadata and both light and dark
  values. UI consumes semantics, never raw reference values.
- Absent a bundle, still commit to a small explicit token set (surfaces, ink
  scale, one accent, a spacing step, one radius) and reuse it — not one-off hex
  values sprinkled per element.

## Floors, not extras

- Responsive: the layout must survive a narrow viewport without horizontal
  scroll on the page body. Wide content (tables, code, diagrams) scrolls inside
  its own container. Use relative units and `max-width: 100%` on media.
- Accessibility floor: visible focus states (never hidden), text contrast that
  holds in both themes, status conveyed by shape or label and not color alone,
  real labels on controls, and a sensible heading order.
- Design the states, not just the happy path. Every data surface needs distinct
  loading, empty, and error/unavailable treatments — an empty list and a failed
  fetch must never render identically.

## Before you call it ready

Re-read the surface as the reviewer will: is there exactly one accent, is the
content real, does the hierarchy hold, does it degrade at a narrow width, and do
the non-happy states exist? Fix on sight rather than patching around a generic
result.
