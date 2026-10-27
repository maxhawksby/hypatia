# Hypatia

Hypatia is a tool that installs a graph-style team wiki into any git repo, plus a
who's-working-on-what view.

## Origin

Being extracted from the wiki in ~/personal/go2-fusion: docs/wiki, scripts/wiki, site/,
tools/oak-wiki, .github/workflows/wiki-*.yml, and .claude/skills/wiki-keeper.
Milestone 1 moved the site, builder and local server here and ported them to Node.
Milestone 2 (branch milestone-2) made them generic: the title, team and colors come from
the repo, git and GitHub. go2-fusion itself is unchanged and still builds as before from
its docs/team.yml.

## Status

- Early scaffold, local only (no GitHub remote yet).
- Brief: docs/BRIEF.md (the spec; milestones 1-5).
- Stack: Node 18+, built-ins only, no dependencies. `npm test` runs everything.

## Layout

- bin/hypatia.js - the CLI: `hypatia serve` (local site, live reload), `hypatia build --out <dir>`,
  `hypatia check`.
- lib/build-graph.js - builds graph.json (pages, links, history, branches, GitHub work).
- lib/team.js - the team: git authors, GitHub logins and collaborators, palette colors, and
  the optional config (docs/hypatia.yml, or the older docs/team.yml). Shape in README.md.
- lib/serve.js - local server, file watcher, reload events.
- site/ - the wiki web app (index.html, app.js, style.css), served as is. sample-graph.json
  is a made-up project shown when there is no data.
- skills/, templates/workflows/ - wiki-keeper skill and Pages workflows as templates with
  {{PLACEHOLDERS}} (lib/templates.js lists them) that the install (milestone 3) fills in.
- test/generic.test.js - nothing shipped or built may name the project Hypatia came from.
