"""Sprint Engine compatibility facade for existing Swarm execution commands.

Milestone 01 keeps the Swarm CLI surface intact while Sprint Engine becomes the
canonical execution core. The current command implementation still lives in
``swarm_core.tool``; this module is the handoff point for migrating behavior
without changing public command names or output shape.
"""

from __future__ import annotations

from swarm_core.tool import *  # noqa: F401,F403

