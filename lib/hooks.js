// `hypatia hooks`: an opt-in git pre-push hook that checks the wiki on your
// own computer before each push.
//
//   hypatia hooks install   write the pre-push hook
//   hypatia hooks remove    take it out again
//
// The hook runs `hypatia check --warn --base origin/<default branch>`, so it
// lists what the pull request check would say, and it never blocks the push:
// it always exits 0. It runs `hypatia` when that is on the PATH, else
// `npx --yes hypatia`.
//
// The hook goes where git looks for hooks (`git rev-parse --git-path hooks`),
// which follows core.hooksPath and works from a linked worktree. It carries a
// marker line; a pre-push hook without it is someone else's and is never
// overwritten or removed. Hypatia then says what to add to it instead.
"use strict";

const fs = require("fs");
const path = require("path");
const init = require("./init");

const MARKER = "# hypatia pre-push hook";

// The lines that run the check; also what to add to a hook of your own.
function checkLines(fallbackBranch) {
  return `# What the pull request check would say about the wiki; never blocks the push.
base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/${fallbackBranch})
if command -v hypatia >/dev/null 2>&1; then
  HYPATIA_NO_UPDATE_CHECK=1 hypatia check --warn --base "$base" || true
else
  HYPATIA_NO_UPDATE_CHECK=1 npx --yes hypatia check --warn --base "$base" || true
fi`;
}

function hookText(fallbackBranch) {
  return `#!/bin/sh
${MARKER}
# Installed by "hypatia hooks install"; "hypatia hooks remove" takes it out.
${checkLines(fallbackBranch)}
exit 0
`;
}

// Where the pre-push hook lives, as an absolute path, or null outside git.
function hookFile(root) {
  const rel = init.git(root, ["rev-parse", "--git-path", "hooks"]);
  if (rel === null) return null;
  return path.join(path.resolve(root, rel), "pre-push");
}

const isOurs = (text) => text.includes(MARKER);

// io: { log } stand-in for the tests.
async function hooks(root, argv, io = {}) {
  const log = io.log || ((s) => console.log(s));
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h" || !["install", "remove"].includes(action) || rest.length) {
    log("hypatia hooks install | remove");
    return action === "--help" || action === "-h" ? 0 : 2;
  }
  const file = init.git(root, ["rev-parse", "--show-toplevel"]) === null ? null : hookFile(root);
  if (!file) {
    log("hypatia hooks works in a git repo, and this folder is not in one. cd into the repo first.");
    return 1;
  }
  const shown = path.relative(root, file) || file;
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const branch = init.defaultBranch(root, null);

  if (action === "remove") {
    if (before === null) {
      log(`No pre-push hook at ${shown}: nothing to remove.`);
      return 0;
    }
    if (!isOurs(before)) {
      log(`The pre-push hook at ${shown} is not Hypatia's, so it was left as is. If you added Hypatia's lines to it, take them out by hand.`);
      return 1;
    }
    fs.rmSync(file);
    log(`Removed Hypatia's pre-push hook (${shown}).`);
    return 0;
  }

  if (before !== null && !isOurs(before)) {
    log(`There is already a pre-push hook at ${shown}, and it is not Hypatia's, so it was left as is.
To get the wiki warnings too, add these lines to it, before any "exit":

${checkLines(branch)}
`);
    return 1;
  }
  const text = hookText(branch);
  if (before === text) {
    log(`Hypatia's pre-push hook is already installed (${shown}).`);
    return 0;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
  log(`${before === null ? "Installed" : "Updated"} Hypatia's pre-push hook (${shown}). Before each git push it lists what the wiki check would say; the push always goes ahead. Remove it with: hypatia hooks remove`);
  return 0;
}

module.exports = { hooks, hookText, hookFile, checkLines, MARKER };
