// Tests for page stamps (lib/stamp.js): the `verified:` value that pins a
// page to the code its code: globs cover. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const stamp = require("../lib/stamp");
const { git, write } = require("./helpers");

// A small git repo with two files under src/ and one page.
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-stamp-"));
  git(root, ["init", "-q", "-b", "master"]);
  write(root, "src/a.js", "one\ntwo\n");
  write(root, "src/b.js", "three\n");
  write(root, "docs/wiki/a.md", "---\ntitle: A\nparent: home\ncode: [src/**]\n---\nAbout A.\n");
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("stamp: 12 hex characters, the same for the same content, CRLF and LF alike", () => {
  const r = repo();
  try {
    const first = stamp.codeStamp(r.root, ["src/**"]);
    assert.match(first, stamp.STAMP_RE);
    assert.strictEqual(stamp.codeStamp(r.root, ["src/**"]), first);
    assert.strictEqual(stamp.codeStamp(r.root, ["src/a.js", "src/b.js"]), first, "the same files by other globs");
    write(r.root, "src/a.js", "one\r\ntwo\r\n");
    assert.strictEqual(stamp.codeStamp(r.root, ["src/**"]), first, "CRLF counts as LF");
    write(r.root, "src/a.js", "one\ntwo!\n");
    assert.notStrictEqual(stamp.codeStamp(r.root, ["src/**"]), first, "a content change changes it");
  } finally {
    r.cleanup();
  }
});

test("stamp: a file added to or removed from the glob changes it; ignored files never count", () => {
  const r = repo();
  try {
    const first = stamp.codeStamp(r.root, ["src/**"]);
    write(r.root, "src/c.js", "");
    const added = stamp.codeStamp(r.root, ["src/**"]);
    assert.notStrictEqual(added, first, "even an empty new file");
    fs.rmSync(path.join(r.root, "src/c.js"));
    assert.strictEqual(stamp.codeStamp(r.root, ["src/**"]), first);
    write(r.root, ".gitignore", "src/build/\n");
    write(r.root, "src/build/out.js", "generated\n");
    assert.strictEqual(stamp.codeStamp(r.root, ["src/**"]), first, "git-ignored files are left out");
    fs.renameSync(path.join(r.root, "src/b.js"), path.join(r.root, "src/d.js"));
    assert.notStrictEqual(stamp.codeStamp(r.root, ["src/**"]), first, "a rename changes it: paths count");
  } finally {
    r.cleanup();
  }
});

test("pageStamps: current, stale, unverified and none", () => {
  const r = repo();
  try {
    const actual = stamp.codeStamp(r.root, ["src/**"]);
    write(r.root, "docs/wiki/b.md", `---\ntitle: B\nparent: home\ncode: [src/b.js]\nverified: 000000000000\n---\n`);
    write(r.root, "docs/wiki/c.md", `---\ntitle: C\nparent: home\ncode: [src/**]\nverified: ${actual}\n---\n`);
    write(r.root, "docs/wiki/hub.md", "---\ntitle: Hub\nparent: home\n---\n");
    const pages = [
      { path: "docs/wiki/a.md", code: ["src/**"] },
      { path: "docs/wiki/b.md", code: ["src/b.js"] },
      { path: "docs/wiki/c.md", code: ["src/**"] },
      { path: "docs/wiki/hub.md", code: [] },
    ];
    const got = stamp.pageStamps(r.root, pages);
    assert.deepStrictEqual([...got].map(([p, s]) => [p, s.state]), [
      ["docs/wiki/a.md", "unverified"],
      ["docs/wiki/b.md", "stale"],
      ["docs/wiki/c.md", "current"],
      ["docs/wiki/hub.md", "none"],
    ]);
    assert.strictEqual(got.get("docs/wiki/b.md").stored, "000000000000");
    assert.strictEqual(got.get("docs/wiki/c.md").actual, actual);
  } finally {
    r.cleanup();
  }
});

test("setVerified: only the verified: line changes; added when missing; CRLF kept", () => {
  const page = "---\ntitle: A   # a comment\nparent: home\ncode:\n  - src/**\n---\nBody\n---\nmore\n";
  const added = stamp.setVerified(page, "abcdef123456");
  assert.strictEqual(added, "---\ntitle: A   # a comment\nparent: home\ncode:\n  - src/**\nverified: abcdef123456\n---\nBody\n---\nmore\n");
  const replaced = stamp.setVerified(added, "0123456789ab");
  assert.strictEqual(replaced, added.replace("abcdef123456", "0123456789ab"));
  const crlf = "---\r\ntitle: A\r\ncode: [src/**]\r\nverified: old\r\n---\r\nBody\r\n";
  assert.strictEqual(stamp.setVerified(crlf, "0123456789ab"), "---\r\ntitle: A\r\ncode: [src/**]\r\nverified: 0123456789ab\r\n---\r\nBody\r\n");
  const crlfNew = "---\r\ntitle: A\r\ncode: [src/**]\r\n---\r\nBody\r\n";
  assert.strictEqual(stamp.setVerified(crlfNew, "0123456789ab"), "---\r\ntitle: A\r\ncode: [src/**]\r\nverified: 0123456789ab\r\n---\r\nBody\r\n");
  assert.strictEqual(stamp.setVerified("no front matter\n", "0123456789ab"), null);
});

test("verify keeps the rest of the page byte-identical", () => {
  const r = repo();
  try {
    const file = path.join(r.root, "docs/wiki/a.md");
    const before = "---\ntitle: \"A: the page\"\nparent: home\ncode: [src/**]   # all of it\nverified: 000000000000\nprivate: false\n---\n# A\n\nverified: not front matter\n";
    fs.writeFileSync(file, before);
    const out = [];
    assert.strictEqual(stamp.verifyCommand(r.root, ["docs/wiki/a.md"], { cwd: r.root, log: (m) => out.push(m), error: (m) => out.push(m) }), 0, out.join("\n"));
    const after = fs.readFileSync(file, "utf8");
    const actual = stamp.codeStamp(r.root, ["src/**"]);
    assert.strictEqual(after, before.replace("verified: 000000000000", `verified: ${actual}`));
    assert.strictEqual(stamp.pageStamps(r.root, [{ path: "docs/wiki/a.md", code: ["src/**"] }]).get("docs/wiki/a.md").state, "current");
  } finally {
    r.cleanup();
  }
});
