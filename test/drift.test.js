// Tests for the drift and coverage checks in `hypatia check` (lib/drift.js):
// a page with code: is current only while its verified: stamp matches that
// code; drift: warn lists stale pages, drift: error fails on them, and a
// pull request can skip one page by name. Every folder in a coverage root
// needs a page. Each test plants one case in a throwaway repo. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const drift = require("../lib/drift");
const { makeRepo, write, commit, git, BEN } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");

// hypatia <command> in root; env adds to (and blanks) the CI variables.
function run(root, command, args = [], env = {}) {
  const e = { ...process.env, HYPATIA_PR_BODY: "", PR_BODY: "", GITHUB_BASE_REF: "", ...env };
  delete e.GITHUB_TOKEN;
  const r = spawnSync(process.execPath, [CLI, command, ...args], { cwd: root, env: e, encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
const check = (root, args, env) => run(root, "check", args, env);
const verify = (root, args, env) => run(root, "verify", args, env);

const DETECTOR = "src/object_detection/detector.py";
const PAGE = "docs/wiki/object-detection.md";
const TELEOP_PAGE = "docs/wiki/keyboard-teleop.md";
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");

// A generic fixture repo with drift set to mode and every page verified on
// master, then a feature branch off it.
function branchRepo(mode = "error") {
  const repo = makeRepo({ generic: true });
  if (mode) write(repo.root, "docs/hypatia.yml", `drift: ${mode}\n`);
  const r = verify(repo.root, ["--all"]);
  assert.strictEqual(r.code, 0, r.out);
  commit(repo.root, BEN, "Verify the pages");
  git(repo.root, ["switch", "-q", "-c", "feature"]);
  return repo;
}

test("drift: verified pages pass in every mode, and the summary says so", () => {
  const repo = branchRepo();
  try {
    const r = check(repo.root);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /2 pages match the code they were last verified against\./);
  } finally {
    repo.cleanup();
  }
});

test("drift: changing a page's code fails in error mode, lists what changed since the base, and says how to fix it", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "def detect(image):\n    print('found')\n    return []\n");
    commit(repo.root, BEN, "Object detection: return what it finds");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/object-detection\.md is out of date: its code changed since it was last verified\. Changed since master:/);
    assert.match(r.out, /\n {4}src\/object_detection\/detector\.py \(\+3 -1\)/);
    assert.match(r.out, /Reread this file, update the sections of docs\/wiki\/object-detection\.md about it, then run 'hypatia verify docs\/wiki\/object-detection\.md'\./);
    assert.match(r.out, /wiki: no change needed for docs\/wiki\/object-detection\.md - <reason>/);
    assert.doesNotMatch(r.out, /keyboard-teleop\.md is out of date/);
  } finally {
    repo.cleanup();
  }
});

test("drift: the change list names the changed functions or headings from git's hunk headers", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "def detect(image):\n    a = 1\n    b = 2\n    c = 3\n    d = 4\n    return a\n");
    commit(repo.root, BEN, "Detect");
    write(repo.root, DETECTOR, "def detect(image):\n    a = 1\n    b = 2\n    c = 3\n    d = 5\n    return a\n");
    write(repo.root, "src/object_detection/boxes.py", "boxes = []\n");
    git(repo.root, ["add", "src/object_detection/boxes.py"]);
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /src\/object_detection\/boxes\.py \(new, 1 line\)/);
    assert.match(r.out, /src\/object_detection\/detector\.py \(\+6 -1\)/);
    const hunks = drift.changeSummary(repo.root, "HEAD", [DETECTOR]);
    assert.deepStrictEqual(hunks.map((h) => [h.added, h.removed, h.names]), [[1, 1, ["detect"]]]);
    assert.strictEqual(drift.hunkName("## Setup"), "Setup");
    assert.strictEqual(drift.hunkName("export function serve(root, argv) {"), "serve");
  } finally {
    repo.cleanup();
  }
});

test("drift: without a base it works on any branch and says how to see what changed", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "src/keyboard_teleop/teleop.py", "print('new keys')\n"); // uncommitted
    git(repo.root, ["remote", "remove", "origin"]); // no default branch to compare with
    const r = check(repo.root);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/keyboard-teleop\.md is out of date: code changed since last verified \(code: src\/keyboard_teleop\/\*\*\)\. Reread those files, update the sections of the page about them, then run 'hypatia verify docs\/wiki\/keyboard-teleop\.md'\. To see which files changed, run 'hypatia check --base master'\./, "no origin: the local master is suggested");
  } finally {
    repo.cleanup();
  }
});

