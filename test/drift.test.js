// Tests for the drift and coverage checks in `hypatia check` (lib/drift.js):
// a pull request that changes a page's code must change the page, unless its
// description says why not, and every folder in a coverage root needs a
// page. Each test plants one case in a throwaway repo. `npm test`.
"use strict";

const assert = require("assert");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const drift = require("../lib/drift");
const { makeRepo, write, commit, git, BEN } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");

// hypatia check in root; env adds to (and blanks) the CI variables.
function check(root, args = [], env = {}) {
  const e = { ...process.env, HYPATIA_PR_BODY: "", PR_BODY: "", GITHUB_BASE_REF: "", ...env };
  delete e.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [CLI, "check", ...args], { cwd: root, env: e, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

// A generic fixture repo on a feature branch off master.
function branchRepo() {
  const repo = makeRepo({ generic: true });
  git(repo.root, ["switch", "-q", "-c", "feature"]);
  return repo;
}

const DETECTOR = "src/object_detection/detector.py";
const PAGE = "docs/wiki/object-detection.md";
const read = (root, rel) => require("fs").readFileSync(path.join(root, rel), "utf8");

test("drift: changing a page's code without the page fails, and says how to fix it", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    commit(repo.root, BEN, "Object detection: faster");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /You changed src\/object_detection\/detector\.py, but its wiki page docs\/wiki\/object-detection\.md did not change\./);
    assert.match(r.out, /wiki: no change needed - <reason>/);
  } finally {
    repo.cleanup();
  }
});

test("drift: an uncommitted change is caught too", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "src/keyboard_teleop/teleop.py", "print('new keys')\n");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /docs\/wiki\/keyboard-teleop\.md did not change/);
  } finally {
    repo.cleanup();
  }
});

test("drift: changing the page with its code passes", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    write(repo.root, PAGE, read(repo.root, PAGE) + "\nNow faster.\n");
    commit(repo.root, BEN, "Object detection: faster");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Pages kept up with the code changed since master\./);
  } finally {
    repo.cleanup();
  }
});

test("drift: the escape line in the description passes, but only with a reason", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    commit(repo.root, BEN, "Object detection: rename a variable");
    const ok = check(repo.root, ["--base", "master"], { HYPATIA_PR_BODY: "Renames.\n\nwiki: no change needed - only a variable rename\n" });
    assert.strictEqual(ok.code, 0, ok.out);
    assert.strictEqual(check(repo.root, ["--base", "master"], { PR_BODY: "wiki: No change needed - same behavior" }).code, 0, "PR_BODY works too, any case");
    assert.strictEqual(check(repo.root, ["--base", "master"], { HYPATIA_PR_BODY: "wiki: no change needed -" }).code, 1);
  } finally {
    repo.cleanup();
  }
});

test("drift: a change no page covers passes; a bad base fails clearly", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "notes.txt", "hello\n");
    commit(repo.root, BEN, "Notes");
    assert.strictEqual(check(repo.root, ["--base", "master"]).code, 0);
    const r = check(repo.root, ["--base", "origin/nope"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /could not compare this branch with 'origin\/nope'/);
  } finally {
    repo.cleanup();
  }
});

test("drift is off by default; drift: true turns it on against the pull request's base, --no-drift skips it", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    commit(repo.root, BEN, "Object detection: faster");
    assert.strictEqual(check(repo.root).code, 0, "no config: no drift check");
    write(repo.root, "docs/hypatia.yml", "drift: true\n");
    commit(repo.root, BEN, "Turn on the drift check");
    // as in GitHub Actions on a pull request into master
    const r = check(repo.root, [], { GITHUB_BASE_REF: "master" });
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/object-detection\.md did not change/);
    // locally: origin's default branch
    assert.strictEqual(check(repo.root).code, 1);
    assert.strictEqual(check(repo.root, ["--no-drift"]).code, 0);
  } finally {
    repo.cleanup();
  }
});

