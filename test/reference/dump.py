"""Print the graph the reference Python builder makes for one repo, as JSON.

    python3 -B test/reference/dump.py <repo folder>

Used by test/parity.test.js. Writes nothing to the repo: build() runs with
the module's folders pointed at <repo folder> and the result goes to stdout.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_graph as bg  # noqa: E402

root = Path(sys.argv[1]).resolve()
bg.ROOT = root
bg.WIKI = root / "docs" / "wiki"
bg.TEAM = root / "docs" / "team.yml"
bg.OUT = None  # never written
json.dump(bg.build(), sys.stdout)
