---
title: The workflows
parent: how-it-works
code: [templates/workflows/**, .github/workflows/wiki-*.yml, lib/mirror.js, lib/ping.js, lib/protect.js, lib/hooks.js]
verified: 1f7ef0ccb8c8
---

# The workflows

Hypatia does its GitHub work through GitHub Actions workflows that [init](installing.md) copies into `.github/workflows/`. Each one is a template with the repo's default branch, wiki folder, config file and run command filled in. They run on GitHub's free runners; only the Discord ping needs a secret.

## The website: wiki-site and wiki-refresh

For public repos. `wiki-site.yml` builds [the website](the-website.md) with `hypatia build` and publishes it with GitHub Pages. It always builds the default branch, and rebuilds when the pages or the config change there, when issues, comments or pull requests change (so "working on now", questions and review requests stay current) and every hour. `wiki-refresh.yml` asks for that rebuild when someone pushes to any other branch, since Pages only publishes from the default one.

Pull requests use `pull_request_target`, so the workflow runs from the default branch and never runs a pull request's code. Until Pages is turned on with Source: GitHub Actions, the deploy step fails but the build still checks the wiki.

## The pull request check: wiki-check

Every repo gets it. `wiki-check.yml` runs `hypatia check` on every pull request, with full history so it can list what changed, and hands it the description. That is how the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code) reads a `wiki: no change needed for <page.md> - <reason>` line; editing the description runs it again. With `drift: warn` stale pages show as warnings and the check passes; with `drift: error` it fails.

A failing check only blocks merging once GitHub requires it. `hypatia protect` does that after a yes: when the default branch's protection already requires status checks it adds `wiki-check` to that list, otherwise it adds a ruleset named "Hypatia wiki check", and it changes nothing else. When `gh` is missing or GitHub says no (a private repo on a free plan can't require checks), it prints the steps to do it by hand.

On your own computer, `hypatia hooks install` writes a git pre-push hook that runs `hypatia check --warn` against origin's default branch, which it looks up at push time, so you see what the pull request check would say. It never blocks the push. A pre-push hook that isn't Hypatia's is left alone, and Hypatia prints the lines to add to it.

## The Wiki tab: wiki-mirror

Optional (`init --with mirror`). When the pages change on the default branch, `hypatia mirror` copies the published pages into the repo's GitHub Wiki. README.md becomes Home, links point at wiki pages or GitHub, front matter is dropped, and each page ends with a link to edit it in the repo. Pages deleted from the repo disappear from the Wiki tab too. Private pages are never copied, and nothing is copied while the [privacy guard](privacy-guard.md) finds something.

It breaks until a repo admin turns on Wikis and creates one page by hand, because GitHub only creates the Wiki's own repository then. The workflow says so.

## Discord: wiki-ping

Optional (`init --with ping`). `hypatia ping` posts to Discord when a pull request asks for review (Who, What, Why, Before and After from its description, the pages it touches, the link) or an issue is labelled `question` (asking whoever works on that page, else whoever changed it last). People with a `discord_id` in [the configuration](configuration.md) are @mentioned; others are named.

It needs a webhook saved as a repo secret: `DISCORD_REVIEW_WEBHOOK_URL`, and optionally `DISCORD_QUESTIONS_WEBHOOK_URL` for a separate questions channel. With none set it logs "Discord not set up yet" and passes. GitHub sends a second event right after a pull request or issue is created (labels and reviewers set at creation), and ping skips that echo so nobody is posted twice.

## Keeping them current

Each workflow carries a version stamp in its first line. `hypatia upgrade` rewrites them from the running version; see [Upgrading](installing.md#upgrading). This repo runs its own wiki-site, wiki-refresh and wiki-check, with `node bin/hypatia.js` as the command, so its website always builds with its latest code.
