// Builds the wiki's graph data (graph.json) from the pages, git and GitHub,
// for any repo.
//
// Reads README.md (the center page), docs/wiki/*.md and the optional config
// file (docs/hypatia.yml, or the older docs/team.yml; see lib/team.js) from
// the repo it is pointed at.
//
// What goes in:
// - the site title: the config's title, else README.md's first heading, else
//   the repo name;
// - pages, their parent and link edges, backlinks, a one-sentence summary and a
//   fixed 2D position for each page (same input, same positions);
// - the team from git history and GitHub, with the config's overrides, plus
//   the pages each person has worked on (their "past" list and the pages whose
//   code they committed to);
// - from git: each page's last change, the last 40 commits that touched a
//   page or its code, and the active branches (remote branches other than
//   the base branch with a commit in the last 14 days, matched to pages by
//   the files they change);
// - from GitHub, only with a token: open work (issues labelled "wiki:<slug>"
//   and open pull requests, matched to pages by the files they change) and
//   questions (issues labelled "question" + "wiki:<slug>"). Without a token
//   both are empty.
//
// Node built-ins only.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { matches } = require("./globs");
const { splitlines, stripChars, splitMax, parseValue, readText, chars, slugify, cmp } = require("./text");
const { loadConfig, buildTeam, matchPerson, publicPerson, parseConfig } = require("./team");
const { getAll } = require("./github");

