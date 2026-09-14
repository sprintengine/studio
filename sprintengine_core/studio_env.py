"""The app's own environment variables, under both of their names.

Every one of them was spelled ``MULTICODE_*`` before the app was renamed to
SprintEngine Studio (2026-09-08) and is spelled ``SPRINTENGINE_*`` now. The
Python side is read by processes the desktop app launches, and those two halves
are not always the same version: a workspace can run the tool out of its own
checkout (``SPRINTENGINE_REPO_TOOL_PATH``) while the app injecting the
environment is a release build, or the other way round. So the new name is read
first and the old one second, and nothing here writes either.

Mirrors src/shared/studio-env.ts, including the eight variables whose suffix
already said SPRINTENGINE and therefore drop the repeat rather than stutter.
"""

from __future__ import annotations

import os
from typing import Mapping, Optional

ENV_PREFIX = "SPRINTENGINE_"
LEGACY_ENV_PREFIX = "MULTICODE_"

_LEGACY_ENV_NAME_OVERRIDES = {
    "SPRINTENGINE_TOOL_PATH": "MULTICODE_SPRINTENGINE_TOOL_PATH",
    "SPRINTENGINE_REGISTRY_ROOTS": "MULTICODE_SPRINTENGINE_REGISTRY_ROOTS",
    "SPRINTENGINE_USER_REGISTRY_ROOT": "MULTICODE_SPRINTENGINE_USER_REGISTRY_ROOT",
    "SPRINTENGINE_MCP_RUN_ID": "MULTICODE_SPRINTENGINE_MCP_RUN_ID",
    "SPRINTENGINE_MCP_RUN_TOKEN": "MULTICODE_SPRINTENGINE_MCP_RUN_TOKEN",
    "SPRINTENGINE_DISABLE_SYNC": "MULTICODE_DISABLE_SPRINTENGINE_SYNC",
    "SPRINTENGINE_DISABLE_AUTORUN": "MULTICODE_DISABLE_SPRINTENGINE_AUTORUN",
    "SPRINTENGINE_DISABLE_TERMINALS": "MULTICODE_DISABLE_SPRINTENGINE_TERMINALS",
}


def legacy_env_name(name: str) -> Optional[str]:
    """What ``name`` used to be called, or None if it is not one of ours."""
    override = _LEGACY_ENV_NAME_OVERRIDES.get(name)
    if override:
        return override
    if not name.startswith(ENV_PREFIX):
        return None
    return LEGACY_ENV_PREFIX + name[len(ENV_PREFIX):]


def studio_env_names(name: str) -> tuple[str, ...]:
    """Both spellings, new first — the order every reader uses."""
    legacy = legacy_env_name(name)
    return (name, legacy) if legacy and legacy != name else (name,)


def read_studio_env(name: str, env: Optional[Mapping[str, str]] = None) -> Optional[str]:
    """Read one of the app's variables, preferring the new name.

    Presence decides, not truthiness: a new name set to the empty string masks a
    legacy value rather than falling through to it.
    """
    source = os.environ if env is None else env
    for candidate in studio_env_names(name):
        if candidate in source:
            return source[candidate]
    return None
