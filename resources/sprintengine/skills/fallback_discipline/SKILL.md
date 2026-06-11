<what-to-do>

# Fallback Discipline

Prefer explicit failure over surprising fallback. Do not guess missing inputs, permissions, configuration, state, external data, user intent, or unavailable dependencies.

When fallback behavior is part of the contract, make it observable and verify that it preserves user intent. Broad catch-all handlers, silent defaults, swallowed errors, fake success paths, and alternate flows that make failures look successful are quality defects.

If invalid input, missing configuration, permission denial, unavailable data, or broken dependencies should stop a workflow, surface a clear error or disabled state instead of proceeding with invented data.

</what-to-do>