test("drift: a private page's code counts too", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "docs/wiki/secret-sauce.md", "---\ntitle: Secret sauce\nparent: senses\nprivate: true\ncode: [src/sauce/**]\n---\nNotes.\n");
    write(repo.root, "src/sauce/a.py", "pass\n");
    commit(repo.root, BEN, "Sauce");
    git(repo.root, ["switch", "-q", "-c", "more"]);
    write(repo.root, "src/sauce/a.py", "pass  # changed\n");
    const r = check(repo.root, ["--base", "feature"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/secret-sauce\.md did not change/);
  } finally {
    repo.cleanup();
  }
});

test("coverage: a new folder without a page fails; with a page it passes; off without the config", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "src/speech/speak.py", "print('hi')\n");
    assert.strictEqual(check(repo.root).code, 0, "no coverage: in the config");
    write(repo.root, "docs/hypatia.yml", "coverage: src\n");
    const r = check(repo.root);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /src\/speech has no wiki page\. Create docs\/wiki\/<name>\.md for it with 'code: \[src\/speech\/\*\*\]'/);
    write(repo.root, "docs/wiki/speech.md", "---\ntitle: Speech\nparent: senses\ncode: [src/speech/speak.py]\n---\nTalks.\n");
    assert.strictEqual(check(repo.root).code, 0);
  } finally {
    repo.cleanup();
  }
});

test("coverage: helpers ignore files at the top, dot folders and ignored files, and flag a missing root", () => {
  const pages = [{ path: "docs/wiki/a.md", code: ["pkgs/a/**"] }];
  const files = ["pkgs/README.md", "pkgs/a/x.js", "pkgs/b/y.js", "pkgs/.cache/z", "other/c.js"];
  assert.deepStrictEqual(drift.coverageProblems(pages, ["pkgs/"], files).map((m) => m.split(" ")[0]), ["pkgs/b"]);
  assert.match(drift.coverageProblems(pages, ["nope"], files)[0], /coverage: 'nope' has no files in the repo/);
  assert.deepStrictEqual(drift.driftProblems(pages, ["pkgs/a/x.js", "docs/wiki/a.md"]), []);
  assert.strictEqual(drift.driftProblems(pages, ["pkgs/a/1", "pkgs/a/2", "pkgs/a/3", "pkgs/a/4"])[0].includes("and 1 more"), true);
});

test("drift: moving a file between two covered folders flags both pages, even with files left behind", () => {
  const repo = branchRepo();
  try {
    // src/object_detection/README.md stays, so the old folder is not empty
    git(repo.root, ["mv", DETECTOR, "src/keyboard_teleop/detector.py"]);
    write(repo.root, "docs/wiki/keyboard-teleop.md", read(repo.root, "docs/wiki/keyboard-teleop.md") + "\nIt detects too now.\n");
    commit(repo.root, BEN, "Move the detector into teleop");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /You changed src\/object_detection\/detector\.py, but its wiki page docs\/wiki\/object-detection\.md did not change/);
    assert.doesNotMatch(r.out, /keyboard-teleop\.md did not change/);
  } finally {
    repo.cleanup();
  }
});

test("drift: the escape line's reason must be on the same line", () => {
  const pages = [{ path: "docs/wiki/a.md", code: ["pkgs/a/**"] }];
  const changed = ["pkgs/a/x.js"];
  assert.strictEqual(drift.driftProblems(pages, changed, "wiki: no change needed -\nbecause reasons").length, 1);
  assert.strictEqual(drift.driftProblems(pages, changed, "wiki: no change needed\n- because reasons").length, 1);
  assert.strictEqual(drift.driftProblems(pages, changed, "wiki: no change needed - \r\nreason").length, 1);
  assert.strictEqual(drift.driftProblems(pages, changed, "Intro.\n  wiki:  no change needed  -  a rename\n").length, 0);
});
