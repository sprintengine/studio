"""The MCP protocol versions this engine can honestly serve.

One table, imported by every transport (`server.py` stdio dispatch,
`http_server.py`), because the previous inline constants are exactly how the two
Multicode MCP servers drifted apart — the socket gateway defaulted to
`2025-03-26` while this engine defaulted to `2024-11-05`.

A version belongs here only once the semantics behind it exist: answering
`initialize` with a version we do not implement is the lie this module was
created to remove. The TypeScript half is `src/shared/mcp/protocol.ts` and
carries the same set.
"""

from __future__ import annotations

from typing import cast

# Newest-first. The head is what we answer when the client's ask is not on the list.
# `2026-07-28` is earned by the HTTP transport, not assumed: session-less requests
# (SEP-2575/SEP-2567), the per-request version declaration, the `Mcp-Method`/`Mcp-Name`
# headers (SEP-2243), and `ttlMs` on `tools/list` (SEP-2549) all land in `http_server.py`
# and `server.py` in the same commit that prepends it here.
SUPPORTED_PROTOCOL_VERSIONS: tuple[str, ...] = ("2026-07-28", "2025-06-18", "2025-03-26", "2024-11-05")

DEFAULT_PROTOCOL_VERSION: str = SUPPORTED_PROTOCOL_VERSIONS[0]

# What the spec says an HTTP request means when it declares no version at all.
LEGACY_HTTP_ASSUMED_VERSION = "2025-03-26"


def is_supported_protocol_version(value: object) -> bool:
    return isinstance(value, str) and value in SUPPORTED_PROTOCOL_VERSIONS


def negotiate_protocol_version(requested: object) -> str:
    """Answer a supported request with itself, anything else with the default.

    Never raises. The spec's rule for an unsupported `initialize` is to respond
    with a version the server does support and let the client decide whether to
    continue; an error here would break clients that would have accepted our
    answer. `requested` is deliberately `object`: it arrives straight off the
    wire, so a missing key, `None`, or a non-string all land in the same branch.
    """
    if is_supported_protocol_version(requested):
        return cast(str, requested)
    return DEFAULT_PROTOCOL_VERSION
