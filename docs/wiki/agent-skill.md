---
title: The agent skill
parent: how-it-works
code: [skills/wiki-keeper/SKILL.md, .claude/skills/wiki-keeper/SKILL.md]
verified: 33b813763c61
---

# The agent skill

A wiki is only useful while it is true. Hypatia's answer is to let the coding agent that changes the code also update the page. [Init](installing.md) installs the **wiki-keeper** skill in `.claude/skills/wiki-keeper/SKILL.md`. Claude Code picks it up by itself; Codex, Cursor and other agents can be pointed at that file from their own instructions (AGENTS.md, `.cursor/rules`).

Init fills the skill in for your repo: its GitHub name, default branch, wiki folder, config file and the command that runs Hypatia there (`npx hypatia` unless you chose another with `--runner`).

## What it tells the agent

The skill makes the agent the repo's librarian, working with [stamps](writing-pages.md#keeping-pages-in-step-with-the-code): a page's `verified:` line means someone checked it against today's code.

- **Before every commit that touches code a page covers**, not only before a pull request: run `hypatia check --base origin/<default branch>`, which lists each stale or unverified page and the files that changed.
- **For each listed page**: reread those files, rewrite only the sections the change affects (never the whole page for a small change), then run `hypatia verify <page>`. It verifies only after rereading; if nothing needed to change, rereading and verifying is still right. It `git add`s new files before verifying, since untracked files are left out of the stamp, and when a merge conflicts on a `verified:` line it rereads and verifies again rather than picking a side. Pages stay plain English: what the part does, what it uses, how it breaks, a few short paragraphs at most.
- **New part of the code**: a new page with `code:` paths covering the whole folder, linked from its hub, then verified.
- **Never delete or merge pages** without asking the human first.
- **Skip lines are the exception**: `wiki: no change needed for <page.md> - <reason>` skips one page in one pull request, only with an honest reason. Verifying is preferred, and the older line that skips every page is not used.
- **Never invent facts**: write `TODO(owner): <question>` instead of guessing.
- **Finish**: rerun the check on its own work until it passes. `hypatia check --warn` is there for a quick look, but the pass that counts is the one without it.
- **Pre-push hook**: it may suggest `hypatia hooks install` to the human (warnings before each push, never blocking), but never installs it unasked.
- **When starting a task**: label the GitHub issue `wiki:<slug>` and assign itself, so [the team view](team-view.md) shows the work. If `gh` is not signed in, it gives the human the commands instead.
- **Questions**: answer "Ask the team" questions as comments on their issues, linking the page and the code, and add the answer to the page when others will ask it too. If it does not know, it says what it checked and leaves the question open.
- **Commits**: one short sentence that says what changed, starting with the part it touches, because the wiki shows them next to each person's branch.
- **Asking for review**: open the pull request with What, Why, Before and After, How to test, and a Wiki section listing each page it updated and why, one line each. Then request a teammate. With the [wiki-ping workflow](workflows.md), the request also goes to the team's Discord.
- **Privacy**: never put real records, user names, emails or keys on a page, not even as examples, and never silence the guard by adding a real value to `allow:`. See [the privacy guard](privacy-guard.md).
- **Old setup**: when the check says the repo's Hypatia files are from an older version, show the human the `hypatia upgrade --dry-run` plan, and only with their okay run the upgrade in the same pull request. They decide on the drift setting (`--no-drift` keeps upgrade from adding `drift: warn`) and on replacing files edited by hand.

The installed skill carries a version stamp after its front matter, so Hypatia can tell when it is out of date. See [Upgrading](installing.md#upgrading).

This repo has the skill installed too, so this wiki is kept by the same rules. `hypatia upgrade` brings this repo's copy up to each new version, like any other repo's.
