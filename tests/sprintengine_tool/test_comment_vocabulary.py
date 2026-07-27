"""Task comment vocabulary (MC-1829).

The set used to be spelled out in three Python modules and again in the renderer.
It is now defined once in `sprintengine_core.store` and imported; these tests pin
that single definition, the retirement of the tester/product feedback types, and
the renderer badge table that has to resolve every surviving type.
"""

from __future__ import annotations

import re

from helpers import REPO_ROOT
from sprintengine_core import store as folder_store
from sprintengine_core.tool import comments as tool_comments
from sprintengine_core.tool import constants

RETIRED_COMMENT_TYPES = ("test_feedback", "product_feedback")


def test_comment_vocabulary_has_exactly_one_definition() -> None:
    """The CLI constants and the comment queues read the store's set, not a copy."""
    assert constants.VALID_TASK_COMMENT_TYPES is folder_store.VALID_TASK_COMMENT_TYPES
    assert tool_comments.FEEDBACK_COMMENT_TYPES is folder_store.FEEDBACK_COMMENT_TYPES
    assert tool_comments.REWORK_COMMENT_TYPES is folder_store.REWORK_COMMENT_TYPES
    assert folder_store.FEEDBACK_COMMENT_TYPES <= folder_store.VALID_TASK_COMMENT_TYPES
    assert folder_store.REWORK_COMMENT_TYPES <= folder_store.VALID_TASK_COMMENT_TYPES


def test_retired_feedback_types_are_gone() -> None:
    """The tester/product review statuses these belonged to died with MC-1542."""
    for retired in RETIRED_COMMENT_TYPES:
        assert retired not in folder_store.VALID_TASK_COMMENT_TYPES
        assert retired not in folder_store.REWORK_COMMENT_TYPES
    assert folder_store.FEEDBACK_COMMENT_TYPES == {"review_feedback", "architect_feedback"}


def test_renderer_badge_labels_resolve_every_comment_type() -> None:
    """The renderer keeps its own label table; pin it to the Python vocabulary."""
    source = (REPO_ROOT / "src/shared/sprintengine/state.ts").read_text(encoding="utf-8")
    match = re.search(
        r"export const sprintEngineTaskCommentTypeLabels: Record<SprintEngineTaskCommentType, string> = \{([^}]*)\}",
        source,
    )
    assert match, "sprintEngineTaskCommentTypeLabels not found in src/shared/sprintengine/state.ts"
    labelled = {line.split(":", 1)[0].strip() for line in match.group(1).splitlines() if ":" in line}
    assert folder_store.VALID_TASK_COMMENT_TYPES <= labelled
