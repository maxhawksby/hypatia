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
const BOT = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

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
//
// By default it is shaped like a wiki that came from an older setup: a team
// file (docs/team.yml) and hubs that name the README's title as their parent.
// generic: true makes a plain repo instead, with no team file, a README
// titled "Acme Notes" and hubs under "home".
// Returns { root, cleanup }.
function makeRepo({ generic = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-test-"));
  const root = path.join(tmp, "repo");
  const origin = path.join(tmp, "origin.git");
  fs.cpSync(FIXTURE, root, { recursive: true });
  if (generic) {
    fs.rmSync(path.join(root, "docs", "team.yml"));
    write(root, "README.md", "# Acme Notes\n\nA note-taking app. Start at a hub: [Senses](docs/wiki/senses.md) or [Movement](docs/wiki/movement.md).\n");
    for (const name of fs.readdirSync(path.join(root, "docs", "wiki"))) {
      const file = path.join(root, "docs", "wiki", name);
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("parent: oak", "parent: home").replace(/\bOak\b/g, "Acme"));
    }
  }
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
  write(root, "src/object_detection/README.md", "Docs only.\n");
  commit(root, BOT, "Object detection: bump a dependency");
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
  git(root, ["remote", "set-url", "origin", "git@github.com:acme/notes-app.git"]);
  return { root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

module.exports = { FIXTURE, git, write, commit, makeRepo, ANA, BEN, STRANGER, BOT };
