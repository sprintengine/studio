"""Entrypoint for ``python -m sprintengine_mcp``."""

from .server import main


if __name__ == "__main__":
    raise SystemExit(main())
