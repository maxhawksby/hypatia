# Hypatia

Hypatia adds a linked team wiki and a who's-working-on-what view to any repo. Work in progress.

Status: milestone 1 - the go2-fusion wiki runs from here. Not installable yet.

From inside a repo that has README.md and docs/wiki/ (Node 18+, nothing else):

```shell
node ~/personal/hypatia/bin/hypatia.js serve     # http://localhost:4410/, reloads when a page changes
node ~/personal/hypatia/bin/hypatia.js build     # writes the site and its data to _site/
```

GitHub data (who is working on what) is read when `gh` is signed in or `GITHUB_TOKEN` is set.
