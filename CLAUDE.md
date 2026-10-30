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
  `hypatia build --out <dir>`, `hypatia check [--base <ref>] [--warn]`, `hypatia verify`,
  `hypatia mirror --out <dir>`, `hypatia ping`, `hypatia upgrade`, `hypatia protect`, `hypatia hooks`.
- lib/init.js - `hypatia init`: starter page, skill, open command, the wiki-check workflow and
  `drift: warn` in every repo; public repos get the Pages workflows and two GitHub settings
  after a yes. GitHub only through gh (HYPATIA_GH swaps it;
  tests never run the real one).
- lib/upgrade.js - `hypatia upgrade`: re-renders the installed skill and workflows from this
  version's templates (keeps branch and runner), adds wiki-check to any repo that lacks it,
  offers `drift: warn` when the config has no drift: line. Also the one-line "setup is from
  an older Hypatia" notice in check and serve. Installed files carry a version stamp and hash (lib/templates.js).
- lib/privacy.js - the privacy guard: patterns, allow list, masking. Private pages are left out
  in lib/build-graph.js (`publish: true`).
- lib/build-graph.js - builds graph.json (pages, links, history, branches, GitHub work).
- lib/team.js - the team: git authors, GitHub logins and collaborators, palette colors, and
  the optional config (docs/hypatia.yml, or the older docs/team.yml). Shape in docs/wiki/configuration.md.
- lib/serve.js - local server, file watcher, reload events.
- lib/lint.js - the extra checks in `hypatia check`: code paths that match nothing, hubs README.md
  does not lead to, TODO( markers.
- lib/stamp.js - stamps: a page's `verified:` line is a 12-hex sha256 of the files its `code:`
  matches; `hypatia verify` writes it after the page is reread.
- lib/drift.js - drift (a page with `code:` whose stamp no longer matches, or that has none, is
  stale; per-page skip line "wiki: no change needed for <page.md> - <reason>" in a PR) and
  coverage (every folder under `coverage:` has a page). `drift: off | warn | error` in
  docs/hypatia.yml (true means error, missing means off); `check --warn` forces warn.
- lib/protect.js - `hypatia protect`: makes the wiki-check job required on the default branch.
- lib/hooks.js - `hypatia hooks install | remove`: a pre-push hook that runs the check as
  warnings and never blocks the push.
- lib/mirror.js - `hypatia mirror`: published pages into a GitHub Wiki clone (wiki-mirror workflow).
- lib/ping.js - `hypatia ping`: Discord posts for review requests and questions (wiki-ping
  workflow); @mentions people's opt-in `discord_id` from the config, which graph.json carries.
- site/ - the wiki web app (index.html, app.js, style.css), served as is. sample-graph.json
  is a made-up project shown when there is no data.
- skills/, templates/workflows/ - wiki-keeper skill and workflows as templates with
  {{PLACEHOLDERS}} (lib/templates.js lists them) that `hypatia init` fills in. Every repo gets
  wiki-check, public repos also wiki-site and wiki-refresh; `init --with mirror,ping` adds those.
- test/generic.test.js - nothing shipped or built may name the project Hypatia came from.
