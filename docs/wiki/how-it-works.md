---
title: How it works
parent: home
code: [bin/hypatia.js, lib/build-graph.js, lib/text.js, lib/update-check.js]
verified: 6dfaa884cdbe
---

# How it works

Hypatia is one small command-line program with no dependencies. It reads your README.md and the pages in `docs/wiki/`, turns them into a graph, and shows that graph as a website.

## The commands

- `hypatia init` sets it up in a repo. See [Installing](installing.md).
- `hypatia upgrade` brings the skill and workflows init copied in up to the running version. `check` and `serve` print one line when they are older. See [Upgrading](installing.md#upgrading).
- `hypatia serve` builds the wiki in memory and opens it at `http://localhost:4410/`. It watches README.md, `docs/wiki/` and `docs/hypatia.yml`, and the open page reloads by itself when one changes. Nothing is written into the repo. `--port` picks another port, `--no-open` skips the browser. See [the website](the-website.md).
- `hypatia build --out <folder>` writes the site and its data (`graph.json`, `graph.js`) to a folder, `_site` by default, ready for GitHub Pages or any static server. Pages marked private are left out.
- `hypatia check` runs every check a build would, writes nothing, and says what to fix. With `drift: warn` or `drift: error` it also lists pages whose code changed since they were verified; `--base <ref>` adds what changed since that branch, `--warn` only lists, `--no-drift` skips it. See [Writing pages](writing-pages.md#keeping-pages-in-step-with-the-code). In a repo without Hypatia it says so and prints the one-line prompt to paste into a coding agent to install it.
- `hypatia verify <page.md>...` (or `--all`) stamps pages as reread against their code: it writes `verified:` in the front matter and nothing else.
- `hypatia protect` makes the wiki-check job a required check on the default branch, after a yes, through `gh`. `hypatia hooks install` adds a git pre-push hook that shows the check as warnings and never blocks the push; `hooks remove` takes it out. See [the workflows](workflows.md).
- `hypatia mirror --out <folder>` writes the published pages into a clone of the repo's GitHub Wiki, so the Wiki tab shows them too.
- `hypatia ping` posts a review request or a wiki question to Discord, from a GitHub Actions event. `--dry-run` prints the post instead.

`mirror` and `ping` run in optional workflows; see [the workflows](workflows.md).

`init`, `upgrade`, `check` and `serve` also say, in one line (and in a small note on the local site), when a newer Hypatia is on npm, with the command that updates the copy you ran. They ask npm at most once a day, give up after a second and a half, and stay quiet in CI or with `HYPATIA_NO_UPDATE_CHECK` set; `build`, `mirror` and `ping` never ask.

`hypatia` on its own lists the commands, one line each, and `hypatia --version` prints the version; `hypatia help <command>` (or `<command> --help`) gives that command's options and details. A mistyped command gets a "did you mean" hint.

## The graph

Every page is a node. README.md is the center, hubs sit around it, and each page sits near its hub. A page's parent and every link it makes become the lines between nodes. Positions are fixed for the same input, so the map does not jump around between builds.

On top of the pages, the graph holds data from git and GitHub: each page's last change, recent commits, active branches, and open issues and pull requests. Each page also carries its stamp state (current, stale, unverified, or none without `code:`), which the map shows as rings. That data is how [the team view](team-view.md) knows who is working on what.

Pages are read the same way on every computer: Windows line endings and the byte order mark some editors add are fine.

## The website

[The website](the-website.md) shows the graph: the map, the pages, search and the Ask box. It is the same plain HTML, CSS and JavaScript locally and on GitHub Pages. Before anything is published, [the privacy guard](privacy-guard.md) scans it.

## The workflows

On GitHub, [the workflows](workflows.md) publish the website, check every pull request, and optionally copy the pages to the Wiki tab and post review requests to Discord.
