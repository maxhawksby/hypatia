---
title: The privacy guard
parent: how-it-works
code: [lib/privacy.js]
---

# The privacy guard

A public wiki is only safe if it never publishes personal data or keys by accident. The privacy guard checks for that before anything goes out.

## What it looks for

`hypatia check` and `hypatia build` scan the pages and the site data (commit messages, branch names, issue titles) for:

- email addresses and phone numbers;
- student and other ID numbers;
- keys: AWS, GitHub, Stripe, Supabase, JSON web tokens, OpenAI, Anthropic, Slack, Google, private key blocks, and connection strings with a password.

Each finding names the page and line with the value masked, and the build stops without writing anything. `hypatia serve` shows a note in the corner instead and keeps running, so you can fix it while you write.

## What it lets through

- the team's own GitHub noreply addresses;
- example.com, example.org, example.net, example.edu and other reserved test domains;
- stand-ins like `firstname.lastname@`;
- anything under `allow:` in [the configuration](configuration.md);
- a person's `discord_id` from the configuration: a long number they chose to publish so the Discord ping can @mention them. Only 17 to 20 digit ids get that far, and the same number anywhere else is still checked.

## Private pages

A page with `private: true` in its front matter, and every page under it, shows on the local site but is left out of the published build, with its links, backlinks, search entry and team data. A link to it from a published page becomes plain text. README.md is the home page and is always published.

The [agent skill](agent-skill.md) adds a firm rule on top: pages describe how the code works, never real records, user names, emails or keys.

## The update check

The one-line "newer Hypatia is out" notice comes from a plain request to the npm registry for Hypatia's latest version number. It sends no repo data, page text or names, and its answer is kept on your computer for a day. `HYPATIA_NO_UPDATE_CHECK=1` turns it off.
