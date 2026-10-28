---
title: Installing
parent: start-here
code: [lib/init.js, INSTALL-AGENT.md, llms.txt]
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
- a `wiki` npm script (when there is a package.json), or the one-line command that opens the wiki.

A public repo (GitHub says so, or `--public`) also gets these, but only after a yes at the prompt or `--yes`:

- `.github/workflows/wiki-site.yml` and `wiki-refresh.yml`, which build the site and publish it with GitHub Pages;
- `.github/workflows/wiki-check.yml`, which runs `hypatia check` on every pull request (and the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code), when it is on);
- GitHub Pages turned on with Source: GitHub Actions, if it is off (`POST repos/<repo>/pages`, through `gh`);
- the repo's About website set to the Pages address, if it is empty (`PATCH repos/<repo>`, `homepage`).

A website already in the About box, or Pages already publishing from a branch, is left alone. A private repo gets no website; its wiki opens locally. `--private` says "no website" for a public repo too. Init never overwrites a file and is safe to run again: it says what it left alone.

## Optional workflows

`--with` adds GitHub workflows to any repo, public or private, because you asked for them (comma separated, e.g. `npx hypatia init --with check,mirror`):

- `check`: the pull request check above, for a private repo;
- `mirror`: `wiki-mirror.yml` copies the published pages to the repo's GitHub Wiki tab after each merge, with `hypatia mirror`. README.md becomes Home, links point at wiki pages or GitHub, and each page links back to its file. It mirrors only the default branch. Turn on Wikis and create one page by hand first; the workflow says how.
- `ping`: `wiki-ping.yml` posts to Discord with `hypatia ping` when a pull request asks for review (Who, What, Why, Before and After from its description, the pages it touches, the link) or an issue is labelled `question` (asking whoever works on the page). People with a `discord_id` in [the configuration](configuration.md) are @mentioned, and only they: a mention typed in an issue title stays plain text. It needs a webhook secret, `DISCORD_REVIEW_WEBHOOK_URL` (and optionally `DISCORD_QUESTIONS_WEBHOOK_URL`); without one it passes quietly. It runs from the default branch and never runs a pull request's code.

## Which command the files name

Everything init writes is committed and shared, so it names Hypatia the way a teammate would run it: `npx hypatia serve` and `npx hypatia check` in the pages, the skill and the `wiki` script, and `npx hypatia@<version>` in the Pages workflow, so the website keeps building with the version it was set up with. `--runner "<command>"` names another command for all of them. This repo uses `--runner "node bin/hypatia.js"`, so its own website always builds with its own latest code.

Next: [write the first pages](writing-pages.md), or read [how it works](how-it-works.md).
