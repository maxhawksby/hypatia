# AGENTS.md

For coding agents working on Hypatia itself. To install Hypatia in another repo, follow [INSTALL-AGENT.md](INSTALL-AGENT.md) instead.

## Commands

- `npm test` - runs every test (Node's built-in test runner). Must pass before any commit.
- `node bin/hypatia.js check` - checks this repo's own wiki. Must pass when you touch `docs/wiki/` or README.md.
- `npm run wiki` - opens this repo's wiki locally with live reload.

## Layout

- `bin/hypatia.js` - the CLI: `init`, `serve`, `build`, `check`.
- `lib/` - one file per job: `init.js`, `build-graph.js`, `team.js`, `privacy.js`, `lint.js`, `serve.js`.
- `site/` - the wiki web app, plain HTML, CSS and JavaScript, served as is.
- `skills/`, `templates/workflows/` - the wiki-keeper skill and Pages workflows, as templates `init` fills in.
- `docs/wiki/` - Hypatia's own wiki. Each page's `code:` says which files it explains.

## Rules

- Node 18+ built-ins only. No dependencies.
- Nothing Hypatia ships (`bin`, `lib`, `site`, `skills`, `templates`) may name the project it was extracted from; `test/generic.test.js` enforces this.
- Tests never call the real GitHub: `init` reaches GitHub only through `gh`, and `HYPATIA_GH` swaps in a stand-in.
- When you change code a wiki page explains, update that page in the same change, following `.claude/skills/wiki-keeper/SKILL.md`.
- Commit messages are one plain sentence that says what changed.
- Plain dashes in text, never em dashes.
- Releasing: bump `version` in package.json and push to main; `.github/workflows/publish.yml` tests and publishes it to npm. Bump when anything people run changes (`bin`, `lib`, `site`, `skills`, `templates`); docs and wiki changes need no bump.
