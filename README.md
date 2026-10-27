# Hypatia

Hypatia adds a linked team wiki and a who's-working-on-what view to any repo. Work in progress.

Status: milestone 2 - works for any repo: the title, the team and their colors come from git and GitHub. Not installable yet.

From inside a repo that has docs/wiki/ (Node 18+, nothing else):

```shell
node ~/personal/hypatia/bin/hypatia.js serve     # http://localhost:4410/, reloads when a page changes
node ~/personal/hypatia/bin/hypatia.js build     # writes the site and its data to _site/
node ~/personal/hypatia/bin/hypatia.js check     # checks the pages, writes nothing
```

GitHub data (who is working on what, logins, collaborators) is read when `gh` is signed in or `GITHUB_TOKEN` is set. Without it, or without permission, the team comes from git history alone.

## Pages

Each page is `docs/wiki/<slug>.md` with front matter. README.md is the center page; hub pages use `parent: home`.

```
---
title: Search
parent: web-app
code: [web/src/search/**]   # optional: the code this page is about
---
```

## The team

Nobody has to write a team file. Everyone who committed is on the team (bots left out), joined across their emails and GitHub login, plus the repo's GitHub collaborators when the token may list them. Each person gets a color from a fixed palette, picked from their id, so it stays the same every build.

To change any of that, add `docs/hypatia.yml` (all keys optional):

```yaml
title: Larkspur              # the site's name; default: README.md's first heading, else the repo name
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
