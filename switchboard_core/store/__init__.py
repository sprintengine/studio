"""Compatibility surface for Switchboard store helpers.

The implementation is split by responsibility across sibling modules. This
module preserves the historical `switchboard_core.store` import path.
"""

from __future__ import annotations

from importlib import import_module

_MODULE_NAMES = (
    "constants",
    "errors",
    "models",
    "paths",
    "runner_locks",
    "runner_state",
    "metrics",
    "runner_commands",
    "worktrees",
    "runner_reconcile",
    "electron_execution",
    "executions",
    "task_store",
    "git_ops",
    "github_sync",
    "task_lifecycle",
    "assessments",
)

_modules = [import_module(f"{__name__}.{module_name}") for module_name in _MODULE_NAMES]
_public_symbols: dict[str, object] = {}

for _module in _modules:
    for _name, _value in vars(_module).items():
        if _name.startswith("_"):
            continue
        _public_symbols[_name] = _value

globals().update(_public_symbols)

for _module in _modules:
    _module.__dict__.update(_public_symbols)

__all__ = sorted(_public_symbols)

del import_module, _MODULE_NAMES, _modules, _module, _name, _value, _public_symbols
