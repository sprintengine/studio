"""Stable CLI entrypoint for the Sprint Engine tool package."""

from __future__ import annotations

from typing import List, Optional

from .legacy import build_parser, main as _legacy_main


def main(argv: Optional[List[str]] = None) -> int:
    return _legacy_main(argv)


__all__ = ["build_parser", "main"]
