// Two checks that keep the wiki in step with the code, both off until the
// config (docs/hypatia.yml) turns them on:
//
// - drift (`drift: warn` or `drift: error`): every page with `code:` carries
//   a `verified:` stamp of the code it was last checked against
//   (lib/stamp.js). A page whose stamp no longer matches its code, or that
//   has none, is stale: warn lists it, error fails the check. It needs no
//   base branch; with one (`hypatia check --base <ref>`, or the pull
//   request's base in GitHub Actions) each stale page also lists what
//   changed. A pull request can skip one page with a line
//   "wiki: no change needed for <page.md> - <reason>".
// - coverage (`coverage: src`, or a list): every top-level folder in those
//   folders is claimed by some page's `code:`, so a new folder of code always
//   gets a page.
//
// Node built-ins only.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { matches } = require("./globs");
const { readText } = require("./text");
const { parseFrontMatter } = require("./build-graph");
const { pageStamps } = require("./stamp");

// "wiki: no change needed for <page.md>[, <page.md>] - <reason>" on its own
// line; the reason is required, on that same line ([ \t], not \s, so a line
// break never stands in for it).
const PAGE_SKIP_RE = /^[ \t]*wiki:[ \t]*no change needed[ \t]+for[ \t]+([^\r\n]*?)[ \t]+-[ \t]*(\S[^\r\n]*)$/gim;
// The older line that skips every page: "wiki: no change needed - <reason>".
const SKIP_LINE_RE = /^[ \t]*wiki:[ \t]*no change needed[ \t]*-[ \t]*\S/im;
const SKIP_LINE_HINT = "'wiki: no change needed for <page.md> - <reason>'";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n")[0] || `git ${args.join(" ")} failed`);
  return r.stdout;
}

// Files that differ between the merge base with `base` and the working tree:
// committed, staged, unstaged and new untracked files. A moved file counts at
// both its old and its new path (--no-renames). Throws when git can't
// compare (an unknown ref, a shallow clone without the base).
function changedFiles(root, base) {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const files = new Set(git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase]).split("\0"));
  for (const f of git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0")) files.add(f);
  return [...files].filter(Boolean).sort();
}

// What changed in each file since the merge base with `base`:
// [{ file, added, removed, names }], names being the functions or headings
// git's hunk headers give (at most 3). Throws as changedFiles does.
function changeSummary(root, base, files) {
  if (!files.length) return [];
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const untracked = new Set(git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...files]).split("\0").filter(Boolean));
  const counts = new Map();
  for (const line of git(root, ["diff", "--numstat", "--no-renames", mergeBase, "--", ...files]).split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) counts.set(m[3], { added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
  }
  const names = new Map();
  let current = null;
  for (const line of git(root, ["diff", "-U0", "--no-renames", "--no-color", mergeBase, "--", ...files]).split("\n")) {
    const file = /^\+\+\+ b\/(.+)$/.exec(line) || /^--- a\/(.+)$/.exec(line);
    if (file) {
      if (line.startsWith("+++") || !current) current = file[1];
      continue;
    }
    if (line.startsWith("diff --git")) current = null;
    const hunk = /^@@ [^@]+ @@[ \t]*(.*)$/.exec(line);
    if (hunk && current && hunk[1].trim()) {
      if (!names.has(current)) names.set(current, []);
      const list = names.get(current);
      const name = hunkName(hunk[1]);
      if (name && !list.includes(name)) list.push(name);
    }
  }
  return files.map((file) => {
    if (untracked.has(file)) {
      let lines = 0;
      try {
        const text = readText(path.join(root, file));
        lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      } catch {
        // unreadable: no count
      }
      return { file, added: lines, removed: 0, names: [], isNew: true };
    }
    const c = counts.get(file) || { added: 0, removed: 0 };
    return { file, ...c, names: (names.get(file) || []).slice(0, 3) };
  });
}

// A hunk header's context as a short name: "def detect(img):" -> "detect",
// "## Setup" -> "Setup", anything else trimmed to 40 characters.
function hunkName(context) {
  const s = context.trim();
  const heading = /^#+\s+(.+?)\s*#*$/.exec(s);
  if (heading) return heading[1];
  const fn = /\b(?:def|function|func|fn|class|struct|interface|type|module|sub)\s+([A-Za-z_$][\w$.]*)/.exec(s);
  if (fn) return fn[1];
  const assigned = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(s);
  if (assigned) return assigned[1];
  const call = /([A-Za-z_$][\w$]*)\s*\([^)]*\)?\s*[{:]?\s*$/.exec(s);
  if (call && !/^(if|for|while|switch|return|catch)$/.test(call[1])) return call[1];
  return s.length > 40 ? s.slice(0, 39) + "..." : s;
}

