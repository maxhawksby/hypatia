---
title: Start here
parent: home
---

# Start here

This is the first page of the Hypatia wiki. Each page explains one part of the code in plain English: what it does for the project, what it uses, and how it breaks. The map shows how the parts connect and who is working on each one.

## Open the wiki

From the repo, run `npm run wiki`. It opens the wiki in your browser and reloads it whenever a page changes.

## Add a page

1. Make `docs/wiki/<name>.md` (lowercase words joined by '-') that starts like this:

   ```
   ---
   title: Search
   parent: start-here        # the hub it belongs under; a new hub uses "home"
   code: [src/search/**]     # optional: the code this page is about
   ---
   ```

2. Link to it from its hub page, and link pages that work together.
3. Run `node bin/hypatia.js check` until it says the check passed.

Or ask Claude to write the pages: the wiki-keeper skill in this repo tells it how.

## Privacy

Pages describe how the code works, never real records, user names, emails or keys. Use made-up values such as `user@example.com`. The check stops the website build if a page looks like it holds personal data or a key. A page with `private: true` in its front matter shows only on your own computer, never on the website.
