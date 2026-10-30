<h1 align="center">Hypatia</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/hypatia"><img alt="npm version" src="https://img.shields.io/npm/v/hypatia?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/hypatia"><img alt="npm downloads" src="https://img.shields.io/npm/dm/hypatia?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/maxhawksby/hypatia?style=flat-square"></a>
  <a href="https://github.com/maxhawksby/hypatia/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/maxhawksby/hypatia?style=flat-square"></a>
</p>

<h3 align="center">A living team wiki for any git repo, kept current by your coding agent.</h3>

<p align="center"><img alt="A Hypatia wiki: pages on the left, a page in the middle, the map of how the code connects on the right" src="assets/banner.png"></p>

Hypatia turns your repo's Markdown into a team wiki.
One page per part of the code, a map of how the parts connect, and who is working on what.
Your coding agent keeps the pages true to the code. Node 18+, no dependencies.

## Why I built it

I'm Max, a senior at UConn who has loved building since Legos: scattered pieces, slowly turned into something whole. On my senior design team, AI let us build really fast, but we stopped understanding our own repo. Hypatia is how I put the pieces back together, and it changed how our team worked, so I open-sourced it. **[Read the full story](https://maxhawksby.github.io/hypatia/#about-max)**

## Quick start

Hypatia is built to be set up by your coding agent (Claude Code, Codex, Cursor). Paste this into it:

```
Install Hypatia in this repo by following https://raw.githubusercontent.com/maxhawksby/hypatia/main/INSTALL-AGENT.md
```

It installs Hypatia, reads your code, writes the first wiki pages and checks them. Then open the wiki:

```shell
npx hypatia serve    # http://localhost:4410/
```

By hand instead: `npx hypatia init`, then ask your agent to write the pages with the wiki-keeper skill.

## Keeping it current

```shell
npx hypatia check      # are the pages in step with the code? (also says if Hypatia isn't installed)
npx hypatia verify docs/wiki/<page>.md   # mark a page as reread against today's code
npx hypatia upgrade    # bring an older install up to the latest version
```

Your agent runs `check` before each commit, rereads every page it lists, fixes what changed, and runs `verify`. When the check says the setup is old, the agent runs `upgrade` with your okay.

## What you get

- **Map**: every page is a node, linked the way the code is, like an Obsidian graph.
- **Team view**: who is working on which part, from branches, issues and pull requests. No status sheet.
- **Agent skill**: Claude Code, Codex or Cursor updates the pages when the code changes.
- **Drift check**: each page is stamped with the code it was checked against. When that code changes, the check lists the page until it is reread; set `drift: error` to fail the pull request.
- **Website**: public repos publish to GitHub Pages; private repos open locally with one command.
- **Privacy guard**: emails, phone numbers and keys never reach the website.

## Docs

**[Read the wiki](https://maxhawksby.github.io/hypatia/)** - docs, how it works, and how it came together. It is Hypatia's own wiki, built by Hypatia. In the repo: [start here](docs/wiki/start-here.md), [how it works](docs/wiki/how-it-works.md), [how it came together](docs/wiki/how-it-came-together.md).

If Hypatia helps your team, star the repo. Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
