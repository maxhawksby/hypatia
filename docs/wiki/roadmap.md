---
title: Roadmap
parent: how-it-came-together
code: [docs/BRIEF.md]
---

# Roadmap

Hypatia does the core job today: install, a wiki with a map, [the team view](team-view.md), [the privacy guard](privacy-guard.md), and a drift check built on stamps: each page records the code it was last checked against, `hypatia verify` refreshes that after a reread, and `hypatia protect` and `hypatia hooks install` make the check required or show it before each push (see [keeping pages in step with the code](writing-pages.md#keeping-pages-in-step-with-the-code)). Ideas for what comes next, in no fixed order:

- **GitHub login**: a hosted website for private repos, behind a GitHub sign-in. Today a private repo's wiki opens only on your own computer.
- **Better first pages**: smarter starter pages for a repo that has no wiki yet.
- **More agents**: first-class setup for agents beyond Claude Code.

Have an idea or found a bug? Open an issue on [GitHub](https://github.com/maxhawksby/hypatia/issues).
