// Parity: the Node builder gives the same graph.json as go2-fusion's Python
// builder (kept unchanged in test/reference/) for the same repo.
//
// Runs on the fixture repo always, and on a real wiki too: go2-fusion at
// ~/personal/go2-fusion, or the folder in HYPATIA_PARITY_REPO. Skipped
// without Python 3. Only generated_at (the build time) may differ. GitHub is
// left out (no token on either side), so work and questions are empty.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { buildGraph, repoSlug } = require("../lib/build-graph");
const { makeRepo } = require("./helpers");

const DUMP = path.join(__dirname, "reference", "dump.py");
const python = ["python3", "python"].find((cmd) => spawnSync(cmd, ["--version"]).status === 0);
const realRepo = process.env.HYPATIA_PARITY_REPO || path.join(os.homedir(), "personal", "go2-fusion");

// The environment both builders see: no GitHub, and the same repo slug.
function env(root) {
  const e = { ...process.env, GITHUB_REPOSITORY: repoSlug(root) || "none/none", PYTHONIOENCODING: "utf-8" };
  for (const k of ["GITHUB_TOKEN", "WIKI_BRANCH", "GITHUB_REF_NAME"]) delete e[k];
  return e;
}

function pythonGraph(root) {
  const r = spawnSync(python, ["-B", DUMP, root], { env: env(root), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

async function nodeGraph(root) {
  return buildGraph({ root, env: env(root), repo: env(root).GITHUB_REPOSITORY, warn: () => {} });
}

// Node's graph, put through JSON like graph.json, against Python's.
async function assertSame(root) {
  const want = pythonGraph(root);
  const got = JSON.parse(JSON.stringify(await nodeGraph(root)));
  delete want.generated_at;
  delete got.generated_at;
  // key order too, so graph.json reads the same
  assert.deepStrictEqual(Object.keys(got), Object.keys(want));
  assert.deepStrictEqual(Object.keys(got.nodes[0]), Object.keys(want.nodes[0]));
  for (const key of Object.keys(want)) assert.deepStrictEqual(got[key], want[key], `"${key}" differs`);
  return got;
}

test("same graph as the Python builder on the fixture repo", { skip: !python && "no Python 3" }, async () => {
  const repo = makeRepo();
  try {
    const g = await assertSame(repo.root);
    // the fixture has something in every part, so the match means something
    assert.ok(g.people.length && g.recent.length && g.branches.length && g.edges.some((e) => e.kind === "link"));
    assert.ok(g.people.some((p) => p.contributed.length));
  } finally {
    repo.cleanup();
  }
});

const hasReal = fs.existsSync(path.join(realRepo, "docs", "wiki"));
test(`same graph as the Python builder on ${realRepo}`, { skip: (!python && "no Python 3") || (!hasReal && "no real wiki to compare") }, async () => {
  const g = await assertSame(realRepo);
  assert.ok(g.nodes.length > 10);
});
