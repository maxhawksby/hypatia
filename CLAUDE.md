# Hypatia

Hypatia is a tool that installs a graph-style team wiki into any git repo, plus a
who's-working-on-what view.

## Origin

Being extracted from the wiki in ~/personal/go2-fusion: docs/wiki, scripts/wiki, site/,
tools/oak-wiki, .github/workflows/wiki-*.yml, and .claude/skills/wiki-keeper.
Milestone 1 moved the site, builder and local server here and ported them to Node.
Milestone 2 made them generic: the title, team and colors come from
the repo, git and GitHub. go2-fusion itself is unchanged and still builds as before from
its docs/team.yml.
Milestone 3 added `hypatia init` and the privacy guard.

## Status

- Public on GitHub (maxhawksby/hypatia), MIT. Published history starts at one clean commit;
  the full local history is in the `history-backup` branch (never push it: it holds the
  original go2-fusion copy with teammates' details).
- Brief: docs/BRIEF.md (the spec; milestones 1-5).
- On npm as `hypatia`. User docs are Hypatia's own wiki in docs/wiki/ (published at
  https://maxhawksby.github.io/hypatia/); README.md stays one screen. INSTALL-AGENT.md is the
  agent install guide (its raw URL is in the README); AGENTS.md is for agents working on Hypatia.
- Stack: Node 18+, built-ins only, no dependencies. `npm test` runs everything.

## Layout

- bin/hypatia.js - the CLI: `hypatia init`, `hypatia serve` (local site, live reload),
  `hypatia build --out <dir>`, `hypatia check [--base <ref>]`, `hypatia mirror --out <dir>`,
  `hypatia ping`, `hypatia upgrade`.
- lib/init.js - `hypatia init`: starter page, skill, open command; public repos get the Pages
  workflows and two GitHub settings after a yes. GitHub only through gh (HYPATIA_GH swaps it;
  tests never run the real one).
- lib/upgrade.js - `hypatia upgrade`: re-renders the installed skill and workflows from this
  version's templates (keeps branch and runner), adds wiki-check for a repo with the website,
  offers `drift: true`. Also the one-line "setup is from an older Hypatia" notice in check and
  serve. Installed files carry a version stamp and hash (lib/templates.js).
- lib/privacy.js - the privacy guard: patterns, allow list, masking. Private pages are left out
  in lib/build-graph.js (`publish: true`).
- lib/build-graph.js - builds graph.json (pages, links, history, branches, GitHub work).
- lib/team.js - the team: git authors, GitHub logins and collaborators, palette colors, and
  the optional config (docs/hypatia.yml, or the older docs/team.yml). Shape in docs/wiki/configuration.md.
- lib/serve.js - local server, file watcher, reload events.
- lib/lint.js - the extra checks in `hypatia check`: code paths that match nothing, hubs README.md
  does not lead to, TODO( markers.
- lib/drift.js - drift (a PR changed a page's code but not the page; escape line
  "wiki: no change needed - <reason>") and coverage (every folder under `coverage:` has a page).
  Both off until docs/hypatia.yml sets `drift: true` / `coverage: [src]`; `check --base` forces drift.
- lib/mirror.js - `hypatia mirror`: published pages into a GitHub Wiki clone (wiki-mirror workflow).
- lib/ping.js - `hypatia ping`: Discord posts for review requests and questions (wiki-ping
  workflow); @mentions people's opt-in `discord_id` from the config, which graph.json carries.
- site/ - the wiki web app (index.html, app.js, style.css), served as is. sample-graph.json
  is a made-up project shown when there is no data.
- skills/, templates/workflows/ - wiki-keeper skill and workflows as templates with
  {{PLACEHOLDERS}} (lib/templates.js lists them) that `hypatia init` fills in. Public repos get
  wiki-site, wiki-refresh and wiki-check; `init --with check,mirror,ping` adds them to any repo.
- test/generic.test.js - nothing shipped or built may name the project Hypatia came from.
