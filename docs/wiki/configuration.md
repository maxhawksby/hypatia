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
    discord_id: "123456789012345678"   # optional: lets the Discord ping @mention them
drift: true                  # pull requests must update the pages whose code they change
coverage: [src]              # every top-level folder in src/ needs a page
```

`allow:` takes an exact value, a domain like `@acme.dev`, or a pattern like `"sk_test_*"`. Only list values that are safe to publish, such as a public support address; see [the privacy guard](privacy-guard.md).

`discord_id` is the numeric Discord user id (Discord: Settings > Advanced > Developer Mode, then right-click the name > Copy User ID). It goes on the website with the person, so only people who want pings should add theirs. Anything that is not a 17 to 20 digit number is left out with a warning.

`drift:` and `coverage:` are off until you turn them on; see [writing pages](writing-pages.md#keeping-pages-in-step-with-the-code).

An older `docs/team.yml` (a `people:` list in the same shape) still works. It is read when there is no `docs/hypatia.yml`, and it lists the whole team, as if it said `only_listed: true`.

Setting `HYPATIA_NO_UPDATE_CHECK=1` in the environment stops Hypatia asking npm whether a newer version is out (it is already off when `CI` is set). See [how it works](how-it-works.md#the-commands).

This repo's own `docs/hypatia.yml` sets the title, allows the made-up address in the example above and Max's public address, lists Max with his focus, and turns on `drift: true`, so every pull request here keeps its pages in step. It sets no `coverage:`: that check looks only at folders inside the folders it names, and Hypatia's code sits in flat folders (`lib/` holds files, not subfolders), so it would have nothing to check.
