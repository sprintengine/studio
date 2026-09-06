---
name: architecture-deepening
description: Find focused architecture improvement opportunities that make modules more useful, local, testable, and easier for agents to navigate. Use when reviewing architecture, reducing coupling, improving testability, consolidating shallow modules, or planning refactors.
---

# Architecture Deepening

Use this skill to find practical refactors that improve locality and leverage. Do not propose broad rewrites or generic abstractions.

## Explore

Read relevant Knowledge Graph notes and current source before proposing changes.

Look for:

- Concepts that require bouncing across many files to understand.
- Pass-through modules whose interface is nearly as complex as the implementation.
- Test-only extraction where real bugs still live in orchestration.
- Coupling that leaks across module boundaries.
- Public interfaces that make correct testing awkward or impossible.
- Repeated caller logic that should live behind one owned interface.

Use the deletion test: if deleting a module would make complexity disappear, it may be shallow; if deleting it would force the same complexity into many callers, it is earning its keep.

## Candidate Format

Present a short ranked list. For each candidate include:

- Files or modules involved.
- Friction observed.
- Proposed shape in plain English.
- Why it improves locality, leverage, or testability.
- Risks, migration concerns, and verification path.

Do not design full interfaces until the user chooses a candidate.

## Design A Chosen Candidate

When a candidate is selected:

1. State constraints and real dependencies.
2. Identify the public interface or command/API/UI contract that should remain stable.
3. Compare at least two practical designs when the choice is consequential.
4. Prefer existing project patterns over new frameworks or speculative layers.
5. Add tests around the public interface, not internal helper structure.

Only introduce an interface or adapter when it removes real complexity, supports multiple concrete implementations, or clarifies an existing boundary. One hypothetical future implementation is not enough.

## Knowledge Updates

If the refactor creates durable architecture language or a decision future agents need, update the Knowledge Graph or recommend an architecture note. Use project-root-relative paths and distinguish confirmed decisions from ideas.
