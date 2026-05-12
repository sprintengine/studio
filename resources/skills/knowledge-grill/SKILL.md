---
name: knowledge-grill
description: Stress-test a plan, product idea, architecture direction, or implementation approach against the workspace Knowledge Graph and current code. Use when the user asks to grill, challenge, validate, sharpen, or de-risk a plan; when terminology is fuzzy; or when durable product, architecture, brand, or decision context may affect the answer.
---

# Knowledge Grill

Use the configured Knowledge Graph as the durable context source for a focused grilling session. The goal is shared understanding, not a long generic questionnaire.

## Workflow

1. Identify the configured Knowledge Graph root from runtime context or workspace settings. Do not assume it is named `knowledge` unless the current workspace says so.
2. Read the smallest relevant set of notes. Start with `<knowledge-root>/README.md` when present and follow relevant `[[wikilinks]]`.
3. Check current source, tests, commands, plans, or UI before treating Knowledge Graph claims as implementation truth.
4. Ask one decision-shaping question at a time. For each question, include your recommended answer and why it matters.
5. If the answer can be found in the repo, inspect the repo instead of asking.
6. Separate confirmed facts, assumptions, open questions, and out-of-scope items.

## Language Discipline

- Call out terminology conflicts immediately.
- Prefer the canonical product/domain terms already present in the Knowledge Graph.
- When a user uses a vague or overloaded term, propose a precise term and ask for confirmation.
- Do not add general programming concepts to the Knowledge Graph. Add only durable project, product, architecture, brand, ecosystem, or decision context.

## Durable Updates

Update Knowledge Graph notes during the session only when a durable fact or decision is confirmed.

- Prefer editing an existing note over creating a duplicate.
- Use Obsidian-style `[[wikilinks]]` when linking related notes.
- Use project-root-relative paths such as `src/main/index.ts`.
- Label assumptions clearly.
- Do not store secrets, private customer data, transient debugging notes, or unverified claims.

Offer a new decision note only when all are true:

- The decision is hard or costly to reverse.
- A future maintainer would not understand it from code alone.
- There was a real trade-off or rejected alternative worth remembering.

## Output

When the grill is complete, provide:

- Decision or recommendation.
- Confirmed facts.
- Remaining assumptions or open questions.
- Knowledge Graph notes changed, if any.
- Verification or follow-up needed before implementation.
