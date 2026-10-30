---
title: Writing pages
parent: start-here
code: [lib/lint.js, lib/drift.js, lib/globs.js]
verified: a9229f27f0a4
---

# Writing pages

Each page is `docs/wiki/<slug>.md`: lowercase words joined by `-`, starting with front matter. README.md is the center page of the map. Hub pages hang off it with `parent: home`; every other page names its hub.

```
---
title: Search
parent: web-app             # the hub it belongs under; a hub uses "home"
code: [web/src/search/**]   # optional: the code this page is about
verified: 1a2b3c4d5e6f      # written by hypatia verify, never by hand
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

A page with `code:` can carry a stamp, `verified: <12 characters>`: a fingerprint of every file its `code:` matches (paths and contents; files git ignores don't count, and Windows line endings give the same stamp). Run `hypatia verify <page.md>` after rereading the page against that code, and fixing it if needed; it writes the stamp and changes nothing else. `hypatia verify --all` stamps every page with `code:`. The stamp means "someone checked this page against this exact code".

When the code changes, the stamp stops matching and the page is **stale**. A page with `code:` and no stamp is **unverified**, which counts as stale. Two checks in [the config](configuration.md) use this:

- `drift: warn` (what new installs get) lists stale pages and still passes; `drift: error` fails the check until each one is reread and verified; `drift: off`, or no `drift:` line, skips it. `true` means error and `false` means off. `hypatia check --warn` lists them without failing for one run, `--no-drift` skips them, and `--base <ref>` turns the check on as error when the config leaves it off.
- With a base to compare against, each stale page also lists the files that changed and roughly where. In GitHub Actions that is the branch the pull request goes into; on your computer, origin's default branch, uncommitted work included; `--base <ref>` names any branch or commit. Without one, the stale page is still listed, just without the details.
- A pull request can skip one page, only with a reason, by adding this line to its description (several pages can share a line, comma separated):

  ```
  wiki: no change needed for docs/wiki/<page>.md - <reason>
  ```

  The check reads the description from `HYPATIA_PR_BODY` (the [wiki-check workflow](workflows.md) sets it). The older line without a page name still skips every page, with a warning that it is going away. Rereading and verifying is the better answer: the next pull request won't flag the page again.
- `coverage: [src]`: every top-level folder inside `src/` must be claimed by some page's `code:`, so a new folder of code always gets a page.

Private pages count for both: their code can drift too. To make a failing check block merging, run `hypatia protect`; to see the check before each push on your own computer, run `hypatia hooks install` (see [workflows](workflows.md)).

`hypatia check` and `hypatia build` fail until a broken link is fixed. While you write, `hypatia serve` keeps the site updating through it: the link shows struck out, and a note lists it. See [the website](the-website.md#on-your-computer).
