// Tests for the extra checks `hypatia check` makes (lib/lint.js): code paths
// that match nothing, hubs README.md does not lead to, TODO( markers. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { lint } = require("../lib/lint");
const { buildGraph } = require("../lib/build-graph");
const { makeRepo, write } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const check = (root) => spawnSync(process.execPath, [CLI, "check"], { cwd: root, encoding: "utf8" });
const graph = (root) => buildGraph({ root, env: {}, warn: () => {}, publish: true });

test("the fixture wiki has nothing to report", async () => {
  const repo = makeRepo({ generic: true });
  try {
    const found = lint(repo.root, await graph(repo.root));
    assert.deepStrictEqual([found.errors, found.warnings, found.todos.count], [[], [], 0]);
  } finally {
    repo.cleanup();
  }
});

test("a code: path or glob that matches no file fails the check; a new, untracked file counts", async () => {
  const repo = makeRepo({ generic: true });
  try {
    write(repo.root, "docs/wiki/search.md", "---\ntitle: Search\nparent: senses\ncode: [src/search/**, src/search.py]\n---\nSearch.\n");
    let found = lint(repo.root, await graph(repo.root));
    assert.deepStrictEqual(found.errors.map((e) => e.split(" matches")[0]), [
      "docs/wiki/search.md: code: 'src/search/**'",
      "docs/wiki/search.md: code: 'src/search.py'",
    ]);
    const r = check(repo.root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /code: 'src\/search\/\*\*' matches no file in the repo/);
    assert.doesNotMatch(r.stdout, /check passed/);

    write(repo.root, "src/search/index.py", "pass\n"); // not committed yet
    write(repo.root, "src/search.py", "pass\n");
    found = lint(repo.root, await graph(repo.root));
    assert.deepStrictEqual(found.errors, []);
    assert.strictEqual(check(repo.root).status, 0);
  } finally {
    repo.cleanup();
  }
});

test("a hub README.md does not lead to is a warning, not a failure; a chain of links is enough", async () => {
  const repo = makeRepo({ generic: true });
  try {
    write(repo.root, "docs/wiki/tools.md", "---\ntitle: Tools\nparent: home\n---\nTools.\n");
    const r = check(repo.root);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /warning: docs\/wiki\/tools\.md is a hub page \(parent: home\), but no link leads to it from README\.md/);
    assert.match(r.stdout, /Wiki check passed/);

    // README.md -> senses -> tools
    const senses = fs.readFileSync(path.join(repo.root, "docs/wiki/senses.md"), "utf8");
    write(repo.root, "docs/wiki/senses.md", senses + "\nSee also [Tools](tools.md).\n");
    assert.deepStrictEqual(lint(repo.root, await graph(repo.root)).warnings, []);

    // no README at all: nothing to link from, so nothing to warn about
    fs.rmSync(path.join(repo.root, "README.md"));
    write(repo.root, "docs/wiki/senses.md", senses);
    assert.deepStrictEqual(lint(repo.root, await graph(repo.root)).warnings, []);
  } finally {
    repo.cleanup();
  }
});

test("TODO( markers are counted as information, never a failure", () => {
  const repo = makeRepo({ generic: true });
  try {
    const movement = fs.readFileSync(path.join(repo.root, "docs/wiki/movement.md"), "utf8");
    write(repo.root, "docs/wiki/movement.md", movement + "\nTODO(ana): stairs. TODO(ben): turns.\n");
    write(repo.root, "README.md", fs.readFileSync(path.join(repo.root, "README.md"), "utf8") + "\nTODO(ben): a logo. A plain TODO is not counted.\n");
    const r = check(repo.root);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /3 TODO\( markers left in 2 pages: README\.md, docs\/wiki\/movement\.md\./);
  } finally {
    repo.cleanup();
  }
});

test("a TODO( inside inline code or a fenced code block is an example, not a marker", () => {
  const repo = makeRepo({ generic: true });
  try {
    const movement = fs.readFileSync(path.join(repo.root, "docs/wiki/movement.md"), "utf8");
    write(
      repo.root,
      "docs/wiki/movement.md",
      movement +
        "\nWrite `TODO(owner): <question>` instead of guessing, or ``a `TODO(x)` in a longer span``.\n" +
        "\n- In a list:\n\n  ```\n  TODO(ana): an example\n  ```\n" +
        "\n~~~~\nTODO(ben): still code\n~~~\nTODO(ben): a shorter fence does not close it\n~~~~\n" +
        "\nTODO(cy): this one is real, and so is this TODO(dee).\n",
    );
    const r = check(repo.root);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /2 TODO\( markers left in 1 page: docs\/wiki\/movement\.md\./);
  } finally {
    repo.cleanup();
  }
});

test("check in a repo without Hypatia says so and gives the install prompt", () => {
  const repo = makeRepo({ generic: true });
  try {
    fs.rmSync(path.join(repo.root, "docs", "wiki"), { recursive: true, force: true });
    fs.rmSync(path.join(repo.root, ".claude"), { recursive: true, force: true });
    const r = check(repo.root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /Hypatia isn't set up in this repo yet/);
    assert.match(r.stderr, /Install Hypatia in this repo by following https:\/\/raw\.githubusercontent\.com\/maxhawksby\/hypatia\/main\/INSTALL-AGENT\.md/);
    assert.match(r.stderr, /npx hypatia init/);
  } finally {
    repo.cleanup();
  }
});
