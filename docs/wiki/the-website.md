---
title: The website
parent: how-it-works
code: [site/**, lib/serve.js]
---

# The website

The website is where people read the wiki. It is plain HTML, CSS and JavaScript with no build step, and the same files run on your computer and on GitHub Pages. Hypatia only adds the data: `graph.json`, built from the pages, git and GitHub (see [the graph](how-it-works.md#the-graph)).

## What is on it

- **The map**: every page as a node, the center page in the middle and hubs around it. Pages are grey; a page takes a teammate's color while they work on it.
- **Pages**: the page itself, its breadcrumb, a Connections list and backlinks.
- **The sidebar**: the page tree, the people (from [the team view](team-view.md)) with all open work, and recent changes.
- **Search** with highlights, a quick switcher (Ctrl+K), and resizable panes. The map can be hidden.
- **The Ask box** under each page: it turns a question or a change request into a ready prompt to copy into your coding agent, or opens a question for the team as a GitHub issue.

With no data at all, the site shows a made-up sample project instead of an empty screen.

## On your computer

`hypatia serve` builds the data in memory and serves the site at `http://localhost:4410/`. Nothing is written into the repo. It watches README.md, `docs/wiki/` and the config, and the open page reloads by itself when one changes. It re-reads GitHub every five minutes.

The local site also shows small notes the website never does: broken links (struck out, so you can keep writing), what [the privacy guard](privacy-guard.md) found, and when a newer Hypatia is on npm. Private pages show here too.

## How it breaks

- The port is taken, often because the wiki is already open in another terminal: it says so; use that one or pick another with `--port <number>`.
- The wiki cannot rebuild (say, a page lost its title): the open page keeps the last good version and a note says what is wrong. Fix the page and it reloads.
- No `gh` sign-in and no `GITHUB_TOKEN`: the site still works, but the team and work come from git alone.

On GitHub Pages, the [wiki-site workflow](workflows.md) builds and publishes the same site.
