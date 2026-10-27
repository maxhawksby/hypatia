---
name: wiki-keeper
description: Keep the team wiki (README.md + docs/wiki/) true to the code. Use whenever code a wiki page documents changes, when a folder or program is added or removed, before opening a pull request, when starting a task (to claim it on the wiki graph), when someone asks to update or check the wiki, to answer wiki questions, or to ask a teammate for review.
---

# Wiki keeper

The wiki is a graph: README.md is the center page, hub pages hang off it, and each part of the code has one page under a hub. Pages live in `docs/wiki/<slug>.md`. The site (`node bin/hypatia.js serve`) shows the map, the pages, and who is working on what.

Every page starts with front matter:

```
---
title: Search
parent: web-app               # hub pages use "home"
code: [web/src/search/**]     # optional: the repo paths this page documents
---
```

## Privacy (a firm rule, always)

Pages describe how the code works, never real records, user names, emails or keys. That means no rows from a real database, no names or details of the app's users, no email addresses, phone numbers, student or customer IDs, passwords, tokens or API keys, not even as examples. Use made-up placeholders (`user@example.com`, `<api-key>`, "a student"). The team view shows only the repo's GitHub collaborators, never the app's users.

`node bin/hypatia.js check` runs a privacy guard: it names the page and line of anything that looks like personal data or a key, and the website build refuses to publish until it is gone. Never silence it by adding a real value to `allow:` in `docs/hypatia.yml`; that list is only for values that are safe to publish (a public support address). A page that must hold sensitive notes gets `private: true` in its front matter: it shows on the local site but never on the website.

## When starting a task

So the wiki graph shows who is working on what:

1. Find an open GitHub issue for the task, or open one: `gh issue list --search "<words>"`, `gh issue create`.
2. Label it `wiki:<slug>` for the page it touches (create the label if missing: `gh label create wiki:<slug>`), and assign yourself: `gh issue edit <n> --add-label wiki:<slug> --add-assignee @me`.

If `gh` is not signed in, tell the human the exact commands instead of skipping this.

## Committing

Write every commit message as one short sentence that says exactly what changed, starting with the part of the project it touches (`Search: rank exact names first`). Never `fix`, `wip` or `updates`. The wiki shows these messages next to each person's branch, so they are how teammates see what you're working on.

## Before opening a pull request (or whenever code changed)

1. `git fetch origin`, then list what changed: `git diff --name-only origin/main...HEAD` (plus uncommitted work: `git status --short`).
2. Find the pages whose `code:` paths cover those files, read the diff for that code (`git diff origin/main...HEAD -- <paths>`) and update each page in plain English a college freshman would follow:
   - what that part does for the project,
   - what it uses (other parts, services, data, hardware),
   - how it breaks (known failure modes and what they look like).
   Not code internals: no function names or line-by-line walkthroughs.
3. New part of the code: create `docs/wiki/<slug>.md` with title, parent (its hub) and `code:` paths, then link it from the hub page.
   Removed part: delete its page and its link from the hub.
4. Never invent facts. If you don't know something (a limit, an owner, a failure mode), write `TODO(owner): <question>` instead of guessing.
5. Keep pages short: a few short paragraphs or bullets. Link to other pages rather than repeating them.
6. Run `node bin/hypatia.js check` until it prints "Wiki check passed".

If a change truly does not affect what any page says (a rename, a comment, a refactor with identical behavior), add this line to the pull request description instead of editing the page:

```
wiki: no change needed - <reason>
```

## Answering questions

Teammates ask questions on wiki pages from the site ("Ask the team"); each one is a GitHub issue labelled `question` and `wiki:<slug>`.

1. When asked to answer questions, list the open ones for the pages you know: `gh issue list --label question` (narrow with `--label wiki:<slug>`), then `gh issue view <n>`.
2. Read the page and its code, then answer in plain English a newcomer can follow, as a comment on the issue: `gh issue comment <n> --body "..."`. Link the wiki page and the code on GitHub (`https://github.com/maxhawksby/hypatia/blob/main/<path>`).
3. If the answer belongs on the page (others will ask it too), update the page in the same pull request as any code change, or in a small wiki-only pull request.
4. Never guess. If you don't know, say what you checked and who might know (the page's owner), and leave the question open.

A comment from someone other than the asker marks the question answered on the site.

## Asking for review

Open the pull request (`gh pr create`), using the repo's pull request template if it has one. Either way, say in a line or two each, in plain English:

- **What**: what the change does, in one sentence.
- **Why**: why the project or the team needs it.
- **Before** and **After**: what happened before, what happens now.
- **How to test**: steps a teammate can follow.
- **Wiki**: the page you updated, or `wiki: no change needed - <reason>` on its own line.

Request a teammate: `gh pr create --reviewer <login>` or `gh pr edit <n> --add-reviewer <login>`. The People list on the site shows who is on the team and their GitHub logins (names, colors and focus lines can be set in `docs/hypatia.yml`). Label nothing extra: the site shows the review request.

## What `node bin/hypatia.js check` checks

- every page has a title and a parent that exists, and page names are lowercase words joined by '-';
- every link from a wiki page, and every link into docs/wiki/, works (README.md's links to other repo files only warn);
- every `code:` path or glob matches at least one file in the repo;
- following parents from any page reaches README.md (no orphans, no loops).
- warns when a hub page (parent: home) is not reachable by links from README.md, and counts `TODO(` markers.
