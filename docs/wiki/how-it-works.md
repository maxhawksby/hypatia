---
title: How it works
parent: home
code: [bin/hypatia.js, lib/build-graph.js, lib/serve.js, lib/mirror.js, lib/ping.js, templates/workflows/**, site/**]
---

# How it works

Hypatia is one small command-line program with no dependencies. It reads your README.md and the pages in `docs/wiki/`, turns them into a graph, and shows that graph as a website.

## The commands

- `hypatia init` sets it up in a repo. See [Installing](installing.md).
- `hypatia upgrade` brings the skill and workflows init copied in up to the running version. `check` and `serve` print one line when they are older. See [Upgrading](installing.md#upgrading).
- `hypatia serve` builds the wiki in memory and opens it at `http://localhost:4410/`. It watches README.md, `docs/wiki/` and `docs/hypatia.yml`, and the open page reloads by itself when one changes. Nothing is written into the repo. `--port` picks another port, `--no-open` skips the browser.
- `hypatia build --out <folder>` writes the site and its data (`graph.json`, `graph.js`) to a folder, `_site` by default, ready for GitHub Pages or any static server. Pages marked private are left out.
- `hypatia check` runs every check a build would, writes nothing, and says what to fix. `--base <ref>` also checks that pages kept up with the code changed since that branch. See [Writing pages](writing-pages.md). In a repo without Hypatia it says so and prints the one-line prompt to paste into a coding agent to install it.
- `hypatia mirror --out <folder>` writes the published pages into a clone of the repo's GitHub Wiki, so the Wiki tab shows them too.
- `hypatia ping` posts a review request or a wiki question to Discord, from a GitHub Actions event. `--dry-run` prints the post instead.

`mirror` and `ping` run in optional workflows; see [Installing](installing.md#optional-workflows).

## The graph

Every page is a node. README.md is the center, hubs sit around it, and each page sits near its hub. A page's parent and every link it makes become the lines between nodes. Positions are fixed for the same input, so the map does not jump around between builds.

On top of the pages, the graph holds data from git and GitHub: each page's last change, recent commits, active branches, and open issues and pull requests. That data is how [the team view](team-view.md) knows who is working on what.

## The website

The site is plain HTML, CSS and JavaScript, the same files locally and on GitHub Pages. It has the map, linked pages with backlinks, a Connections list, search with highlights, a quick switcher (Ctrl+K), resizable panes and teammate colors. The Ask box under each page turns a question or a change request into a prompt you can copy to your coding agent, or a question for the team as a GitHub issue.

On GitHub Pages, the `wiki-site.yml` workflow rebuilds the site when the pages change, when issues or pull requests change, and every hour. `wiki-refresh.yml` asks for a rebuild when someone pushes a branch, so "working on now" stays current. `wiki-check.yml` runs `hypatia check` on every pull request.

Before anything is published, [the privacy guard](privacy-guard.md) scans it.
