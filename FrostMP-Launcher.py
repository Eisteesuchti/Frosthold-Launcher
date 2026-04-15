"""Start: --json-* -> frostmp_core (ohne Tkinter), sonst frostmp_gui."""
import os
import sys

# Embeddable-Python (python._pth) lädt sonst nicht das Skriptverzeichnis — frostmp_core muss importierbar sein.
_root = os.path.dirname(os.path.abspath(__file__))
if _root not in sys.path:
    sys.path.insert(0, _root)


def main() -> None:
    if len(sys.argv) >= 2 and sys.argv[1] in ("--json-status", "--json-play", "--json-setup"):
        from frostmp_core import cli_json_main
        cli_json_main()
    else:
        from frostmp_gui import run_app
        run_app()


if __name__ == "__main__":
    main()
