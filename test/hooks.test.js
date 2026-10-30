// Tests for `hypatia hooks` (lib/hooks.js): the opt-in pre-push hook that
// runs the wiki check in warn mode and never blocks a push. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const { hooks, MARKER } = require("../lib/hooks");
const { git, write, commit, BEN } = require("./helpers");

const CLI = path.join(__dirname, "..", "bin", "hypatia.js");
const posix = process.platform !== "win32";

// A repo with one commit and a local bare origin it can push to.
function repoWithOrigin() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-hooks-"));
  const root = path.join(tmp, "repo");
  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(root);
  git(tmp, ["init", "-q", "--bare", "-b", "main", origin]);
  git(root, ["init", "-q", "-b", "main"]);
  write(root, "README.md", "# Notes\n");
  commit(root, BEN, "First");
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "origin", "main"]);
  return { tmp, root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

async function run(root, argv) {
  const lines = [];
  const code = await hooks(root, argv, { log: (s) => lines.push(s) });
  return { code, out: lines.join("\n") };
}

const hookAt = (root) => path.join(root, ".git", "hooks", "pre-push");

test("install writes a marked pre-push hook that runs check --warn against origin's default branch; remove takes it out", async () => {
  const repo = repoWithOrigin();
  try {
    const r = await run(repo.root, ["install"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Installed Hypatia's pre-push hook \(\.git\/hooks\/pre-push\)/);
    const text = fs.readFileSync(hookAt(repo.root), "utf8");
    assert.match(text, /^#!\/bin\/sh\n/);
    assert.ok(text.includes(MARKER));
    assert.match(text, /hypatia check --warn \$\{base:\+--base "\$base"\}/);
    assert.match(text, /npx --yes hypatia check --warn/, "falls back to npx when hypatia is not on the PATH");
    assert.match(text, /for b in origin\/main origin\/master/, "the branch is found at push time");
    assert.match(text, /\nexit 0\n$/);
    if (posix) assert.ok(fs.statSync(hookAt(repo.root)).mode & 0o111, "executable");

    const again = await run(repo.root, ["install"]);
    assert.strictEqual(again.code, 0);
    assert.match(again.out, /already installed/);

    const removed = await run(repo.root, ["remove"]);
    assert.strictEqual(removed.code, 0, removed.out);
    assert.ok(!fs.existsSync(hookAt(repo.root)));
    const nothing = await run(repo.root, ["remove"]);
    assert.strictEqual(nothing.code, 0);
    assert.match(nothing.out, /nothing to remove/);
  } finally {
    repo.cleanup();
  }
});

test("a pre-push hook that is not Hypatia's is never overwritten or removed, and install prints what to add", async () => {
  const repo = repoWithOrigin();
  try {
    const mine = "#!/bin/sh\nnpm test\n";
    write(repo.root, ".git/hooks/pre-push", mine);
    const r = await run(repo.root, ["install"]);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /already a pre-push hook at \.git\/hooks\/pre-push, and it is not Hypatia's, so it was left as is/);
    assert.match(r.out, /add these lines to it[\s\S]*hypatia check --warn \$\{base:\+--base "\$base"\} \|\| true/);
    const rm = await run(repo.root, ["remove"]);
    assert.strictEqual(rm.code, 1);
    assert.match(rm.out, /not Hypatia's, so it was left as is/);
    assert.strictEqual(fs.readFileSync(hookAt(repo.root), "utf8"), mine);
  } finally {
    repo.cleanup();
  }
});

test("the hook goes where git looks: core.hooksPath, and the shared hooks folder from a linked worktree", async () => {
  const repo = repoWithOrigin();
  try {
    git(repo.root, ["config", "core.hooksPath", ".githooks"]);
    const r = await run(repo.root, ["install"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(fs.existsSync(path.join(repo.root, ".githooks", "pre-push")));
    assert.ok(!fs.existsSync(hookAt(repo.root)));
    git(repo.root, ["config", "--unset", "core.hooksPath"]);

    const tree = path.join(repo.tmp, "tree");
    git(repo.root, ["worktree", "add", "-q", "-b", "side", tree]);
    const w = await run(tree, ["install"]);
    assert.strictEqual(w.code, 0, w.out);
    assert.ok(fs.existsSync(hookAt(repo.root)), "into the main .git/hooks, which every worktree uses");
  } finally {
    repo.cleanup();
  }
});

test("a real git push goes ahead even when the check fails, and shows its output", { skip: !posix }, async () => {
  const repo = repoWithOrigin();
  try {
    await run(repo.root, ["install"]);
    // a hypatia on the PATH that reports a problem and fails
    const bin = path.join(repo.tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "hypatia"), '#!/bin/sh\necho "hypatia: stand-in check ran with: $*" >&2\nexit 1\n', { mode: 0o755 });
    write(repo.root, "notes.md", "more\n");
    commit(repo.root, BEN, "More");
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
    const push = spawnSync("git", ["push", "origin", "main"], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(push.status, 0, push.stderr);
    assert.match(push.stderr, /stand-in check ran with: check --warn --base origin\/main/);
    assert.strictEqual(git(repo.root, ["rev-parse", "HEAD"]), git(repo.root, ["rev-parse", "origin/main"]), "the push went through");
  } finally {
    repo.cleanup();
  }
});

test("a hostile branch name is never pasted into the hook and never runs as a command", { skip: !posix }, async () => {
  const repo = repoWithOrigin();
  try {
    const hostile = "x$(touch${IFS}pwned)`touch${IFS}pwned2`;touch${IFS}pwned3";
    git(repo.root, ["check-ref-format", "--branch", hostile]);
    // the branch is checked out when the hook is installed, and is origin's default at push time
    git(repo.root, ["switch", "-q", "-c", hostile]);
    git(repo.root, ["push", "-q", "origin", hostile]);
    git(repo.root, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${hostile}`]);
    const r = await run(repo.root, ["install"]);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(!fs.readFileSync(hookAt(repo.root), "utf8").includes("pwned"), "no branch name in the hook");

    const bin = path.join(repo.tmp, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "hypatia"), '#!/bin/sh\nfor a in "$@"; do echo "arg=[$a]" >&2; done\nexit 1\n', { mode: 0o755 });
    write(repo.root, "notes.md", "more\n");
    commit(repo.root, BEN, "More");
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
    const push = spawnSync("git", ["push", "origin", hostile], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(push.status, 0, push.stderr);
    assert.ok(push.stderr.includes(`arg=[origin/${hostile}]`), push.stderr);
    for (const name of ["pwned", "pwned2", "pwned3"]) {
      assert.ok(!fs.existsSync(path.join(repo.root, name)), `${name} was not created`);
      assert.ok(!fs.existsSync(path.join(repo.tmp, name)), `${name} was not created`);
    }
  } finally {
    repo.cleanup();
  }
});

test("hypatia hooks from the CLI: usage, help, and outside a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-nogit-"));
  try {
    const bare = spawnSync(process.execPath, [CLI, "hooks"], { cwd: dir, encoding: "utf8" });
    assert.strictEqual(bare.status, 2);
    assert.match(bare.stdout, /hypatia hooks install \| remove/);
    const help = spawnSync(process.execPath, [CLI, "help", "hooks"], { encoding: "utf8" });
    assert.match(help.stdout, /never blocks the\s+push/);
    const out = spawnSync(process.execPath, [CLI, "hooks", "install"], { cwd: dir, encoding: "utf8" });
    assert.strictEqual(out.status, 1);
    assert.match(out.stdout, /not in one/);
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
