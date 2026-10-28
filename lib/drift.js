// Two checks that keep the wiki in step with the code, both off until the
// config (docs/hypatia.yml) turns them on:
//
// - drift (`drift: true`): on a pull request, a page whose `code:` paths
//   changed must change too, unless the pull request description has a line
//   "wiki: no change needed - <reason>". `hypatia check --base <ref>` runs it
//   on demand, whatever the config says.
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

// "wiki: no change needed - <reason>" on its own line; the reason is required,
// on that same line ([ \t], not \s, so a line break never stands in for it).
const SKIP_LINE_RE = /^[ \t]*wiki:[ \t]*no change needed[ \t]*-[ \t]*\S/im;
const SKIP_LINE_HINT = "'wiki: no change needed - <reason>'";

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (r.status !== 0) throw new Error((r.stderr || "").trim().split("\n")[0] || `git ${args.join(" ")} failed`);
  return r.stdout;
}

// Files that differ between the merge base with `base` and the working tree:
// committed, staged, unstaged and new untracked files. A moved file counts at
// both its old and its new path (--no-renames), so moving code out of a
// page's folder flags that page too. Throws when git can't
// compare (an unknown ref, a shallow clone without the base).
function changedFiles(root, base) {
  const mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  const files = new Set(git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase]).split("\0"));
  for (const f of git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0")) files.add(f);
  return [...files].filter(Boolean).sort();
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

// One message per page whose code changed while the page did not.
function driftProblems(pages, changed, prBody = "") {
  if (SKIP_LINE_RE.test(prBody || "")) return [];
  const changedSet = new Set(changed);
  const out = [];
  for (const page of pages) {
    const hits = changed.filter((f) => matches(f, page.code));
    if (!hits.length || changedSet.has(page.path)) continue;
    const shown = hits.slice(0, 3).join(", ") + (hits.length > 3 ? ` and ${hits.length - 3} more` : "");
    out.push(`You changed ${shown}, but its wiki page ${page.path} did not change. Update the page, or add ${SKIP_LINE_HINT} to your pull request.`);
  }
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

module.exports = { SKIP_LINE_RE, SKIP_LINE_HINT, changedFiles, codePages, driftProblems, coverageProblems };
