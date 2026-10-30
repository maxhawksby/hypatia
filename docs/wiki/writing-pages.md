---
title: Writing pages
parent: start-here
code: [lib/lint.js, lib/drift.js, lib/globs.js]
---

# Writing pages

Each page is `docs/wiki/<slug>.md`: lowercase words joined by `-`, starting with front matter. README.md is the center page of the map. Hub pages hang off it with `parent: home`; every other page names its hub.

```
---
title: Search
parent: web-app             # the hub it belongs under; a hub uses "home"
code: [web/src/search/**]   # optional: the code this page is about
private: true               # optional: on the local site only, never on the website
---
```

A good page explains one part of the code in plain English: what it does for the project, what it uses, and how it breaks. Link pages that work together; the links become the lines on the map. Or let your coding agent write them with the [agent skill](agent-skill.md).

## What `hypatia check` checks

- Every page has a title and a parent that exists, and following parents from any page reaches README.md.
- Every link from a wiki page, and every link into `docs/wiki/`, points at a file that exists. README.md belongs to the project rather than the wiki, so its links to other repo files only warn.
- Every `code:` path or glob matches at least one file in the repo (tracked or new). Otherwise the page points at nothing, usually because the code moved. In a glob, `**` is any number of folders, `*` is anything inside one folder name, and `?` is one character. A plain folder path with no wildcard covers everything inside it, so `src/search` works like `src/search/**`.
- It warns, without failing, when a hub page is not reachable by links from README.md, and it counts the `TODO(` markers left in the pages. A marker inside code (an inline `code` span or a fenced block) is an example, so it is not counted.
- It runs the [privacy guard](privacy-guard.md).

## Keeping pages in step with the code

Two more checks, both off until [the config](configuration.md) turns them on:

- `drift: true`: on a pull request, if code a page's `code:` covers changed but the page did not, the check fails and names the page. When a change truly does not affect what any page says (a rename, a comment), add this line to the pull request description instead:

  ```
  wiki: no change needed - <reason>
  ```

  The reason is required, on the same line. A moved file counts at its old place and its new one, so moving code out of a folder flags that folder's page too. In GitHub Actions, `hypatia check` compares with the branch the pull request goes into, and reads the description from `HYPATIA_PR_BODY` (the [wiki-check workflow](installing.md) sets it). On your computer it compares with origin's default branch, uncommitted work included. `hypatia check --base <ref>` runs it against any branch or commit, config or not; `--no-drift` skips it.
- `coverage: [src]`: every top-level folder inside `src/` must be claimed by some page's `code:`, so a new folder of code always gets a page.

Private pages count for both: their code can drift too.

`hypatia check` and `hypatia build` fail until a broken link is fixed. While you write, `hypatia serve` keeps the site updating through it: the link shows struck out, and a note lists it. See [the website](the-website.md#on-your-computer).