test("drift: the --base hint names a ref that exists: origin's default branch, else local main or master, else none", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "src/keyboard_teleop/teleop.py", "print('new keys')\n");
    assert.strictEqual(drift.suggestedBase(repo.root), "origin/master");
    assert.match(check(repo.root).out, /Changed since origin\/master:/, "with an origin, the details come from it");
    git(repo.root, ["remote", "remove", "origin"]);
    git(repo.root, ["branch", "-q", "-m", "master", "main"]);
    assert.strictEqual(drift.suggestedBase(repo.root), "main");
    assert.match(check(repo.root).out, /run 'hypatia check --base main'\./);
    git(repo.root, ["branch", "-q", "-m", "main", "trunk"]);
    assert.strictEqual(drift.suggestedBase(repo.root), null);
    const r = check(repo.root);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /then run 'hypatia verify docs\/wiki\/keyboard-teleop\.md'\.\n/);
    assert.doesNotMatch(r.out, /--base/);
  } finally {
    repo.cleanup();
  }
});

test("drift: a one-character page edit no longer passes; rereading and verify does", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    write(repo.root, PAGE, read(repo.root, PAGE) + ".");
    commit(repo.root, BEN, "Object detection: faster");
    assert.strictEqual(check(repo.root, ["--base", "master"]).code, 1, "touching the page is not enough");
    const v = verify(repo.root, [PAGE]);
    assert.strictEqual(v.code, 0, v.out);
    assert.match(v.out, /Verified docs\/wiki\/object-detection\.md against its code \(2 files\): verified: [0-9a-f]{12}\./);
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(verify(repo.root, [PAGE]).out, /was already verified/);
  } finally {
    repo.cleanup();
  }
});

test("drift: modes - warn lists stale pages and passes, error fails, off says nothing; --warn and --no-drift override", () => {
  const repo = branchRepo("warn");
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    const warn = check(repo.root);
    assert.strictEqual(warn.code, 0, warn.out);
    assert.match(warn.out, /hypatia: warning: docs\/wiki\/object-detection\.md is out of date/);
    assert.match(warn.out, /1 page is out of date \(listed above\)\./);
    write(repo.root, "docs/hypatia.yml", "drift: error\n");
    assert.strictEqual(check(repo.root).code, 1);
    const forced = check(repo.root, ["--warn"]);
    assert.strictEqual(forced.code, 0, forced.out);
    assert.match(forced.out, /warning: docs\/wiki\/object-detection\.md is out of date/);
    assert.strictEqual(check(repo.root, ["--no-drift"]).code, 0);
    write(repo.root, "docs/hypatia.yml", "drift: off\n");
    const off = check(repo.root);
    assert.strictEqual(off.code, 0, off.out);
    assert.doesNotMatch(off.out, /out of date/);
    assert.strictEqual(check(repo.root, ["--base", "master"]).code, 1, "--base turns the check on when the config leaves it off");
    write(repo.root, "docs/hypatia.yml", "drift: true\n");
    const legacy = check(repo.root);
    assert.strictEqual(legacy.code, 0, "true is the older switch and means warn");
    assert.strictEqual(legacy.out.split('"drift: true" is from an older Hypatia and now means warn; set "drift: error" once every page is verified.').length, 2, "said once");
    assert.match(legacy.out, /warning: docs\/wiki\/object-detection\.md is out of date/);
  } finally {
    repo.cleanup();
  }
});

test("drift: a page with code: but no verified: line is unverified and stale", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "docs/wiki/speech.md", "---\ntitle: Speech\nparent: senses\ncode: [src/speech/**]\n---\nTalks.\n");
    write(repo.root, "src/speech/speak.py", "print('hi')\n");
    const r = check(repo.root);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/speech\.md has never been verified against its code \(no verified: line\)\. Reread the files its code: covers \(src\/speech\/\*\*\), make sure the page says what they do, then run 'hypatia verify docs\/wiki\/speech\.md'\./);
    assert.strictEqual(verify(repo.root, ["docs/wiki/speech.md"]).code, 0);
    assert.strictEqual(check(repo.root).code, 0);
  } finally {
    repo.cleanup();
  }
});

