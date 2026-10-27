"""The one piece of go2-fusion's check_wiki.py that build_graph.py imports.

Copied unchanged from go2-fusion (scripts/wiki/check_wiki.py) so the
reference builder next to it runs on its own. Only the parity test uses it.
"""
import re


def glob_to_regex(pattern: str) -> re.Pattern:
    """Translate a path glob: ** = any folders, * = anything but '/', ? = one char.

    A pattern with no wildcard also matches everything inside it when it is a
    folder, so `src/foo` and `src/foo/` behave like `src/foo/**`.
    """
    pattern = pattern.strip()
    if pattern.startswith("./"):
        pattern = pattern[2:]
    pattern = pattern.lstrip("/")
    if not any(c in pattern for c in "*?["):
        base = re.escape(pattern.rstrip("/"))
        return re.compile(rf"^{base}(/.*)?$")
    i, out = 0, []
    while i < len(pattern):
        c = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")
