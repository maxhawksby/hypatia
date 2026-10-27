# Hypatia - brief

## What & why

The go2-fusion team wiki turned into something bigger than one project: linked pages for each part of the code, a map of how they connect, and a live view of who is working on what. Today it only works for Oak, because names, the repo and the team list are written into it by hand. Hypatia packages that wiki so one command installs it into any repo, public or private. Each person views it on their own laptop, and GitHub (issues, pull requests, branches) is the shared record everyone sees. The goal is to run it on Max's own repos first, then open-source it.

## Scope (v1)

- **One-command install** into an existing repo: creates a `docs/wiki/` folder of pages (like go2-fusion's), a starter page, the site and the agent skill.
- **Public repos get a website**: install adds the GitHub Pages workflow and puts the wiki link in the repo's About box on GitHub, like go2-fusion's.
- **Private repos stay private**: no website. One command opens the wiki as a local site from inside the project.
- **Graph wiki site, nearly identical to go2-fusion's** in look and behavior: map view, linked pages, backlinks, Connections list, search with highlights, quick switcher, resizable panes, teammate colors, Ask box. All information stays connected the way it is today.
- **Team view**: who is working on which page, built from branches, issues and pull requests. The team list comes from GitHub collaborators, not a hand-written file (a file can still override names and colors).
- **Agent skill**: the wiki-keeper skill, made generic, so Claude keeps pages current and claims tasks on the graph.
- **Opens locally** with one command, live-reloading when a page changes, in public and private repos alike.
- **Privacy guard**: every site build scans the pages and the site data for emails, phone numbers, student-ID patterns and API keys, and stops before publishing if it finds any. A page marked `private: true` shows locally but never on the public website. The agent skill has a firm rule: pages describe how the code works, never real records, user names, emails or keys. The team view only ever shows the repo's GitHub collaborators, never the app's users.
- **Tasks stay in GitHub Issues.**
- **Node only** (no Python needed).

## Not in scope

- The pull request check that fails when code changes but its page doesn't (later version).
- Logging in with GitHub, or a hosted website for private repos.
- Mirroring to the GitHub Wiki tab.
- Discord pings.
- Task cards stored as files.
- Publishing the package to npm or making the repo public.
- Changing go2-fusion's own wiki.

## Milestones

1. **Extract and polish**: the go2-fusion wiki runs from Hypatia, looking the same as today, with every feature tested and its bugs fixed.
2. **Make it generic**: repo name, team and colors come from git and GitHub, nothing Oak-specific left.
3. **Install command and privacy guard**: one command sets Hypatia up in a fresh repo, and the privacy scan blocks a test page seeded with a fake email and key.
4. **Trials**: installed in agent-hq and editlab; Max reviews each.
5. **uconn-rec trial**: installed after Max approves the plan for it. uconn-rec is public and has student accounts, so its repo is audited for personal data and keys first.

## Acceptance criteria

- Max runs one command in agent-hq, editlab and uconn-rec, and each gets a `docs/wiki/` folder.
- uconn-rec (public) shows the wiki link in its GitHub About box; agent-hq and editlab (private) have no public site and open locally with one command.
- Max opens each wiki locally and sees the map, the pages and their links, and the team view.
- Side by side with the go2-fusion wiki, Hypatia looks and behaves nearly the same.
- In each repo, the team view shows the right people and what they are working on.
- Max adds a fake email to a page, and the public site build refuses to publish it; a page marked private never appears on the website.
- Max asks Claude to update a page in a trial repo, and the change shows up on the open site without a refresh.

## Open questions

- What the starter pages should be for a repo that has no wiki yet (one per top folder, or just a home page).
- When to bring back the drift check and GitHub login.
- Decided 2026-10-27: Hypatia goes public on GitHub after milestone 4, right before the uconn-rec trial; npm comes later (name `hypatia` free today).
- Decided 2026-10-27: uconn-rec's README emails (Max's and a demo student's) go on that repo's `allow:` list rather than being removed.
