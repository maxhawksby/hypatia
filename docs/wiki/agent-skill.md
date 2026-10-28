---
title: The agent skill
parent: how-it-works
code: [skills/wiki-keeper/SKILL.md, .claude/skills/wiki-keeper/SKILL.md]
---

# The agent skill

A wiki is only useful while it is true. Hypatia's answer is to let the coding agent that changes the code also update the page. [Init](installing.md) installs the **wiki-keeper** skill in `.claude/skills/wiki-keeper/SKILL.md`. Claude Code picks it up by itself; Codex, Cursor and other agents can be pointed at that file from their own instructions (AGENTS.md, `.cursor/rules`).

## What it tells the agent

- **Before a pull request**: find the pages whose `code:` paths cover the changed files and update them in plain English: what the part does, what it uses, how it breaks. A new part of the code gets a new page, linked from its hub. When a change truly does not affect a page, say so in the pull request with `wiki: no change needed - <reason>`, which the [drift check](writing-pages.md#keeping-pages-in-step-with-the-code) accepts.
- **Never invent facts**: write `TODO(owner): <question>` instead of guessing.
- **When starting a task**: label the GitHub issue `wiki:<slug>` and assign itself, so [the team view](team-view.md) shows the work.
- **Questions**: answer "Ask the team" questions as comments on their issues.
- **Commits**: one short sentence that says what changed, because the wiki shows them next to each person's branch.
- **Privacy**: never put real records, user names, emails or keys on a page. See [the privacy guard](privacy-guard.md).
- **Finish**: run `hypatia check` until it passes.

This repo has the skill installed too, so this wiki is kept by the same rules.