// A ref to suggest for 'hypatia check --base <ref>' that exists: origin's
// default branch (build-graph's baseRef), else a local main or master, else
// null (no suggestion).
function suggestedBase(root) {
  const exists = (ref) => spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root, windowsHide: true }).status === 0;
  const remote = require("./build-graph").baseRef(root);
  if (exists(remote)) return remote.replace(/^refs\/remotes\//, "");
  for (const name of ["main", "master"]) if (exists(`refs/heads/${name}`)) return name;
  return null;
}

// Pages with code: [{ path, code }], from the graph plus the private pages the
// published graph leaves out (their code can drift too).
function codePages(root, graph, privatePaths = []) {
  const pages = graph.nodes.filter((n) => (n.code || []).length).map((n) => ({ path: n.path, code: n.code }));
  for (const rel of privatePaths) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    const [fields] = parseFrontMatter(readText(file), rel);
    let code = (fields && fields.code) || [];
    if (typeof code === "string") code = code ? [code] : [];
    if (code.length) pages.push({ path: rel, code });
  }
  return pages;
}

// The skip lines in a pull request description:
// { pages: Map<name as written, reason>, all: bool }. all is the older line
// that skips every page.
function skipLines(prBody = "") {
  const body = prBody || "";
  const pages = new Map();
  for (const m of body.matchAll(PAGE_SKIP_RE)) {
    for (const name of m[1].split(/[,\s]+/).map((s) => s.replace(/^[`'"]+|[`'"]+$/g, "")).filter(Boolean)) {
      pages.set(name, m[2].trim());
    }
  }
  return { pages, all: SKIP_LINE_RE.test(body) };
}

// Whether a name from a skip line means this page: its path, its file name,
// or its name without .md.
function namesPage(name, pagePath) {
  const n = name.replace(/^\.\//, "");
  return n === pagePath || n === path.posix.basename(pagePath) || n + ".md" === path.posix.basename(pagePath);
}

const list = (items, n = 3) => items.slice(0, n).join(", ") + (items.length > n ? ` and ${items.length - n} more` : "");
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const verifyHint = (page) => `then run 'hypatia verify ${page}'`;

// One message for a stale or unverified page. details: the changeSummary
// of its files since base, or null without a base.
function staleMessage(page, stamp, { base = null, details = null, defaultBranch = null } = {}) {
  const skip = `To skip it in this pull request instead, add 'wiki: no change needed for ${page.path} - <reason>'.`;
  const globs = page.code.join(", ");
  if (stamp.state === "unverified") {
    return `${page.path} has never been verified against its code (no verified: line). Reread the files its code: covers (${globs}), make sure the page says what they do, ${verifyHint(page.path)}.`;
  }
  if (details && details.length) {
    const lines = details.map((d) => {
      const size = d.isNew ? `new, ${plural(d.added, "line", "lines")}` : d.added === null ? "binary" : `+${d.added} -${d.removed}`;
      return `    ${d.file} (${size}${d.names.length ? `; ${d.names.join(", ")}` : ""})`;
    });
    return (
      `${page.path} is out of date: its code changed since it was last verified. Changed since ${base}:\n${lines.join("\n")}\n` +
      `  Reread ${details.length === 1 ? "this file" : "these files"}, update the sections of ${page.path} about ${details.length === 1 ? "it" : "them"}, ${verifyHint(page.path)}. ${skip}`
    );
  }
  if (base) {
    return `${page.path} is out of date: its code (${globs}) changed since it was last verified, before ${base}. Reread those files, update the sections of the page about them, ${verifyHint(page.path)}. ${skip}`;
  }
  return `${page.path} is out of date: code changed since last verified (code: ${globs}). Reread those files, update the sections of the page about them, ${verifyHint(page.path)}.${defaultBranch ? ` To see which files changed, run 'hypatia check --base ${defaultBranch}'.` : ""}`;
}

// The drift check for `hypatia check`.
//   mode     "warn" or "error" ("off" returns nothing)
//   base     a ref to list changes against, or null
//   baseAsked  true when base was named by hand: failing to compare is an error
//   prBody   the pull request description (skip lines)
//   defaultBranch  shown in the hint to run with --base (null: no hint)
// Returns { errors, warnings, notes, summary }: notes are plain information,
// summary is a sentence for the "check passed" line.
function driftCheck(root, pages, { mode = "error", base = null, baseAsked = false, prBody = "", defaultBranch = null } = {}) {
  const out = { errors: [], warnings: [], notes: [], summary: "" };
  if (mode === "off") return out;
  const stamps = pageStamps(root, pages);
  const skips = skipLines(prBody);
  if (skips.all) {
    out.warnings.push(
      `the line 'wiki: no change needed - <reason>' skips every page and is going away. Name each page instead: ${SKIP_LINE_HINT}, or, if a page is still right, reread it and run 'hypatia verify <page.md>'.`
    );
  }
  for (const name of skips.pages.keys()) {
    if (!pages.some((p) => namesPage(name, p.path))) out.warnings.push(`the pull request skips '${name}', but no page with code: has that name. Use the page's path, like docs/wiki/<name>.md.`);
  }
  let stale = pages.filter((p) => ["stale", "unverified"].includes(stamps.get(p.path).state));
  const kept = [];
  for (const page of stale) {
    const named = [...skips.pages.keys()].find((n) => namesPage(n, page.path));
    if (named !== undefined) out.notes.push(`${page.path} is out of date but skipped in this pull request: ${skips.pages.get(named)}`);
    else if (!skips.all) kept.push(page);
  }
  if (skips.all && stale.length > kept.length) {
    const left = stale.length - kept.length - out.notes.length;
    if (left > 0) out.notes.push(`${plural(left, "out-of-date page is", "out-of-date pages are")} skipped by the pull request's 'wiki: no change needed' line.`);
  }
  stale = kept;

  let changed = null;
  if (base && stale.length) {
    try {
      changed = changedFiles(root, base);
    } catch (err) {
      const msg = `could not compare this branch with '${base}' (${err.message}). Run 'git fetch origin' (in GitHub Actions, check out with fetch-depth: 0), or pass --base <branch>.`;
      if (baseAsked) out.errors.push(msg);
      else out.warnings.push(`${msg} The stale pages below are listed without what changed.`);
    }
  }
  const messages = stale.map((page) => {
    const stamp = stamps.get(page.path);
    let details = null;
    if (changed && stamp.state === "stale") {
      try {
        details = changeSummary(root, base, changed.filter((f) => matches(f, page.code)));
      } catch {
        details = null;
      }
    }
    return staleMessage(page, stamp, { base: changed ? base : null, details, defaultBranch });
  });
  if (mode === "error") out.errors.push(...messages);
  else out.warnings.push(...messages);

  const total = pages.length;
  if (!total) out.summary = "";
  else if (!stale.length) out.summary = ` ${plural(total, "page matches", "pages match")} the code ${total === 1 ? "it was" : "they were"} last verified against.`;
  else out.summary = ` ${plural(stale.length, "page is", "pages are")} out of date (listed above).`;
  return out;
}

// One message per top-level folder in `roots` that no page's code claims.
// files: every repo file (lint.repoFiles), so ignored folders never count.
function coverageProblems(pages, roots, files, wikiDir = "docs/wiki") {
  const globs = pages.flatMap((p) => p.code);
  const out = [];
  for (const raw of roots) {
    const root = String(raw).trim().replace(/^\.\//, "").replace(/\/+$/, "");
    if (!root) continue;
    const inside = files.filter((f) => f.startsWith(root + "/"));
    if (!inside.length) {
      out.push(`coverage: '${root}' has no files in the repo. Fix the folder name in the config, or remove it.`);
      continue;
    }
    const folders = [...new Set(inside.map((f) => f.slice(root.length + 1)).filter((f) => f.includes("/")).map((f) => f.split("/")[0]))];
    for (const name of folders.filter((n) => !n.startsWith(".")).sort()) {
      const dir = `${root}/${name}`;
      if (matches(dir, globs) || matches(dir + "/", globs) || inside.some((f) => f.startsWith(dir + "/") && matches(f, globs))) continue;
      out.push(`${dir} has no wiki page. Create ${wikiDir}/<name>.md for it with 'code: [${dir}/**]' in its front matter, and link it from its hub page.`);
    }
  }
  return out;
}

module.exports = { suggestedBase, SKIP_LINE_RE, PAGE_SKIP_RE, SKIP_LINE_HINT, changedFiles, changeSummary, hunkName, codePages, skipLines, staleMessage, driftCheck, coverageProblems };
