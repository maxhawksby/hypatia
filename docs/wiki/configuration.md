---
title: Configuration
parent: start-here
code: [docs/hypatia.yml, lib/team.js]
---

# Configuration

Hypatia needs no config. Nobody has to write a team file: the [team view](team-view.md) comes from git and GitHub. To change any of it, add `docs/hypatia.yml`. Every key is optional:

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

`allow:` takes an exact value, a domain like `@acme.dev`, or a pattern like `"sk_test_*"`. Only list values that are safe to publish, such as a public support address; see [the privacy guard](privacy-guard.md).

An older `docs/team.yml` (a `people:` list in the same shape) still works. It is read when there is no `docs/hypatia.yml`, and it lists the whole team, as if it said `only_listed: true`.

This repo's own `docs/hypatia.yml` sets the title and allows the made-up address in the example above.