test("drift: a per-page skip line skips only that page, and only with a reason", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    write(repo.root, "src/keyboard_teleop/teleop.py", "print('new keys')\n");
    const body = `Renames.\n\nwiki: no change needed for ${PAGE} - only a variable rename\n`;
    const one = check(repo.root, [], { HYPATIA_PR_BODY: body });
    assert.strictEqual(one.code, 1, one.out);
    assert.match(one.out, /object-detection\.md is out of date but skipped in this pull request: only a variable rename/);
    assert.match(one.out, /keyboard-teleop\.md is out of date/);
    assert.doesNotMatch(one.out, /deprecat|going away/);
    const both = check(repo.root, [], { PR_BODY: "Wiki: No change needed for object-detection.md, keyboard-teleop - same behavior" });
    assert.strictEqual(both.code, 0, both.out);
    assert.strictEqual(check(repo.root, [], { HYPATIA_PR_BODY: `wiki: no change needed for ${PAGE} -` }).code, 1, "no reason, no skip");
    const typo = check(repo.root, [], { HYPATIA_PR_BODY: "wiki: no change needed for nope.md - x" });
    assert.match(typo.out, /skips 'nope\.md', but no page with code: has that name/);
  } finally {
    repo.cleanup();
  }
});

test("drift: the old line that skips every page still works, with a deprecation warning", () => {
  const repo = branchRepo();
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    const r = check(repo.root, [], { HYPATIA_PR_BODY: "wiki: no change needed - only a rename\n" });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /warning: the line 'wiki: no change needed - <reason>' skips every page and is going away\. Name each page instead: 'wiki: no change needed for <page\.md> - <reason>', or, if a page is still right, reread it and run 'hypatia verify <page\.md>'\./);
    assert.match(r.out, /1 out-of-date page is skipped by the pull request's 'wiki: no change needed' line\./);
    assert.strictEqual(check(repo.root, [], { HYPATIA_PR_BODY: "wiki: no change needed -\nbecause" }).code, 1, "the reason must be on the same line");
  } finally {
    repo.cleanup();
  }
});

test("drift: a change no page covers passes; a bad --base fails clearly; a bad CI base only warns", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "notes.txt", "hello\n");
    commit(repo.root, BEN, "Notes");
    assert.strictEqual(check(repo.root, ["--base", "master"]).code, 0);
    write(repo.root, DETECTOR, "print('detect faster')\n");
    const r = check(repo.root, ["--base", "origin/nope"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /could not compare this branch with 'origin\/nope'/);
    const ci = check(repo.root, ["--warn"], { GITHUB_BASE_REF: "nope" });
    assert.strictEqual(ci.code, 0, ci.out);
    assert.match(ci.out, /warning: could not compare this branch with 'origin\/nope'/);
    assert.match(ci.out, /code changed since last verified/);
  } finally {
    repo.cleanup();
  }
});

test("drift is off by default, and off without docs/hypatia.yml", () => {
  const repo = branchRepo(null);
  try {
    write(repo.root, DETECTOR, "print('detect faster')\n");
    const r = check(repo.root);
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /out of date/);
  } finally {
    repo.cleanup();
  }
});

test("drift: a private page's code counts too", () => {
  const repo = branchRepo();
  try {
    write(repo.root, "docs/wiki/secret-sauce.md", "---\ntitle: Secret sauce\nparent: senses\nprivate: true\ncode: [src/sauce/**]\n---\nNotes.\n");
    write(repo.root, "src/sauce/a.py", "pass\n");
    assert.strictEqual(verify(repo.root, ["docs/wiki/secret-sauce.md"]).code, 0);
    commit(repo.root, BEN, "Sauce");
    write(repo.root, "src/sauce/a.py", "pass  # changed\n");
    const r = check(repo.root);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /docs\/wiki\/secret-sauce\.md is out of date/);
  } finally {
    repo.cleanup();
  }
});

test("drift: moving a file between two covered folders makes both pages stale", () => {
  const repo = branchRepo();
  try {
    git(repo.root, ["mv", DETECTOR, "src/keyboard_teleop/detector.py"]);
    commit(repo.root, BEN, "Move the detector into teleop");
    const r = check(repo.root, ["--base", "master"]);
    assert.strictEqual(r.code, 1, r.out);
    assert.match(r.out, /object-detection\.md is out of date[^\n]*\n {4}src\/object_detection\/detector\.py \(\+0 -1\)/);
    assert.match(r.out, /keyboard-teleop\.md is out of date[^\n]*\n {4}src\/keyboard_teleop\/detector\.py \(new, 1 line\)/);
  } finally {
    repo.cleanup();
  }
});

