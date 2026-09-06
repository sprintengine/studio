---
name: prototype
description: Build a clearly throwaway prototype to answer a design, state-model, workflow, or UI question before production implementation. Use when the user asks to prototype, mock up, sanity-check, try variants, explore an interaction, or "let me play with it".
---

# Prototype

A prototype answers a question. It is not production completion.

## Choose The Question

Before building, state the question the prototype answers:

- Logic/state question: build a small interactive harness or temporary route that exposes state transitions.
- UI question: build structurally different variants in the nearest real app context when possible.
- Workflow question: build the thinnest runnable path that lets the user exercise the decision.

If the request is ambiguous and the user is not available, choose the smallest prototype that best matches the surrounding code and state the assumption.

## Rules

- Mark the prototype clearly in filenames, comments, or route names.
- Keep it close to the real surface it informs.
- Provide one command or URL to run it.
- Avoid persistence by default. Use in-memory state unless persistence is the actual question.
- Do not wire destructive real mutations unless the user explicitly asks and the environment is safe.
- Skip production polish, but keep it runnable.
- Surface the relevant state after each action or variant switch.
- Delete or absorb the prototype when the decision is made.

## UI Variants

For UI prototypes:

- Prefer mounting variants inside an existing page or panel so real density, navigation, and data constraints are visible.
- Use a route/query switch such as `?variant=a` only when it fits the local router.
- Make variants structurally different: layout, hierarchy, primary action, or workflow shape. Color-only variants do not count.
- Keep the switcher out of production builds or clearly marked as prototype-only.
- Do not let prototype-only sample data satisfy production acceptance.

## Completion

Capture:

- The prototype question.
- How to run it.
- What was learned.
- Which code is throwaway.
- What must be rebuilt, deleted, or folded into production.

Acceptance for the real feature must fail if only the prototype works.
