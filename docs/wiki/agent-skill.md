---
title: The agent skill
parent: how-it-works
code: [skills/wiki-keeper/SKILL.md, .claude/skills/wiki-keeper/SKILL.md]
---

# The agent skill

A wiki is only useful while it is true. Hypatia's answer is to let the coding agent that changes the code also update the page. [Init](installing.md) installs the **wiki-keeper** skill in `.claude/skills/wiki-keeper/SKILL.md`. Claude Code picks it up by itself; Codex, Cursor and other agents can be pointed at that file from their own instructions (AGENTS.md, `.cursor/rules`).

Init fills the skill in for your repo: its GitHub name, default branch, wiki folder, config file and the command that runs Hypatia there (`npx hypatia` unless you chose another with `--runner`).

## What it tells the agent

- **Before a pull request**: run `hypatia check --base origin/<default branch>`, which names every page whose `code:` paths changed while the page did not. Read the diff for that code and update each page in plain English: what the part does, what it uses, how it breaks. No function names or line-by-line walkthroughs, and a few short paragraphs at most. A new part of the code gets a new page with `code:` paths covering the whole folder, linked from its hub; a removed part loses its page. When a change truly does not affect a page, say so in the pull request with `wiki: no change needed - <reason>`, which the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code) accepts.
- **Never invent facts**: write `TODO(owner): <question>` instead of guessing.
- **When starting a task**: label the GitHub issue `wiki:<slug>` and assign itself, so [the team view](team-view.md) shows the work. If `gh` is not signed in, it gives the human the commands instead.
- **Questions**: answer "Ask the team" questions as comments on their issues, linking the page and the code, and add the answer to the page when others will ask it too. If it does not know, it says what it checked and leaves the question open.
- **Commits**: one short sentence that says what changed, starting with the part it touches, because the wiki shows them next to each person's branch.
- **Asking for review**: open the pull request with What, Why, Before and After, How to test, and the wiki page it updated, then request a teammate. With the [wiki-ping workflow](workflows.md), the request also goes to the team's Discord.
- **Privacy**: never put real records, user names, emails or keys on a page, not even as examples, and never silence the guard by adding a real value to `allow:`. See [the privacy guard](privacy-guard.md).
- **Finish**: run `hypatia check` until it passes.
- **Old setup**: when the check says the repo's Hypatia files are from an older version, show the human the `hypatia upgrade --dry-run` plan, and with their okay run the upgrade in the same pull request. They decide on the drift check and on replacing files edited by hand.

The installed skill carries a version stamp after its front matter, so Hypatia can tell when it is out of date. See [Upgrading](installing.md#upgrading).

This repo has the skill installed too, so this wiki is kept by the same rules. `hypatia upgrade` brings this repo's copy up to each new version, like any other repo's.
