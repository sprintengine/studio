---
name: behavior-first-testing
description: Design and implement tests around observable behavior through public interfaces. Use when adding or improving tests, practicing TDD, writing regression coverage, reviewing brittle tests, or avoiding implementation-detail mocks and horizontal test batches.
---

# Behavior First Testing

Write tests that describe what the system does through public interfaces. Avoid tests that only mirror implementation structure.

## Test Selection

Start with the behavior that most reduces risk:

- A user-visible workflow.
- A public API, IPC route, command, or module interface.
- A regression that previously failed.
- A cross-module contract that could silently break.

Do not try to cover every edge case up front. Pick the next most valuable behavior, prove it, then continue.

## Red-Green-Refactor Loop

For TDD or new regression coverage:

1. Write one failing test for one behavior.
2. Run it and confirm it fails for the expected reason.
3. Write the minimal implementation or fix.
4. Run the test and relevant surrounding checks.
5. Refactor only while tests are green.
6. Repeat for the next behavior.

Avoid horizontal slicing:

- Do not write a large batch of imagined tests before touching implementation.
- Do not test private methods, call order, or internal helpers unless they are the actual public interface.
- Do not mock owned internal collaborators just to make a test easy.

## Good Test Properties

- The test name describes behavior, not implementation.
- The test exercises real code through a stable interface.
- The assertion would fail if user-observable behavior broke.
- The test would survive an internal refactor.
- Fixtures are small and meaningful.

Mocks and fakes are acceptable when they isolate external systems, time, network, filesystem, or expensive dependencies. They are not release evidence for integration behavior unless at least one check exercises the real owned contract.

## Output

Report:

- Behavior covered.
- Public interface exercised.
- Commands run and results.
- Remaining test gaps or integration risks.
