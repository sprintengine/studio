"""Command-line entrypoint for ``python -m switchboard_core``."""

from .cli import main


if __name__ == "__main__":
    raise SystemExit(main())
