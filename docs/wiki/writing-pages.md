---
title: Writing pages
parent: start-here
code: [lib/lint.js]
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
- Every `code:` path or glob matches at least one file in the repo (tracked or new). Otherwise the page points at nothing, usually because the code moved.
- It warns, without failing, when a hub page is not reachable by links from README.md, and it counts the `TODO(` markers left in the pages.
- It runs the [privacy guard](privacy-guard.md).

`hypatia check` and `hypatia build` fail until a broken link is fixed. While you write, `hypatia serve` keeps the site updating through it: the link shows struck out, and a note lists it. See [how it works](how-it-works.md).
