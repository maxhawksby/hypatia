// Shared test helpers: a throwaway git repo made from test/fixture.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const FIXTURE = path.join(__dirname, "fixture");

// git with no user or system config, so a teammate's hooks or signing
// settings never change what the tests see.
function git(cwd, args, author) {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1" };
  if (author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = author.email;
  }
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const ANA = { name: "Ana Lopez", email: "1234+ana-gh@users.noreply.github.com" };
const BEN = { name: "Ben Carter", email: "ben@example.com" };
const STRANGER = { name: "Stranger", email: "s@example.com" };

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root, author, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message], author);
}

// A repo with a history, an origin on GitHub's URL shape (a local bare repo
// stands in for it), one active branch and one already-merged branch.
// Returns { root, cleanup }.
function makeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-test-"));
  const root = path.join(tmp, "repo");
  const origin = path.join(tmp, "origin.git");
  fs.cpSync(FIXTURE, root, { recursive: true });
  git(tmp, ["init", "-q", "--bare", "-b", "master", origin]);
  git(root, ["init", "-q", "-b", "master"]);
  commit(root, BEN, "Wiki: first pages");
  write(root, "src/object_detection/detector.py", "print('found')\n");
  commit(root, ANA, "Object detection: print what it finds");
  write(root, "src/keyboard_teleop/teleop.py", "print('drive')\n");
  write(root, "docs/wiki/keyboard-teleop.md", fs.readFileSync(path.join(root, "docs/wiki/keyboard-teleop.md"), "utf8") + "\nUse the arrow keys.\n");
  commit(root, BEN, "Keyboard teleop: arrow keys");
  write(root, "notes.txt", "not a page\n");
  commit(root, STRANGER, "Notes");
  git(root, ["remote", "add", "origin", origin]);
  git(root, ["push", "-q", "origin", "master"]);
  // a branch merged long ago: nothing master lacks
  git(root, ["push", "-q", "origin", "master:ben/old"]);
  // an active branch with one commit master lacks
  git(root, ["switch", "-q", "-c", "ana/feat/boxes"]);
  write(root, "src/object_detection/boxes.py", "boxes = []\n");
  commit(root, ANA, "Object detection: draw boxes");
  git(root, ["push", "-q", "origin", "ana/feat/boxes"]);
  git(root, ["switch", "-q", "master"]);
  git(root, ["fetch", "-q", "origin"]);
  // the slug comes from the remote URL; point it at a GitHub-shaped one now
  // that the pushes are done (nothing contacts GitHub in the tests)
  git(root, ["remote", "set-url", "origin", "git@github.com:acme/robot-dog.git"]);
  return { root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

module.exports = { FIXTURE, git, write, commit, makeRepo, ANA, BEN, STRANGER };
