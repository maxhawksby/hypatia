---
title: The workflows
parent: how-it-works
code: [templates/workflows/**, .github/workflows/wiki-*.yml, lib/mirror.js, lib/ping.js]
---

# The workflows

Hypatia does its GitHub work through GitHub Actions workflows that [init](installing.md) copies into `.github/workflows/`. Each one is a template with the repo's default branch, wiki folder, config file and run command filled in. They run on GitHub's free runners; only the Discord ping needs a secret.

## The website: wiki-site and wiki-refresh

For public repos. `wiki-site.yml` builds [the website](the-website.md) with `hypatia build` and publishes it with GitHub Pages. It always builds the default branch, and rebuilds when the pages or the config change there, when issues, comments or pull requests change (so "working on now", questions and review requests stay current) and every hour. `wiki-refresh.yml` asks for that rebuild when someone pushes to any other branch, since Pages only publishes from the default one.

Pull requests use `pull_request_target`, so the workflow runs from the default branch and never runs a pull request's code. Until Pages is turned on with Source: GitHub Actions, the deploy step fails but the build still checks the wiki.

## The pull request check: wiki-check

`wiki-check.yml` runs `hypatia check` on every pull request, with full history so it can see what the pull request changed, and hands it the description. That is how the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code) reads a `wiki: no change needed - <reason>` line; editing the description runs it again.

## The Wiki tab: wiki-mirror

Optional (`init --with mirror`). When the pages change on the default branch, `hypatia mirror` copies the published pages into the repo's GitHub Wiki. README.md becomes Home, links point at wiki pages or GitHub, front matter is dropped, and each page ends with a link to edit it in the repo. Pages deleted from the repo disappear from the Wiki tab too. Private pages are never copied, and nothing is copied while the [privacy guard](privacy-guard.md) finds something.

It breaks until a repo admin turns on Wikis and creates one page by hand, because GitHub only creates the Wiki's own repository then. The workflow says so.

## Discord: wiki-ping

Optional (`init --with ping`). `hypatia ping` posts to Discord when a pull request asks for review (Who, What, Why, Before and After from its description, the pages it touches, the link) or an issue is labelled `question` (asking whoever works on that page, else whoever changed it last). People with a `discord_id` in [the configuration](configuration.md) are @mentioned; others are named.

It needs a webhook saved as a repo secret: `DISCORD_REVIEW_WEBHOOK_URL`, and optionally `DISCORD_QUESTIONS_WEBHOOK_URL` for a separate questions channel. With none set it logs "Discord not set up yet" and passes. GitHub sends a second event right after a pull request or issue is created (labels and reviewers set at creation), and ping skips that echo so nobody is posted twice.

## Keeping them current

Each workflow carries a version stamp in its first line. `hypatia upgrade` rewrites them from the running version; see [Upgrading](installing.md#upgrading). This repo runs its own wiki-site, wiki-refresh and wiki-check, with `node bin/hypatia.js` as the command, so its website always builds with its latest code.