test("verify: --all stamps every page with code:, skips pages without, and rejects bad input", () => {
  const repo = makeRepo({ generic: true });
  try {
    const all = verify(repo.root, ["--all"]);
    assert.strictEqual(all.code, 0, all.out);
    assert.match(read(repo.root, PAGE), /\ncode: \[src\/object_detection\/\*\*\]\nverified: [0-9a-f]{12}\n---\n/);
    assert.match(read(repo.root, TELEOP_PAGE), /verified: [0-9a-f]{12}/);
    assert.doesNotMatch(read(repo.root, "docs/wiki/senses.md"), /verified:/);
    const hub = verify(repo.root, ["docs/wiki/senses.md"]);
    assert.strictEqual(hub.code, 0);
    assert.match(hub.out, /Skipped docs\/wiki\/senses\.md: it has no code:/);
    assert.strictEqual(verify(repo.root, []).code, 2);
    assert.strictEqual(verify(repo.root, ["--all", PAGE]).code, 2);
    assert.match(verify(repo.root, ["docs/wiki/nope.md"]).out, /docs\/wiki\/nope\.md is not a file in this repo/);
    // from a subfolder, paths are relative to where you stand
    const sub = spawnSync(process.execPath, [CLI, "verify", "object-detection.md"], { cwd: path.join(repo.root, "docs", "wiki"), encoding: "utf8" });
    assert.strictEqual(sub.status, 0, sub.stderr);
    assert.match(sub.stdout, /docs\/wiki\/object-detection\.md was already verified/);
  } finally {
    repo.cleanup();
  }
});

test("coverage: a new folder without a page fails; with a page it passes; off without the config", () => {
  const repo = branchRepo(null);
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
});

test("skip lines: per-page names and reasons, the old global line, reasons on the same line only", () => {
  const s = drift.skipLines("Intro.\n  wiki:  no change needed for  docs/wiki/a.md, `b.md`  -  a rename\nwiki: no change needed for c.md -\nreason");
  assert.deepStrictEqual([...s.pages], [["docs/wiki/a.md", "a rename"], ["b.md", "a rename"]]);
  assert.strictEqual(s.all, false);
  assert.strictEqual(drift.skipLines("wiki: no change needed - x").all, true);
  assert.strictEqual(drift.skipLines("wiki: no change needed - \r\nreason").all, false);
  assert.strictEqual(drift.skipLines("wiki: no change needed\n- because").all, false);
  assert.strictEqual(drift.skipLines("wiki: no change needed for a.md - x").all, false, "a per-page line is not the global one");
});

test("drift: with a base, error mode fails only on stale pages this branch touched; the rest are warnings", () => {
  const repo = branchRepo();
  try {
    // object detection's code changes on master after the pages were verified
    git(repo.root, ["switch", "-q", "master"]);
    write(repo.root, DETECTOR, "print('changed on master')\n");
    commit(repo.root, BEN, "Detector on master");
    git(repo.root, ["switch", "-q", "-c", "other"]);
    write(repo.root, "notes.txt", "unrelated\n");
    commit(repo.root, BEN, "Notes");
    const mine = check(repo.root, ["--base", "master"]);
    assert.strictEqual(mine.code, 0, mine.out);
    assert.match(mine.out, /warning: docs\/wiki\/object-detection\.md is out of date[^\n]*This pull request did not change it or its code, so it does not fail the check\./);
    assert.match(mine.out, /1 page is out of date \(listed above\), none of them changed by this pull request\./);
    assert.strictEqual(check(repo.root).code, 1, "without a base every stale page fails");
    write(repo.root, "src/object_detection/more.py", "x = 1\n");
    commit(repo.root, BEN, "More detection");
    const touched = check(repo.root, ["--base", "master"]);
    assert.strictEqual(touched.code, 1, touched.out);
    assert.match(touched.out, /hypatia: docs\/wiki\/object-detection\.md is out of date/);
    // touching only the page blames it too
    write(repo.root, TELEOP_PAGE, read(repo.root, TELEOP_PAGE).replace(/verified: \w+/, "verified: 000000000000"));
    commit(repo.root, BEN, "Teleop page");
    assert.match(check(repo.root, ["--base", "master"]).out, /hypatia: docs\/wiki\/keyboard-teleop\.md is out of date/);
  } finally {
    repo.cleanup();
  }
});

test("skip lines: a short name must mean exactly one page, or it skips nothing", () => {
  const pages = [
    { path: "docs/wiki/start-here.md", code: ["a/**"] },
    { path: "docs/other/start-here.md", code: ["b/**"] },
    { path: "docs/wiki/solo.md", code: ["c/**"] },
  ];
  const r = drift.resolveSkips(drift.skipLines("wiki: no change needed for start-here, solo - fine"), pages);
  assert.deepStrictEqual([...r.skipped], [["docs/wiki/solo.md", "fine"]]);
  assert.match(r.warnings[0], /skips 'start-here', which could mean docs\/wiki\/start-here\.md or docs\/other\/start-here\.md, so it skips neither\. Use the page's full path\./);
  const full = drift.resolveSkips(drift.skipLines("wiki: no change needed for docs/other/start-here.md - fine"), pages);
  assert.deepStrictEqual([...full.skipped.keys()], ["docs/other/start-here.md"]);
});
