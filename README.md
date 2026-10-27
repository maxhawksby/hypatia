# Hypatia

Hypatia adds a linked team wiki and a who's-working-on-what view to any repo. Work in progress.

Status: milestone 3 - one command sets it up in a repo, and a privacy guard keeps personal data and keys off the website. Not on npm yet.

From inside any git repo (Node 18+, nothing else):

```shell
node ~/personal/hypatia/bin/hypatia.js init --dry-run   # print the plan, change nothing
node ~/personal/hypatia/bin/hypatia.js init             # set it up (asks before anything public)
node ~/personal/hypatia/bin/hypatia.js serve     # http://localhost:4410/, reloads when a page changes
node ~/personal/hypatia/bin/hypatia.js build     # writes the site and its data to _site/
node ~/personal/hypatia/bin/hypatia.js check     # checks the pages and the privacy guard, writes nothing
```

## Setting it up: `hypatia init`

Every repo gets `docs/wiki/start-here.md` (when it has no wiki pages yet), the wiki-keeper agent skill in `.claude/skills/wiki-keeper/`, and a `wiki` npm script (when there is a package.json) or the one-line command that opens the wiki locally.

A public repo (GitHub says so, or `--public`) also gets, only after a yes at the prompt or `--yes`:

- `.github/workflows/wiki-site.yml` and `wiki-refresh.yml`, which build the site and publish it with GitHub Pages;
- GitHub Pages turned on with Source: GitHub Actions, if it is off (`POST repos/<repo>/pages`);
- the repo's About website set to the Pages address, if it is empty (`PATCH repos/<repo>`, `homepage`).

A website already in the About box, or Pages already publishing from a branch, is left alone. A private repo gets no website. Init never overwrites a file and is safe to run again; it says what it left alone.

Everything init writes is committed and shared, so it names Hypatia the way a teammate would run it: `npx hypatia serve` and `npx hypatia check` in the pages, the skill and the `wiki` script, and `npx hypatia@<this version>` in the Pages workflow, so the website keeps building with the version it was set up with. `--runner "<command>"` names another command for all of them. Until Hypatia is on npm those commands do not work yet; run it with `node <path to hypatia>/bin/hypatia.js` meanwhile.

## Privacy guard

`hypatia check` and `hypatia build` scan the pages and the site data (commit messages, branch names, issue titles) for email addresses, phone numbers, student and other ID numbers, and keys (AWS, GitHub, Stripe, Supabase, JSON web tokens, OpenAI, Anthropic, Slack, Google, private key blocks, connection strings with a password). Each finding names the page and line with the value masked, and the build stops without writing anything. `hypatia serve` shows a note in the corner instead and keeps running.

Never reported: the team's own GitHub noreply addresses, example.com/.org/.net/.edu and other reserved test domains, stand-ins like `firstname.lastname@`, and anything under `allow:` in docs/hypatia.yml (an exact value, a domain like `@acme.dev`, or a pattern like `"sk_test_*"`).

A page with `private: true` in its front matter, and every page under it, shows on the local site but is left out of the published build, with its links, backlinks, search entry and team data. A link to it from a published page becomes plain text.

GitHub data (who is working on what, logins, collaborators) is read when `gh` is signed in or `GITHUB_TOKEN` is set. Without it, or without permission, the team comes from git history alone.

## Pages

Each page is `docs/wiki/<slug>.md` with front matter. README.md is the center page; hub pages use `parent: home`.

```
---
title: Search
parent: web-app
code: [web/src/search/**]   # optional: the code this page is about
private: true               # optional: on the local site only, never on the website
---
```

### What `hypatia check` checks

Besides the front matter, parents and links, `check` fails when a page's `code:` path or glob matches no file in the repo (tracked or new): the page would point at nothing. It warns, without failing, when a hub page (`parent: home`) is not reachable by links from README.md, and it counts the `TODO(` markers left in the pages.

### Links

A wiki page's links, and any link into `docs/wiki/`, must point at a file that exists: `hypatia check` and `hypatia build` fail until they do. README.md belongs to the project rather than the wiki, so its links to other repo files that do not exist are only a warning. While you write, `hypatia serve` keeps the site updating through a broken link: the link shows struck out, and a note lists it.

## The team

Nobody has to write a team file. Everyone who committed is on the team (bots left out), joined across their emails and GitHub login, plus the repo's GitHub collaborators when the token may list them. Each person gets a color from a fixed palette, picked from their id, so it stays the same every build.

To change any of that, add `docs/hypatia.yml` (all keys optional):

```yaml
title: Larkspur              # the site's name; default: README.md's first heading, else the repo name
allow: [help@larkspur.dev]   # values the privacy guard may publish
only_listed: false           # true: the people below are the whole team
exclude: [old-intern, Some Bot]   # logins, ids or names to leave out
people:
  - github: ana-gh           # matched to a git author by login, id or name
    id: ana                  # used in links (#people/ana)
    name: Ana
    color: "#ff4d5e"
    focus: Search that understands ingredients
    past: [search]           # pages they worked on that git may not show
```

An older `docs/team.yml` (a `people:` list in the same shape) still works: it is read when there is no `docs/hypatia.yml`, and it lists the whole team, as if it said `only_listed: true`.
