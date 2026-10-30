---
title: Installing
parent: start-here
code: [lib/init.js, lib/upgrade.js, lib/templates.js, INSTALL-AGENT.md, llms.txt]
verified: 109b6cd2f557
---

# Installing

You need Node 18 or newer and a git repo. Nothing else: Hypatia has no dependencies.

## With a coding agent (recommended)

Paste this into Claude Code, Codex, Cursor or any agent that can run commands:

```
Install Hypatia in this repo by following https://raw.githubusercontent.com/maxhawksby/hypatia/main/INSTALL-AGENT.md
```

The agent runs init, reads the repo, writes the first pages and runs the check until it passes. The guide it follows is [INSTALL-AGENT.md](../../INSTALL-AGENT.md). Agents that look for `llms.txt` find it there too.

Hypatia needs an agent to be useful: init only sets up the folder, the skill and the site, and the agent writes the pages that describe your code and keeps them current.

## By hand

```shell
npx hypatia init     # set it up in this repo
npx hypatia serve    # open the wiki at http://localhost:4410/
```

`npx hypatia init --dry-run` prints the plan and changes nothing. After init, ask your coding agent to write the pages with the wiki-keeper skill.

## What init does

Every repo gets:

- `docs/wiki/start-here.md`, a starter hub page, when there are no wiki pages yet;
- the wiki-keeper [agent skill](agent-skill.md) in `.claude/skills/wiki-keeper/`;
- a `wiki` npm script (when there is a package.json), or the one-line command that opens the wiki;
- `.github/workflows/wiki-check.yml`, which runs `hypatia check` on every pull request;
- `drift: warn` in `docs/hypatia.yml` (or the older `docs/team.yml`), so the check lists pages that fell behind their code without failing. A `drift:` line already there is left as it is.

A public repo (GitHub says so, or `--public`) also gets these, but only after a yes at the prompt or `--yes`:

- `.github/workflows/wiki-site.yml` and `wiki-refresh.yml`, which build the site and publish it with GitHub Pages;
- GitHub Pages turned on with Source: GitHub Actions, if it is off (`POST repos/<repo>/pages`, through `gh`);
- the repo's About website set to the Pages address, if it is empty (`PATCH repos/<repo>`, `homepage`).

A website already in the About box, or Pages already publishing from a branch, is left alone. A private repo gets no website; its wiki opens locally. `--private` says "no website" for a public repo too. Init never overwrites a file and is safe to run again: it says what it left alone.

Its next steps also point at two optional commands: `hypatia protect`, after the check workflow is pushed, to make the check required before merging, and `hypatia hooks install` for warnings before each push. See [the workflows](workflows.md#the-pull-request-check-wiki-check).

## Optional workflows

`--with` adds GitHub workflows to any repo, public or private, because you asked for them (comma separated, e.g. `npx hypatia init --with mirror,ping`; `check` is still accepted, though every repo gets it now):

- `mirror`: `wiki-mirror.yml` copies the published pages to the repo's GitHub Wiki tab after each merge, with `hypatia mirror`. README.md becomes Home, links point at wiki pages or GitHub, and each page links back to its file. It mirrors only the default branch. Turn on Wikis and create one page by hand first; the workflow says how.
- `ping`: `wiki-ping.yml` posts to Discord with `hypatia ping` when a pull request asks for review (Who, What, Why, Before and After from its description, the pages it touches, the link) or an issue is labelled `question` (asking whoever works on the page). People with a `discord_id` in [the configuration](configuration.md) are @mentioned, and only they: a mention typed in an issue title stays plain text. It needs a webhook secret, `DISCORD_REVIEW_WEBHOOK_URL` (and optionally `DISCORD_QUESTIONS_WEBHOOK_URL`); without one it passes quietly. It runs from the default branch and never runs a pull request's code.

## Which command the files name

Everything init writes is committed and shared, so it names Hypatia the way a teammate would run it: `npx hypatia serve` and `npx hypatia check` in the pages, the skill and the `wiki` script, and `npx hypatia@<version>` in the workflows, so the website and the check keep running the version they were set up with. `--runner "<command>"` names another command for all of them. This repo uses `--runner "node bin/hypatia.js"`, so its own website always builds with its own latest code.

## Upgrading

Init copies the skill and the workflows into your repo, so a newer Hypatia does not change them by itself. Each file it writes carries a stamp: a comment line with the Hypatia version that wrote it and a short fingerprint of the rest of the file. When the files are older than the Hypatia you run, `hypatia check` (and `hypatia serve`) print one line saying so. The notice never fails the check. They also say when a newer Hypatia itself is on npm, with the command to get it.

To update them:

```shell
npx hypatia upgrade --dry-run   # see the plan; nothing changes
npx hypatia upgrade             # see the plan, then say yes
```

Upgrade does this, after a yes at the prompt or `--yes`:

- rewrites the wiki-keeper skill and every Hypatia workflow already in `.github/workflows/` from this version, keeping your default branch, config file and runner. A workflow pinned to `npx hypatia@<old>` moves to this version; a custom runner from `--runner` stays as it is;
- adds `wiki-check.yml` to any repo that lacks it. Mirror and ping workflows are updated only if you have them, never added;
- when the config has no `drift:` line, offers to add `drift: warn` to `docs/hypatia.yml` (or the older `docs/team.yml`), leaving every other line alone, so the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code) lists stale pages without failing. `--no-drift` skips it, and a `drift:` line already there is never changed.

The plan marks each file: `~` will be replaced, `+` will be added, `=` already current. A file someone edited by hand is still replaced after the yes, so its line says those edits will be lost; say no if you want to keep them. Files from before version stamps (0.2.x) can't show whether they were edited, and their line says that too. Upgrade never changes GitHub settings and never calls GitHub.

Next: [write the first pages](writing-pages.md), or read [how it works](how-it-works.md).
