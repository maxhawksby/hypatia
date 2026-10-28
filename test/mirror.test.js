// Tests for `hypatia mirror` (lib/mirror.js): the wiki written as GitHub
// Wiki pages, links rewritten, private pages and personal data kept out.
// `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { buildGraph } = require("../lib/build-graph");
const { mirrorCommand, nameMap, renderPage } = require("../lib/mirror");
const { makeRepo, write } = require("./helpers");

const REPO = "acme/notes-app";
const graph = (root) => buildGraph({ root, env: {}, warn: () => {}, publish: true });

async function render(root, id) {
  const g = await graph(root);
  return renderPage(g.nodes.find((n) => n.id === id), nameMap(g), REPO, "master");
}

async function run(root, argv) {
  const lines = [];
  const prev = process.cwd();
  process.chdir(root);
  try {
    const code = await mirrorCommand(root, argv, { log: (s) => lines.push(s), error: (s) => lines.push(s), env: {} });
    return { code, out: lines.join("\n") };
  } finally {
    process.chdir(prev);
  }
}

test("mirror: front matter dropped, wiki links to page names, repo links to GitHub, code blocks untouched", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const out = await render(repo.root, "object-detection");
    assert.doesNotMatch(out, /title:/);
    assert.match(out, /\[Senses\]\(Senses#programs\)/);
    assert.match(out, /\[code\]\(https:\/\/github\.com\/acme\/notes-app\/blob\/master\/src\/object_detection\/detector\.py\)/);
    assert.match(out, /\[not a link\]\(missing\.md\)/);
    assert.match(out, /Edit this page in the repo: <https:\/\/github\.com\/acme\/notes-app\/blob\/master\/docs\/wiki\/object-detection\.md>/);
    const hub = await render(repo.root, "senses");
    assert.match(hub, /\[Object detection\]\(Object-detection\)/);
    assert.match(hub, /\(Home\)/, "README.md is Home");
    assert.match(await render(repo.root, "keyboard-teleop"), /!\[diagram\]\(https:\/\/github\.com\/acme\/notes-app\/raw\/master\/docs\/img\/teleop\.png\)/);
  } finally {
    repo.cleanup();
  }
});

test("mirror: outside links, anchors and inline code are left alone; clashing titles use file names", async () => {
  const repo = makeRepo({ generic: true });
  try {
    write(repo.root, "docs/wiki/movement.md", "---\ntitle: Movement\nparent: home\n---\n[Docs](https://example.com) `[x](senses.md)` [top](#top) [Teleop](keyboard-teleop.md)\n");
    write(repo.root, "docs/wiki/movement-2.md", "---\ntitle: Movement\nparent: home\n---\nMore.\n");
    const out = await render(repo.root, "movement");
    assert.match(out, /\[Docs\]\(https:\/\/example\.com\) `\[x\]\(senses\.md\)` \[top\]\(#top\)/);
    const names = nameMap(await graph(repo.root));
    assert.deepStrictEqual([names.get("docs/wiki/movement.md"), names.get("docs/wiki/movement-2.md")], ["movement", "movement-2"]);
  } finally {
    repo.cleanup();
  }
});

test("mirror: writes every published page, removes stale ones, never a private page", async () => {
  const repo = makeRepo({ generic: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-mirror-"));
  try {
    fs.writeFileSync(path.join(out, "Old-page.md"), "stale");
    fs.writeFileSync(path.join(out, "keep.txt"), "not a page");
    write(repo.root, "docs/wiki/notes.md", "---\ntitle: Secret notes\nparent: senses\nprivate: true\n---\nShh.\n");
    const r = await run(repo.root, ["--out", out]);
    assert.strictEqual(r.code, 0, r.out);
    assert.deepStrictEqual(fs.readdirSync(out).sort(), ["Home.md", "Keyboard-teleop.md", "Movement.md", "Object-detection.md", "Senses.md", "keep.txt"]);
    assert.match(r.out, /Wrote 5 wiki pages/);
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("mirror: writes nothing when a page holds personal data, and needs --out", async () => {
  const repo = makeRepo({ generic: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-mirror-"));
  try {
    write(repo.root, "docs/wiki/senses.md", "---\ntitle: Senses\nparent: home\n---\nAsk jane.doe@gmail.com.\n");
    const r = await run(repo.root, ["--out", out]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /Nothing was written/);
    assert.deepStrictEqual(fs.readdirSync(out), []);
    assert.strictEqual((await run(repo.root, [])).code, 2);
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});