// Hub pages name the center page as their parent with this word (or with
// the slug of the site title, e.g. "my-project").
const HOME = "home";
const RECENT_LIMIT = 40;
const BRANCH_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// [text](target) but not images ![alt](src)
const LINK_RE = /(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FENCE_RE = /```[\s\S]*?```/g;

// A problem in the pages that stops the build; the message says what to fix.
class WikiError extends Error {}
const fail = (msg) => {
  throw new WikiError(msg);
};

// ---------------------------------------------------------------- small helpers

// Rounds to 1 decimal, exact halves (only x.25 and x.75 are exact) to even,
// so map positions match earlier builds to the digit.
function round1(x) {
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) {
    const t = x * 10; // exact: ends in .5
    const lo = Math.floor(t);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}

// The real path when the file exists (symlinks followed), else the plain one.
function resolveFile(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// ---------------------------------------------------------------- pages

// Return [fields, body]. Handles 'key: value', 'key: [a, b]' and block lists
// ('key:' then '  - a' lines, as the wiki check and YAML allow).
function parseFrontMatter(text, file) {
  if (!text.startsWith("---")) return [null, text];
  const end = text.indexOf("\n---", 3);
  if (end === -1) fail(`${file} starts a front matter block with '---' but never closes it.`);
  const block = stripChars(text.slice(3, end), "\n");
  const body = text.slice(end + 4).replace(/^\n+/, "");
  const fields = Object.create(null);
  let listKey = null; // the last 'key:' with nothing after it
  for (let line of splitlines(block)) {
    line = line.split(" #")[0].trimEnd(); // drop trailing comments
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const stripped = line.trim();
    if (listKey !== null && (stripped.startsWith("- ") || stripped === "-")) {
      if (!Array.isArray(fields[listKey])) fields[listKey] = [];
      const item = stripChars(stripped.slice(1).trim(), "'\"");
      if (item) fields[listKey].push(item);
      continue;
    }
    if (!line.includes(":")) fail(`${file}: cannot read front matter line '${line}'.`);
    const [key, value] = splitMax(line, ":", 1);
    fields[key.trim()] = parseValue(value);
    listKey = fields[key.trim()] === "" ? key.trim() : null;
  }
  return [fields, body];
}

// README.md (any case), or where it would be.
function readmeFile(root) {
  let names = [];
  try {
    names = fs.readdirSync(root).filter((n) => /^readme\.md$/i.test(n)).sort();
  } catch {
    // no folder: nothing to read
  }
  return path.join(root, names.includes("README.md") || !names.length ? "README.md" : names[0]);
}

// A heading as plain text: no images, links, emphasis, code marks or tags.
function plainTitle(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(?<![\p{L}\p{N}_])[*_]([^*_]+)[*_](?![\p{L}\p{N}_])/gu, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// The README's first heading with words in it ("# Title", "Title\n===" or
// <h1>), or "".
function readmeTitle(markdown) {
  const lines = markdown.replace(FENCE_RE, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let text = null;
    const atx = /^#\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    const html = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(line);
    if (atx) text = atx[1];
    else if (html) text = html[1];
    else if (line.trim() && /^=+\s*$/.test(lines[i + 1] || "")) text = line;
    if (text !== null && plainTitle(text)) return plainTitle(text);
  }
  return "";
}

// The site's name, the same everywhere it is shown: the config's title, else
// README.md's first heading, else the repo's name on GitHub, else the folder's
// name. repo is owner/name (default: from the origin remote).
function siteTitle(root, { config, markdown, repo } = {}) {
  if (config === undefined) config = loadConfig(root);
  if (markdown === undefined) {
    const readme = readmeFile(root);
    markdown = fs.existsSync(readme) ? readText(readme) : "";
  }
  if (repo === undefined) repo = repoSlug(root);
  return config.title || readmeTitle(markdown) || (repo ? repo.split("/")[1] : "") || path.basename(path.resolve(root));
}

function loadPages(ctx) {
  const readme = ctx.readme;
  const markdown = fs.existsSync(readme) ? readText(readme) : "";
  ctx.title = siteTitle(ctx.root, { config: ctx.config, markdown, repo: ctx.repo });
  const names = fs
    .readdirSync(ctx.wiki, { withFileTypes: true })
    .filter((e) => e.name.endsWith(".md") && !e.isDirectory())
    .map((e) => e.name)
    .sort();
  const wiki = [];
  for (const name of names) {
    const file = path.join(ctx.wiki, name);
    const [fields, body] = parseFrontMatter(readText(file), ctx.rel(file));
    if (fields === null) continue; // not a wiki page (no front matter)
    const slug = name.slice(0, -3);
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
      fail(`${ctx.rel(file)}: page names must be lowercase words joined by '-'.`);
    }
    if (!("title" in fields) || !("parent" in fields)) {
      fail(`${ctx.rel(file)}: front matter needs both 'title' and 'parent'.`);
    }
    let code = "code" in fields ? fields.code : [];
    if (typeof code === "string") code = code ? [code] : [];
    const hidden = typeof fields.private === "string" && /^(true|yes|on)$/i.test(fields.private);
    wiki.push({ id: slug, title: fields.title, parent: fields.parent, code, file, markdown: body, private: hidden });
  }
  // The center page's id: the title's slug ("my-project"), or "home" when
  // that is taken by a page. Hubs may name it either way.
  const slugs = new Set(wiki.map((p) => p.id));
  const titleSlug = slugify(ctx.title);
  ctx.center = titleSlug && !slugs.has(titleSlug) ? titleSlug : HOME;
  ctx.centerNames = [HOME, titleSlug].filter((x) => x && !slugs.has(x));
  const pages = new Map();
  pages.set(ctx.center, { id: ctx.center, title: ctx.title, parent: null, code: [], file: readme, markdown });
  for (const page of wiki) {
    if (ctx.centerNames.includes(page.parent)) page.parent = ctx.center;
    pages.set(page.id, page);
  }
  return pages;
}

// Pages marked `private: true`, and every page under them, show in the local
// site only. With ctx.publish they are taken out before anything else is
// worked out (links, backlinks, history, work, search), and a link to one from
// a published page becomes its plain text, so nothing published names them.
// Without it they stay, marked private. Returns the pages to build with.
function privatePages(pages, ctx) {
  const hidden = new Set();
  for (const [pid, page] of pages) {
    const seen = new Set();
    for (let x = page; x && !seen.has(x.id); x = pages.get(x.parent)) {
      seen.add(x.id);
      if (x.private) {
        hidden.add(pid);
        break;
      }
    }
  }
  for (const pid of hidden) pages.get(pid).private = true;
  if (!ctx.publish || !hidden.size) return pages;
  const hiddenFiles = new Set([...hidden].map((pid) => resolveFile(pages.get(pid).file)));
  const kept = new Map();
  for (const [pid, page] of pages) {
    if (hidden.has(pid)) {
      ctx.excluded.push({ id: pid, path: ctx.rel(page.file) });
      continue;
    }
    kept.set(pid, { ...page, markdown: unlinkFiles(page.markdown, page.file, hiddenFiles) });
  }
  return kept;
}

// The markdown with links to these files turned into their plain text
// (code blocks left as they are).
function unlinkFiles(markdown, from, files) {
  const link = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  return markdown
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part.replace(link, (whole, text, target) => {
            if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return whole;
            const file = resolveFile(path.resolve(path.dirname(from), target.split("#")[0]));
            return files.has(file) ? text : whole;
          })
    )
    .join("");
}

// A Markdown link whose file does not exist. The wiki owns its pages and its
// folder, so a wiki page's link, or any link into the wiki folder, must
// resolve: the build stops (with ctx.brokenLinks, as in `hypatia serve`, it
// is listed instead and the site shows the link as missing). README.md belongs
// to the project, so its links to other repo files only warn.
function brokenLink(page, target, resolved, ctx) {
  const from = ctx.rel(page.file);
  const where = ctx.rel(resolved);
  const intoWiki = (where + "/").startsWith(ctx.rel(ctx.wiki) + "/");
  if (page.parent === null && !intoWiki) {
    ctx.warn(`${from} links to '${target}', but there is no such file in the repo.`);
    return;
  }
  const message = `${from} links to '${target}', but that page does not exist.`;
  if (!ctx.brokenLinks) fail(message);
  if (!ctx.brokenLinks.some((b) => b.message === message)) ctx.brokenLinks.push({ from, target, path: where, message });
}

// Return { edges, backlinks }. backlinks[slug] = sorted pages that link to it.
function collectEdges(pages, ctx) {
  const edges = [];
  const seen = new Set();
  const backlinks = new Map([...pages.keys()].map((id) => [id, new Set()]));
  const key = (a, b) => a + "\0" + b;
  const add = (source, target, kind) => {
    if (source === target || seen.has(key(source, target))) return;
    seen.add(key(source, target));
    edges.push({ source, target, kind });
  };

  for (const [pid, page] of pages) {
    if (page.parent !== null) {
      if (!pages.has(page.parent)) {
        fail(
          `${ctx.rel(page.file)} says its parent is '${page.parent}', but there is no page called '${page.parent}'. ` +
            `Hub pages use 'parent: ${HOME}'.`
        );
      }
      add(page.parent, pid, "parent");
    }
  }

  // a resolved file path -> its page id
  const byFile = new Map();
  for (const [pid, page] of pages) if (!byFile.has(resolveFile(page.file))) byFile.set(resolveFile(page.file), pid);

  for (const [pid, page] of pages) {
    const text = page.markdown.replace(FENCE_RE, "");
    for (const m of text.matchAll(LINK_RE)) {
      let target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue; // web link or same-page anchor
      target = target.split("#")[0];
      if (!target.endsWith(".md")) continue;
      const resolved = resolveFile(path.resolve(path.dirname(page.file), target));
      const tid = byFile.get(resolved);
      if (tid === undefined) {
        if (!fs.existsSync(resolved)) brokenLink(page, target, resolved, ctx);
        // A normal repo doc, not a wiki page. That includes Markdown in the
        // wiki folder without front matter (say, an older GitHub-style wiki).
        continue;
      }
      if (tid !== pid) backlinks.get(tid).add(pid);
      if (!seen.has(key(pid, tid)) && !seen.has(key(tid, pid))) add(pid, tid, "link");
    }
  }
  const sorted = new Map([...backlinks].map(([k, v]) => [k, [...v].sort()]));
  return { edges, backlinks: sorted };
}

function hubAndDepth(pid, pages, center) {
  const chain = [pid];
  while (pages.get(chain[chain.length - 1]).parent !== null) {
    const next = pages.get(chain[chain.length - 1]).parent;
    if (chain.includes(next)) {
      fail(`the parents of '${pid}' loop back on themselves: ${chain.concat(next).join(" > ")}.`);
    }
    chain.push(next);
  }
  if (chain[chain.length - 1] !== center) {
    fail(`'${pid}' does not hang from the home page (its top parent is '${chain[chain.length - 1]}').`);
  }
  const depth = chain.length - 1;
  const hub = depth >= 1 ? chain[chain.length - 2] : null;
  return [hub, depth];
}

// First sentence of the page's prose, as plain text.
function summarize(markdown, limit = 240) {
  let text = markdown.replace(FENCE_RE, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  for (let para of text.split(/\n\s*\n/)) {
    para = para.trim();
    if (!para || "#|>-*!<".includes(para[0]) || /^\d+\.\s/.test(para) || para.startsWith("Part of:")) continue;
    para = para.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    para = para.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    para = para.replace(/`([^`]*)`/g, "$1");
    para = para.replace(/(\*\*|__)(.+?)\1/g, "$2");
    para = para.replace(/(?<![\p{L}\p{N}_*])\*([^*]+)\*(?![\p{L}\p{N}_*])/gu, "$1");
    para = para.split(/\s+/).filter(Boolean).join(" ");
    if (!para) continue;
    // First sentence; a very short one ("Welcome!") takes the next one too.
    const parts = para.match(/.+?[.!?](?=\s|$)|.+$/g);
    let sentence = parts[0].trim();
    if (chars(sentence).length < 25 && parts.length > 1) sentence += " " + parts[1].trim();
    if (chars(sentence).length > limit) sentence = chars(sentence).slice(0, limit - 3).join("").trimEnd() + "...";
    return sentence;
  }
  return "";
}

// ---------------------------------------------------------------- layout

// Fixed 2D positions: the center page at 0,0, hubs evenly on a ring, each
// hub's pages in a fan pointing away from the center, then a fixed number of
// push-apart passes.
//
// nodes: list of {id, parent, depth}. Returns {id: [x, y]}.
// Deterministic: inputs are sorted and every step is plain arithmetic.
function layout(nodes, { ring = 320.0, step = 95.0, minDist = 58.0, iterations = 120 } = {}) {
  const children = new Map();
  for (const n of nodes.slice().sort((a, b) => cmp(a.id, b.id))) {
    if (n.parent !== null && n.parent !== undefined) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n.id);
    }
  }
  const hubs = nodes.filter((n) => n.depth === 1).map((n) => n.id).sort(cmp);
  const center = nodes.find((n) => n.depth === 0);
  const pos = new Map(center ? [[center.id, [0.0, 0.0]]] : []);
  const fixed = new Set([...pos.keys(), ...hubs]);
  hubs.forEach((hub, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(hubs.length, 1);
    pos.set(hub, [ring * Math.cos(a), ring * Math.sin(a)]);
  });

  function place(parent, angle, spread) {
    const kids = children.get(parent) || [];
    if (!kids.length) return;
    const [px, py] = pos.get(parent);
    // Rows of up to 5 per arc, further rows further out.
    const perRow = 5;
    kids.forEach((kid, k) => {
      const row = Math.floor(k / perRow);
      const col = k % perRow;
      const inRow = Math.min(perRow, kids.length - row * perRow);
      const t = inRow === 1 ? 0.0 : col / (inRow - 1) - 0.5;
      const a = angle + t * spread;
      const r = step * (1 + row * 0.8);
      pos.set(kid, [px + r * Math.cos(a), py + r * Math.sin(a)]);
      place(kid, a, spread * 0.6);
    });
  }

  for (const hub of hubs) {
    const [hx, hy] = pos.get(hub);
    place(hub, Math.atan2(hy, hx), (150 * Math.PI) / 180);
  }
  // Anything not reached (should not happen) sits in the center.
  for (const n of nodes) if (!pos.has(n.id)) pos.set(n.id, [0.0, 0.0]);

  const order = [...pos.keys()].sort(cmp);
  for (let it = 0; it < iterations; it++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = order[i];
        const b = order[j];
        const [ax, ay] = pos.get(a);
        const [bx, by] = pos.get(b);
        let dx = bx - ax;
        let dy = by - ay;
        let d = Math.hypot(dx, dy);
        if (d >= minDist) continue;
        if (d < 1e-6) [dx, dy, d] = [1.0, 0.0, 1.0]; // exactly on top: push along a fixed direction
        const push = (minDist - d) / 2;
        const ux = (dx / d) * push;
        const uy = (dy / d) * push;
        if (fixed.has(a) && fixed.has(b)) continue;
        if (fixed.has(a)) pos.set(b, [bx + 2 * ux, by + 2 * uy]);
        else if (fixed.has(b)) pos.set(a, [ax - 2 * ux, ay - 2 * uy]);
        else {
          pos.set(a, [ax - ux, ay - uy]);
          pos.set(b, [bx + ux, by + uy]);
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
  const out = {};
  for (const [k, [x, y]] of pos) out[k] = [round1(x), round1(y)];
  return out;
}

// ---------------------------------------------------------------- git

function git(ctx, args) {
  const r = spawnSync("git", args, { cwd: ctx.root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || "").replace(/\r\n?/g, "\n") };
}

// Pages whose own file or code globs cover any of these repo paths.
function pagesForFiles(files, pages, ctx) {
  const hit = [];
  for (const [pid, page] of pages) {
    const own = ctx.rel(page.file);
    if (files.some((f) => f === own || (page.code.length && matches(f, page.code)))) hit.push(pid);
  }
  return hit.sort(cmp);
}

// Commits newest first: {sha, date, author, email, message, files}.
//
// allBranches adds every remote branch, so work that hasn't reached the base
// yet (a teammate's feature branch) still counts as something they worked on.
function gitCommits(ctx, { limit = 3000, allBranches = false } = {}) {
  const refs = allBranches ? ["HEAD", "--remotes"] : [];
  const r = git(ctx, ["log", ...refs, `-${limit}`, "--no-merges", "--format=%x1e%H%x1f%aI%x1f%an%x1f%ae%x1f%s", "--name-only"]);
  if (!r.ok) {
    // a brand-new repo with no commits has no history to read: nothing to say
    if (git(ctx, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok) ctx.warn("git log failed; building without history.");
    return [];
  }
  const commits = [];
  for (const chunk of r.out.split("\x1e")) {
    if (!chunk.trim()) continue;
    const [head, rest = ""] = splitMax(chunk, "\n", 1);
    const [sha, date, author, email, message] = splitMax(head, "\x1f", 4);
    const files = splitlines(rest).filter((f) => f.trim());
    commits.push({ sha, date, author, email, message, files });
  }
  return commits;
}

// Return { last: last change by page, recent: list }.
function history(commits, pages, people, ctx) {
  const last = new Map();
  const recent = [];
  for (const c of commits) {
    const touched = pagesForFiles(c.files, pages, ctx);
    if (!touched.length) continue;
    const entry = {
      sha: c.sha,
      date: c.date,
      author: c.author,
      person: matchPerson(people, { name: c.author, email: c.email }),
      message: c.message,
    };
    for (const pid of touched) if (!last.has(pid)) last.set(pid, entry);
    if (recent.length < RECENT_LIMIT) recent.push({ ...entry, pages: touched });
  }
  return { last, recent };
}

// Writing about code is not working on it: docs and text files don't count.
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const BULK_COMMIT_FILES = 60;
const isWork = (f) => !DOC_FILE.test(f);

// Files and folders that moved, from git's rename detection on the base
// history: returns f -> where f lives today. Work on a branch, or in old
// commits, made before a folder moved then lands on today's pages.
//
// A whole folder move (old/pkg/x -> new/pkg/x) also maps files that were
// never in the move (a branch's new old/pkg/y), as long as old/pkg is gone.
function gitRenames(ctx) {
  const r = git(ctx, ["log", "-3000", "-M", "-l5000", "--diff-filter=R", "--name-status", "--format=%x1e", "HEAD"]);
  const files = new Map();
  const dirs = new Map();
  if (r.ok) {
    const moves = [];
    for (const line of splitlines(r.out)) {
      const m = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line);
      if (m) moves.push([m[1], m[2]]);
    }
    for (const [from, to] of moves.reverse()) {
      // oldest first, so a later move of the same path wins
      files.set(from, to);
      const a = from.split("/");
      const b = to.split("/");
      let k = 0;
      while (k < Math.min(a.length, b.length) && a[a.length - 1 - k] === b[b.length - 1 - k]) k++;
      if (k < 2) continue; // only the file name is shared: not a folder move
      const oldDir = a.slice(0, a.length - k + 1).join("/") + "/";
      const newDir = b.slice(0, b.length - k + 1).join("/") + "/";
      if (oldDir !== newDir) dirs.set(oldDir, newDir);
    }
  }
  const prefixes = [...dirs.keys()].filter((d) => !fs.existsSync(path.join(ctx.root, d))).sort((x, y) => y.length - x.length);
  return (f) => {
    for (let i = 0; i < 20; i++) {
      // follow chains of moves (a -> b -> c)
      let next = files.get(f);
      if (next === undefined) {
        const d = prefixes.find((p) => f.startsWith(p));
        next = d ? dirs.get(d) + f.slice(d.length) : undefined;
      }
      if (next === undefined || next === f) break;
      f = next;
    }
    return f;
  };
}

// Pages each person has worked on, from git: {person id: [slug, ...]}.
//
// A commit counts for a page when it touches files (not docs) that the
// page's code: paths cover, at their path today (ctx.moved). Docs, wiki
// edits and bulk moves don't count: writing about a program or moving
// folders isn't working on it. Pages are sorted by that person's commit
// count (ties by slug), top `limit`. The center page is left out: everyone
// edits it.
function contributions(commits, pages, people, ctx, limit = 8) {
  const counts = new Map(people.map((p) => [p.id, new Map()]));
  const moved = ctx.moved || ((f) => f);
  for (const c of commits) {
    const pid = matchPerson(people, { name: c.author, email: c.email });
    if (pid === null) continue;
    if (c.files.length > BULK_COMMIT_FILES) continue; // a repo-wide move or cleanup says nothing about who works on what
    const codeFiles = c.files.map(moved).filter(isWork);
    for (const page of pagesForFiles(codeFiles, pages, ctx)) {
      if (page !== ctx.center) counts.get(pid).set(page, (counts.get(pid).get(page) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [pid, cs] of counts) {
    const ranked = [...cs].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    out.set(pid, ranked.slice(0, limit).map(([s]) => s));
  }
  return out;
}

// ---------------------------------------------------------------- branches

// Sandbox branches people pushed lately, newest first.
//
// refs: [{name, sha, date, author, email, message}] for each remote branch
// tip (date is the tip's commit date). Branches whose tip is older than
// `days`, and branches with nothing the base lacks (already merged), are
// left out. info(name) -> [ahead, files]: commits not on the base, and the
// files changed since the branch left it. Files in a folder that has moved
// since land on today's pages, as in contributions().
function activeBranches(refs, pages, people, work, now, info, ctx, days = BRANCH_DAYS) {
  const cutoff = now - days * DAY_MS;
  const moved = ctx.moved || ((f) => f);
  const prs = new Map();
  for (const w of work) if (w.kind === "pr" && w.branch) prs.set(w.branch, w);
  const out = [];
  for (const ref of refs) {
    if (Date.parse(ref.date) < cutoff) continue;
    const [ahead, files] = info(ref.name);
    if (!ahead) continue;
    const pr = prs.get(ref.name);
    out.push({
      name: ref.name,
      person: matchPerson(people, { name: ref.author, email: ref.email }),
      author: ref.author,
      last_commit: { sha: ref.sha, date: ref.date, message: ref.message },
      ahead,
      pages: pagesForFiles(files.map(moved), pages, ctx),
      pr: pr ? { number: pr.number, url: pr.url } : null,
    });
  }
  out.sort((a, b) => Date.parse(b.last_commit.date) - Date.parse(a.last_commit.date));
  return out;
}

// Tips of the origin branches other than the base: list of ref objects.
function gitBranchRefs(ctx) {
  const fmt = "%(refname)%1f%(objectname)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(authoremail)%1f%(subject)";
  const r = git(ctx, ["for-each-ref", "refs/remotes/origin", `--format=${fmt}`]);
  if (!r.ok) {
    ctx.warn("git for-each-ref failed; building without active branches.");
    return [];
  }
  const refs = [];
  for (const line of splitlines(r.out)) {
    const parts = splitMax(line, "\x1f", 5);
    if (parts.length !== 6) continue;
    const [refname, sha, date, author, email, message] = parts;
    if (refname === ctx.baseRef || refname.endsWith("/HEAD")) continue;
    refs.push({ name: refname.slice("refs/remotes/origin/".length), sha, date, author, email: stripChars(email, "<>"), message });
  }
  return refs;
}

// [commits not on the base, files changed since the merge base].
function gitBranchInfo(ctx, name) {
  const ref = `refs/remotes/origin/${name}`;
  const count = git(ctx, ["rev-list", "--count", `${ctx.baseRef}..${ref}`]);
  const diff = git(ctx, ["diff", "--name-only", `${ctx.baseRef}...${ref}`]);
  if (!count.ok || !diff.ok) return [0, []];
  return [parseInt(count.out.trim() || "0", 10), splitlines(diff.out).filter((f) => f.trim())];
}

function fetchBranches(pages, people, work, ctx) {
  if (!git(ctx, ["rev-parse", "--verify", "--quiet", ctx.baseRef]).ok) {
    // no origin yet (a repo that was never pushed): no branches to show, quietly
    if (git(ctx, ["remote", "get-url", "origin"]).ok) ctx.warn(`no ${ctx.baseRef}; building without active branches.`);
    return [];
  }
  return activeBranches(gitBranchRefs(ctx), pages, people, work, Date.now(), (name) => gitBranchInfo(ctx, name), ctx);
}

// ---------------------------------------------------------------- GitHub

function wikiPagesFromLabels(labels, pages) {
  const out = new Set();
  for (const label of labels || []) {
    const name = label && typeof label === "object" ? label.name || "" : label;
    if (name.startsWith("wiki:") && pages.has(name.slice(5))) out.add(name.slice(5));
  }
  return [...out].sort(cmp);
}

function labelNames(item) {
  return new Set((item.labels || []).map((lb) => (lb && typeof lb === "object" ? lb.name || "" : lb)));
}

const login = (x) => ((x && x.user) || {}).login || "";

// A question record, or null if the issue is not a question on a page.
function questionFromIssue(issue, comments, pages, excerpt = 280) {
  const names = labelNames(issue);
  if (!names.has("question")) return null;
  const on = wikiPagesFromLabels(issue.labels, pages);
  if (!on.length) return null;
  const asker = login(issue);
  const answer = comments.find((c) => login(c) !== asker && !login(c).endsWith("[bot]")) || null;
  let text = ((answer || {}).body || "").split(/\s+/).filter(Boolean).join(" ");
  if (chars(text).length > excerpt) text = chars(text).slice(0, excerpt - 3).join("").trimEnd() + "...";
  return {
    number: issue.number,
    title: issue.title || "",
    url: issue.html_url || "",
    page: on[0],
    asker,
    answered: answer !== null || names.has("answered"),
    answer_excerpt: text,
    updated_at: issue.updated_at || "",
  };
}

function assignees(item, people) {
  const ids = [];
  for (const a of item.assignees || []) {
    const pid = matchPerson(people, { login: a.login });
    if (pid && !ids.includes(pid)) ids.push(pid);
  }
  return ids;
}

function workFromIssue(issue, pages, people) {
  const on = wikiPagesFromLabels(issue.labels, pages);
  if (!on.length || labelNames(issue).has("question")) return null;
  const author = login(issue);
  return {
    kind: "issue",
    number: issue.number,
    title: issue.title || "",
    url: issue.html_url || "",
    author,
    person: matchPerson(people, { login: author }),
    assignees: assignees(issue, people),
    pages: on,
    review_requested: false,
    draft: false,
    updated_at: issue.updated_at || "",
  };
}

function workFromPr(pr, files, pages, people, ctx, repo = null) {
  const author = login(pr);
  const head = pr.head || {};
  const headRepo = ((head.repo || {}).full_name || "").toLowerCase();
  // Only a branch in this repo can match an active branch; a fork's "main" is not ours.
  const branch = head.ref && (repo === null || headRepo === repo.toLowerCase()) ? head.ref : null;
  const on = [...new Set([...pagesForFiles(files, pages, ctx), ...wikiPagesFromLabels(pr.labels, pages)])].sort(cmp);
  const review = !!(
    (pr.requested_reviewers && pr.requested_reviewers.length) ||
    (pr.requested_teams && pr.requested_teams.length) ||
    labelNames(pr).has("review")
  );
  return {
    kind: "pr",
    number: pr.number,
    title: pr.title || "",
    url: pr.html_url || "",
    author,
    person: matchPerson(people, { login: author }),
    assignees: assignees(pr, people),
    pages: on,
    review_requested: review,
    draft: !!pr.draft,
    branch,
    updated_at: pr.updated_at || "",
  };
}

// Return { work, questions, read }. Empty lists without a token or on
// errors; read says whether GitHub was read.
async function fetchGithub(pages, people, ctx) {
  const { token, repo } = ctx;
  if (!token || !repo) return { work: [], questions: [], read: false };
  const work = [];
  const questions = [];
  try {
    for (const issue of await getAll(token, repo, "issues?state=open&per_page=100")) {
      if ("pull_request" in issue) continue;
      const w = workFromIssue(issue, pages, people);
      if (w) work.push(w);
    }
    for (const pr of await getAll(token, repo, "pulls?state=open&per_page=100")) {
      const files = (await getAll(token, repo, `pulls/${pr.number}/files?per_page=100`)).map((f) => f.filename);
      work.push(workFromPr(pr, files, pages, people, ctx, repo));
    }
    for (const issue of await getAll(token, repo, "issues?state=all&labels=question&per_page=100")) {
      if ("pull_request" in issue) continue;
      const comments = issue.comments ? await getAll(token, repo, `issues/${issue.number}/comments?per_page=100`) : [];
      const q = questionFromIssue(issue, comments, pages);
      // A closed question nobody answered is dropped, not shown forever.
      if (q && (issue.state === "open" || q.answered)) questions.push(q);
    }
  } catch (err) {
    ctx.warn(`could not read GitHub (${err.message}); building without work and questions.`);
    return { work: [], questions: [], read: false };
  }
  work.sort((a, b) => cmp(b.updated_at, a.updated_at));
  questions.sort((a, b) => cmp(b.updated_at, a.updated_at));
  return { work, questions, read: true };
}

// ---------------------------------------------------------------- repo facts

// owner/name from the origin remote (works for https, ssh and ssh host aliases), or null.
function repoSlug(root) {
  const r = git({ root }, ["remote", "get-url", "origin"]);
  const m = /github\.com[^:/]*[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(r.out.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// The remote branch new work starts from: origin's default branch, else
// origin/master or origin/main, else refs/remotes/origin/master.
function baseRef(root) {
  const head = git({ root }, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const name of ["master", "main"]) {
    const ref = `refs/remotes/origin/${name}`;
    if (git({ root }, ["rev-parse", "--verify", "--quiet", ref]).ok) return ref;
  }
  return "refs/remotes/origin/master";
}

// Branch the "View on GitHub" links point at, and whether GitHub has it yet.
//
// WIKI_BRANCH wins (the Pages workflow sets it to the default branch, since
// it also runs on issue and pull request events). Then GITHUB_REF_NAME on a
// push. Locally it is the current branch, and links stay off until that
// branch exists on origin, so a preview never sends people to a 404.
function githubBranch(ctx) {
  if (ctx.env.WIKI_BRANCH) return [ctx.env.WIKI_BRANCH, true];
  if (ctx.env.GITHUB_REF_NAME) return [ctx.env.GITHUB_REF_NAME, true];
  const head = git(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = (head.ok && head.out.trim()) || "master";
  return [branch, git(ctx, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).ok];
}

// ---------------------------------------------------------------- build

// Everything about the repo being built, in one place.
//   root     the repo folder
//   token    GitHub read token, or null (no work, questions or GitHub team then)
//   repo     owner/name; defaults to GITHUB_REPOSITORY, then the origin remote
//   env      environment for WIKI_BRANCH / GITHUB_REF_NAME (default process.env)
//   warn     called with each warning (default: printed to stderr)
//   publish  true for a site that goes on the web: private pages are left out
//   excluded a list that gets {id, path} for each page left out that way
//   brokenLinks  "warn": a link to a page that does not exist is listed in
//            the graph's `missing` instead of stopping the build (for serve)
// loadPages adds title and center (the center page's id).
function context(opts) {
  const root = path.resolve(opts.root);
  const env = opts.env || process.env;
  const warn = opts.warn || ((msg) => console.error(`hypatia: ${msg}`));
  const ctx = {
    root,
    env,
    wiki: path.join(root, "docs", "wiki"),
    readme: readmeFile(root),
    config: loadConfig(root, warn),
    token: opts.token || null,
    repo: opts.repo || env.GITHUB_REPOSITORY || repoSlug(root),
    baseRef: opts.baseRef || baseRef(root),
    warn,
    publish: !!opts.publish,
    excluded: opts.excluded || [],
    brokenLinks: opts.brokenLinks === "warn" ? [] : null,
    rel: (file) => path.relative(root, file).split(path.sep).join("/"),
    title: "",
    center: HOME,
  };
  return ctx;
}

async function buildGraph(opts) {
  const ctx = context(opts);
  if (!fs.existsSync(ctx.wiki) || !fs.statSync(ctx.wiki).isDirectory()) fail(`no wiki folder at ${ctx.rel(ctx.wiki)}.`);
  const pages = privatePages(loadPages(ctx), ctx);
  const { edges, backlinks } = collectEdges(pages, ctx);
  const allCommits = gitCommits(ctx, { allBranches: true });
  const people = await buildTeam(ctx, allCommits, ctx.config);
  ctx.moved = gitRenames(ctx);
  const { last, recent } = history(gitCommits(ctx), pages, people, ctx);
  const contributed = contributions(allCommits, pages, people, ctx);
  for (const p of people) {
    const left = new Set(ctx.excluded.map((e) => e.id)); // private pages: no warning, just left out
    const unknown = p.past.filter((s) => !pages.has(s) && !left.has(s));
    if (unknown.length) ctx.warn(`${ctx.config.file}: ${p.id} has past pages that do not exist: ${unknown.join(", ")}.`);
    p.past = p.past.filter((s) => pages.has(s));
    p.contributed = contributed.get(p.id) || [];
    p.worked_on = [...new Set([...p.past, ...p.contributed])];
  }
  const { work, questions, read } = await fetchGithub(pages, people, ctx);
  const branches = fetchBranches(pages, people, work, ctx);

  const nodes = [];
  for (const [pid, page] of pages) {
    const [hub, depth] = hubAndDepth(pid, pages, ctx.center);
    nodes.push({
      id: pid,
      title: page.title,
      parent: page.parent,
      hub,
      depth,
      code: page.code,
      path: ctx.rel(page.file),
      markdown: page.markdown,
      summary: summarize(page.markdown),
      x: 0.0,
      y: 0.0,
      backlinks: backlinks.get(pid) || [],
      last_change: last.get(pid) || null,
      ...(page.private ? { private: true } : {}),
    });
  }
  const positions = layout(nodes);
  for (const n of nodes) [n.x, n.y] = positions[n.id];

  const [branch, published] = githubBranch(ctx);
  return {
    version: 3,
    title: ctx.title, // the site's name
    center: ctx.center, // id of the center page (README.md)
    branch,
    base: ctx.baseRef.split("/").pop(), // the main branch new work starts from
    published,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    repo: ctx.repo,
    github: read, // whether open work and questions were read from GitHub
    people: people.map((p) => ({ ...publicPerson(p), contributed: p.contributed, worked_on: p.worked_on })),
    nodes,
    edges,
    work,
    questions,
    recent,
    branches,
    ...(ctx.brokenLinks && ctx.brokenLinks.length ? { missing: ctx.brokenLinks } : {}),
  };
}

// One line about what was built, for the terminal.
function describe(graph) {
  const links = graph.edges.filter((e) => e.kind === "link").length;
  const prs = graph.work.filter((w) => w.kind === "pr").length;
  return (
    `${graph.nodes.length} pages, ${graph.edges.length - links} parent edges, ${links} cross links, ` +
    `${graph.people.length} people, ${graph.recent.length} recent commits, ${graph.work.length - prs} work issues, ` +
    `${prs} open PRs, ${graph.questions.length} questions, ${graph.branches.length} active branches.`
  );
}

module.exports = {
  HOME,
  WikiError,
  buildGraph,
  describe,
  repoSlug,
  baseRef,
  siteTitle,
  // the parts below are exported for the tests
  parseFrontMatter,
  parseConfig,
  matchPerson,
  readmeTitle,
  summarize,
  layout,
  round1,
  pagesForFiles,
  contributions,
  activeBranches,
  questionFromIssue,
  workFromIssue,
  workFromPr,
  context,
  gitRenames,
  BULK_COMMIT_FILES,
};
