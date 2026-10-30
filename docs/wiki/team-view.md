---
title: The team view
parent: how-it-works
code: [lib/team.js, lib/github.js]
verified: 2cf1952b506b
---

# The team view

The team view answers "who is working on what?" without anyone filling in a status sheet.

## Who is on the team

Everyone who committed is on the team (bots left out), joined across their emails and GitHub login, plus the repo's GitHub collaborators when the token may list them. Each person gets a color from a fixed palette, picked from their id, so it stays the same every build. Names, colors, a "focus" line and a Discord id (for the optional Discord ping) can be set in [the configuration](configuration.md).

## What they are working on

- **Branches**: a remote branch with a commit in the last 14 days is matched to the pages whose code it changes.
- **Issues**: an issue labelled `wiki:<slug>` shows on that page, with whoever it is assigned to. The [agent skill](agent-skill.md) labels and assigns issues this way when it starts a task.
- **Pull requests**: an open pull request is matched to pages by the files it changes, and review requests show too.
- **Questions**: an issue labelled `question` and `wiki:<slug>` shows on that page until someone other than the asker answers it.

## Where the data comes from

GitHub data (logins, collaborators, issues, pull requests) is read when `gh` is signed in or `GITHUB_TOKEN` is set. On GitHub Pages the workflow's own token does this. Without a token, or without permission, the team comes from git history alone.

The team view only ever shows the repo's collaborators, never the users of the app the repo builds. See [the privacy guard](privacy-guard.md).
