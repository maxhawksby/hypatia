// The update check: says when a newer Hypatia is on npm, with the command
// that gets it. `hypatia check`, `serve`, `init` and `upgrade` use it; build,
// mirror and ping run in GitHub Actions and never ask.
//
// It sends one plain GET to the npm registry for the latest version (no repo
// data, no names) and keeps the answer for a day in
// $XDG_CACHE_HOME/hypatia/update-check.json (else ~/.cache/hypatia/), so the
// network is asked at most once a day, even when it is down. It never throws
// and never holds a command up longer than the timeout: any problem means no
// notice.
//
// It is off when CI or HYPATIA_NO_UPDATE_CHECK is set, and when Hypatia runs
// from a git checkout of itself (a developer), unless HYPATIA_REGISTRY names
// another registry: the tests point that at a stand-in server.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { VERSION } = require("./init");
const { compareVersions } = require("./upgrade");

const HYPATIA_ROOT = path.join(__dirname, "..");
const REGISTRY = "https://registry.npmjs.org/hypatia/latest";
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;

// Why the check is off, or null when it is on.
function offReason(env = process.env, root = HYPATIA_ROOT) {
  if (env.CI) return "CI is set";
  if (env.HYPATIA_NO_UPDATE_CHECK) return "HYPATIA_NO_UPDATE_CHECK is set";
  if (!env.HYPATIA_REGISTRY && fs.existsSync(path.join(root, ".git"))) return "running from a git checkout of Hypatia";
  return null;
}

function cacheFile(env = process.env) {
  const base = env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "hypatia", "update-check.json");
}

// The saved answer: { registry, checked, latest }, or null.
function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    return c && typeof c.checked === "number" ? c : null;
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data) + "\n");
  } catch {
    // a read-only home: the check just asks again next time
  }
}

// The latest version on the registry, or null when it can't be read.
async function fetchLatest(url, timeoutMs) {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const { version } = await res.json();
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  }
}

// How this copy of Hypatia was installed, as the command that updates it:
// the npx cache, a project's node_modules (a folder with a package.json holds
// it), else a global install.
function updateCommand(command, where = HYPATIA_ROOT) {
  const parts = path.resolve(where).split(/[\\/]/);
  if (parts.includes("_npx")) return { how: "npx", text: `npx hypatia@latest${command ? " " + command : ""}` };
  const i = parts.indexOf("node_modules");
  if (i > 0 && fs.existsSync(path.join(parts.slice(0, i).join(path.sep) || path.sep, "package.json"))) {
    return { how: "project", text: "npm install hypatia@latest" };
  }
  return { how: "global", text: "npm install -g hypatia@latest" };
}

// The one line to print, from what the check found.
function noticeLine(latest, current, cmd) {
  const verb = cmd.how === "npx" ? "Use it with" : "Update with";
  return `hypatia: Hypatia ${latest} is out (you have ${current}). ${verb}: ${cmd.text}`;
}

// What the check found: { latest, current, command, line } when a newer
// version is out, else null. command is what `hypatia <command>` was run, for
// the npx line. opts (for the tests): env, now, timeoutMs, where, current.
async function updateCheck(command, opts = {}) {
  try {
    const env = opts.env || process.env;
    if (offReason(env, opts.root)) return null;
    const registry = env.HYPATIA_REGISTRY || REGISTRY;
    const now = opts.now === undefined ? Date.now() : opts.now;
    const file = cacheFile(env);
    const cache = readCache(file);
    const same = cache && cache.registry === registry;
    let latest;
    if (same && cache.checked <= now && now - cache.checked < DAY_MS) latest = cache.latest;
    else {
      latest = await fetchLatest(registry, opts.timeoutMs || TIMEOUT_MS);
      // a failed ask is saved too (keeping the last answer), so being offline
      // costs one timeout a day, not one per command
      writeCache(file, { registry, checked: now, latest: latest || (same ? cache.latest : null) });
      if (!latest && same) latest = cache.latest;
    }
    const current = opts.current || VERSION;
    if (typeof latest !== "string" || compareVersions(latest, current) <= 0) return null;
    const cmd = updateCommand(command, opts.where);
    return { latest, current, command: cmd.text, line: noticeLine(latest, current, cmd) };
  } catch {
    return null;
  }
}

module.exports = { updateCheck, updateCommand, offReason, cacheFile, REGISTRY, DAY_MS, TIMEOUT_MS };
