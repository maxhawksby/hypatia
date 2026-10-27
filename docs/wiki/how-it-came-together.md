---
title: How it came together
parent: home
---

# How it came together

## A robot dog and five people

Hypatia started as the wiki for a university robotics team: five students building software for a robot dog named Oak, in a repo called go2-fusion. The code had many parts, and it was hard to see who was working on which one. So the team wiki got a page for each part, a map of how the parts connect, and a live view of who was on what, built from branches, issues and pull requests.

## It grew into a vault

Over time it came to feel like an Obsidian vault with a team view on top: linked pages, backlinks, search, a quick switcher, and a graph you can explore. A coding agent kept the pages current as the code changed. At that point it was clearly useful beyond one robot.

## Extracted and made generic

The wiki was pulled out of go2-fusion in steps. First it moved into its own repo and was ported to Node, looking the same as before. Then everything specific to that one project was taken out: the title, the team and the colors now come from any repo's git history and GitHub. Then came `hypatia init`, which sets it all up with one command, and [the privacy guard](privacy-guard.md), which keeps personal data and keys off public websites.

## Published as Hypatia

It went public on GitHub and npm as Hypatia, named after Hypatia of Alexandria, the mathematician and astronomer who taught in Alexandria around 400 AD. Teaching people how a thing works is the job of a good wiki too. [How it works](how-it-works.md) explains the result, and the [roadmap](roadmap.md) says what comes next.
