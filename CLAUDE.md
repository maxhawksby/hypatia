# Hypatia

Hypatia is a tool that installs a graph-style team wiki into any git repo, plus a
who's-working-on-what view.

## Origin

Being extracted from the wiki in ~/personal/go2-fusion: docs/wiki, scripts/wiki, site/,
tools/oak-wiki, .github/workflows/wiki-*.yml, and .claude/skills/wiki-keeper.
Milestone 1 (branch milestone-1) moved the site, builder and local server here and
ported them to Node; go2-fusion itself is unchanged.

## Status

- Early scaffold, local only (no GitHub remote yet).
- Brief: docs/BRIEF.md (the spec; milestones 1-5).
- Stack: Node 18+, built-ins only, no dependencies. `npm test` runs everything.

## Layout

- bin/hypatia.js - the CLI: `hypatia serve` (local site, live reload), `hypatia build --out <dir>`.
- lib/build-graph.js - builds graph.json; a port of go2-fusion's build_graph.py.
- lib/serve.js - local server, file watcher, reload events.
- site/ - the wiki web app (index.html, app.js, style.css), served as is.
- skills/, templates/workflows/ - wiki-keeper skill and Pages workflows, copied from
  go2-fusion unchanged; still Oak-specific (milestone 2) and not wired to an install (milestone 3).
- test/reference/ - go2-fusion's Python builder, kept only so test/parity.test.js can
  check the Node builder gives the same output.
