# Install Hypatia - guide for coding agents

You are a coding agent (Claude Code, Codex, Cursor or similar) and a human asked you to install Hypatia in the repo you are working in. Hypatia adds a team wiki: Markdown pages in `docs/wiki/`, a map of how the code connects, and a view of who is working on what. Follow these steps in order. Run every command from the repo's top folder.

**Already installed?** If `.claude/skills/wiki-keeper/SKILL.md` exists, update instead of installing: run `npx --yes hypatia upgrade --dry-run`, show the human the plan (it may add `drift: warn` to the config and replace files edited by hand), and with their okay run `npx --yes hypatia upgrade --yes` (add `--no-drift` if they do not want `drift: warn` added). Then go to step 6.

## 1. Check the basics

```shell
node --version                 # needs v18 or newer
git rev-parse --show-toplevel  # needs to print a folder: this must be a git repo
```

If Node is older than 18 or missing, or this is not a git repo, stop and tell the human what is missing. Do not install Node or run `git init` without asking.

## 2. Preview the setup

```shell
npx --yes hypatia init --dry-run
```

The first line says whether the repo is **public** or **private**. Nothing changes yet. If it lists **Privacy guard** findings (often a maintainer's email in README.md), the check in step 6 will fail on them; deal with them there.

## 3. Run init

- **Private** (or "no GitHub remote"): run `npx --yes hypatia init`.
- **Public**: init would also add two GitHub workflows, turn on GitHub Pages and set the repo's About website, which publishes the wiki. Show the human the `.github/workflows` and `GitHub:` lines from the preview and ask before going on. If they say yes, run `npx --yes hypatia init --yes`. If they say no, run `npx --yes hypatia init --private` (wiki on their computer only).

Success looks like a line starting `Done:` and exit code 0. Init never overwrites a file, so running it again is safe.

## 4. Read the wiki-keeper skill

Init installed it at `.claude/skills/wiki-keeper/SKILL.md`. Claude Code loads it by itself. Any other agent: read that file now and follow it whenever you change this repo's code; if the repo has an `AGENTS.md` or `.cursor/rules`, ask the human whether to add a line pointing at it.

## 5. Write the first pages

Read the repo first: README, the top-level folders, and the main entry points. Then write `docs/wiki/<slug>.md` files (slugs are lowercase words joined by `-`):

1. **Hubs**: one page per top-level area of the code (for example `web-app`, `api`, `data`), with `parent: home`.
2. **Parts**: one page per meaningful part inside an area, with `parent: <its hub>` and `code: [<paths or globs>]` for the code it explains. Skip trivial files; 5 to 15 pages is a good first pass.
3. **Start here**: rewrite `docs/wiki/start-here.md` (`parent: home`) so it links to every hub with one line each.
4. **Links**: link pages that work together (`[the API](api.md)`). Every link is a line on the map.
5. **README**: add one line to README.md that links `docs/wiki/start-here.md`, so readers and the map find the wiki.

Front matter, at the top of every page:

```
---
title: Search
parent: web-app
code: [src/search/**]
---
```

Write for a newcomer: what each part does for the project, what it uses, and how it breaks. A few short paragraphs or bullets per page. Never invent facts: write `TODO(owner): <question>` instead. Never put real emails, names of the app's users, records or keys on a page; use made-up values like `user@example.com`.

## 6. Check until it passes

```shell
npx --yes hypatia check
```

Fix what it reports and run it again until it prints `Wiki check passed`. Warnings do not fail the check, but fix any "no link leads to it" warning by linking that hub from start-here.

Init set `drift: warn`, so the check also lists every page with `code:` as never verified. You just wrote those pages from the code, so stamp them: `npx --yes hypatia verify --all`. From now on, the skill has the agent reread a page and run `hypatia verify <page>` whenever its code changes.

If the privacy guard flags something you did not write (for example an email address already in README.md), show the human the line and ask. If they say it is public and fine to publish, add it to `docs/hypatia.yml`:

```yaml
allow: [maintainer@example.com]   # the exact value the human approved
```

Never allow a key, a password or a token: those must be removed.

## 7. Tell the human

- Open the wiki locally: `npm run wiki` if init added that script, else `npx hypatia serve` (opens http://localhost:4410/).
- Public repo with the website set up: once the new files are committed and pushed to the default branch, the wiki is published at `https://<owner>.github.io/<repo>/` (init printed the exact address).
- List the pages you wrote and the `TODO(` questions you left for them.
- Optional: `npx hypatia protect` (after the check workflow is pushed) makes the wiki check required before merging; `npx hypatia hooks install` warns before each push on this computer.

Do not commit or push unless the human asks you to.

More: https://maxhawksby.github.io/hypatia/
