// Builds the wiki's graph data (graph.json, version 2) from the pages, git
// and GitHub. A Node port of go2-fusion's scripts/wiki/build_graph.py: the
// same input gives the same output (test/parity.test.js checks that).
//
// Reads README.md (the center node "oak"), docs/wiki/*.md and docs/team.yml
// from the repo it is pointed at.
//
// What goes in:
// - pages, their parent and link edges, backlinks, a one-sentence summary and a
//   fixed 2D position for each page (same input, same positions);
// - the team from docs/team.yml, plus the pages each person has worked on
//   (their "past" list and the pages whose code or file they committed to);
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

const CENTER = "oak";
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

// Python's str.splitlines(): no empty last line after a final newline.
function splitlines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// Python's str.strip(chars) for a set of characters.
function stripChars(s, chars) {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

// Python's str.split(sep, max): the last piece keeps the rest.
function splitMax(s, sep, max) {
  const out = [];
  let rest = s;
  while (out.length < max) {
    const i = rest.indexOf(sep);
    if (i < 0) break;
    out.push(rest.slice(0, i));
    rest = rest.slice(i + sep.length);
  }
  out.push(rest);
  return out;
}

// Text files read the way Python reads them: \r\n and \r become \n.
// A byte order mark (some Windows editors add one) is dropped, or the page's
// front matter would not be found and the page would silently disappear.
const readText = (file) => fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

// Lengths and cuts by character, not UTF-16 unit, so emoji count as one.
const chars = (s) => Array.from(s);

// Python's round(x, 1): exact halves (only x.25 and x.75 are exact) go to even.
function round1(x) {
  if (Number.isInteger(x * 4) && !Number.isInteger(x * 2)) {
    const t = x * 10; // exact: ends in .5
    const lo = Math.floor(t);
    return (lo % 2 === 0 ? lo : lo + 1) / 10;
  }
  return Number(x.toFixed(1));
}

// Like Path.resolve(): follows symlinks when the file exists.
function resolveFile(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// "key: value" or "key: [a, b]", with the same quote stripping as front matter.
function parseValue(value) {
  value = value.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .filter((v) => v.trim())
      .map((v) => stripChars(v.trim(), "'\""));
  }
  return stripChars(value, "'\"");
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

function loadPages(ctx) {
  const pages = new Map();
  const readme = path.join(ctx.root, "README.md");
  pages.set(CENTER, {
    id: CENTER,
    title: "Oak",
    parent: null,
    code: [],
    file: readme,
    markdown: readText(readme),
  });
  const names = fs
    .readdirSync(ctx.wiki, { withFileTypes: true })
    .filter((e) => e.name.endsWith(".md") && !e.isDirectory())
    .map((e) => e.name)
    .sort();
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
    pages.set(slug, { id: slug, title: fields.title, parent: fields.parent, code, file, markdown: body });
  }
  return pages;
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
        fail(`${ctx.rel(page.file)} says its parent is '${page.parent}', but there is no page called '${page.parent}'.`);
      }
      add(page.parent, pid, "parent");
    }
  }

  // a resolved file path -> its page id
  const byFile = new Map();
  for (const [pid, page] of pages) if (!byFile.has(resolveFile(page.file))) byFile.set(resolveFile(page.file), pid);
  const wikiDir = resolveFile(ctx.wiki);
  const readme = resolveFile(path.join(ctx.root, "README.md"));

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
        const inWiki = path.dirname(resolved) === wikiDir || resolved === readme;
        if (inWiki || !fs.existsSync(resolved)) {
          fail(`${ctx.rel(page.file)} links to '${target}', but that page does not exist.`);
        }
        continue; // a normal repo doc, not a wiki page
      }
      if (tid !== pid) backlinks.get(tid).add(pid);
      if (!seen.has(key(pid, tid)) && !seen.has(key(tid, pid))) add(pid, tid, "link");
    }
  }
  const sorted = new Map([...backlinks].map(([k, v]) => [k, [...v].sort()]));
  return { edges, backlinks: sorted };
}

function hubAndDepth(pid, pages) {
  const chain = [pid];
  while (pages.get(chain[chain.length - 1]).parent !== null) {
    const next = pages.get(chain[chain.length - 1]).parent;
    if (chain.includes(next)) {
      fail(`the parents of '${pid}' loop back on themselves: ${chain.concat(next).join(" > ")}.`);
    }
    chain.push(next);
  }
  if (chain[chain.length - 1] !== CENTER) {
    fail(`'${pid}' does not hang from Oak (its top parent is '${chain[chain.length - 1]}').`);
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

// Fixed 2D positions: Oak at 0,0, hubs evenly on a ring, each hub's pages in
// a fan pointing away from Oak, then a fixed number of push-apart passes.
//
// nodes: list of {id, parent, depth}. Returns {id: [x, y]}.
// Deterministic: inputs are sorted and every step is plain arithmetic.
function layout(nodes, { ring = 320.0, step = 95.0, minDist = 58.0, iterations = 120 } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  const children = new Map();
  for (const n of nodes.slice().sort((a, b) => cmp(a.id, b.id))) {
    if (n.parent !== null && n.parent !== undefined) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n.id);
    }
  }
  const hubs = nodes.filter((n) => n.depth === 1).map((n) => n.id).sort(cmp);
  const pos = new Map(ids.has(CENTER) ? [[CENTER, [0.0, 0.0]]] : []);
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
  // Anything not reached (should not happen) sits on Oak.
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

// Plain code-point order, like Python's sorted() on strings.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------- team

// Parse docs/team.yml: a 'people:' list of '- key: value' blocks.
function parseTeam(text) {
  const people = [];
  let cur = null;
  for (const raw of splitlines(text)) {
    const line = raw.trimStart().startsWith("#") ? "" : raw.split(" #")[0].trimEnd();
    if (!line.trim() || line.trim() === "people:") continue;
    let stripped = line.trim();
    if (stripped.startsWith("- ")) {
      cur = Object.create(null);
      people.push(cur);
      stripped = stripped.slice(2).trim();
    }
    if (cur === null || !stripped.includes(":")) continue;
    const [key, value] = splitMax(stripped, ":", 1);
    cur[key.trim()] = parseValue(value);
  }
  const fields = ["id", "name", "github", "color", "discord_id", "focus"];
  const out = [];
  for (const p of people) {
    if (!p.id) continue;
    const rec = {};
    for (const f of fields) rec[f] = typeof p[f] === "string" ? p[f] : "";
    const past = "past" in p ? p.past : [];
    rec.past = Array.isArray(past) ? past : past ? [past] : [];
    out.push(rec);
  }
  return out;
}

function loadTeam(ctx) {
  if (!fs.existsSync(ctx.team)) {
    ctx.warn(`no ${ctx.rel(ctx.team)}; building without people.`);
    return [];
  }
  return parseTeam(readText(ctx.team));
}

// Team id for a GitHub login or a git author name/email, else null.
function matchPerson(people, { login = null, name = null, email = null } = {}) {
  if (email) {
    const m = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email);
    if (m) login = login || m[1];
  }
  if (login) {
    for (const p of people) if (p.github && p.github.toLowerCase() === login.toLowerCase()) return p.id;
  }
  if (name) {
    const n = name.trim().toLowerCase();
    const words = n.split(/\s+/).filter(Boolean);
    const first = words.length ? words[0] : "";
    for (const p of people) if ([p.github.toLowerCase(), p.name.toLowerCase(), p.id].includes(n)) return p.id;
    for (const p of people) if (first && first === p.name.toLowerCase()) return p.id;
  }
  return null;
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
    ctx.warn("git log failed; building without history.");
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

// Only program code counts as "worked on", not docs, configs at the root or Docker.
const CODE_ROOTS = ["src/", "host_tools/", "go2_map_viewer_julia/"];
const BULK_COMMIT_FILES = 60;
const isCode = (f) => CODE_ROOTS.some((r) => f.startsWith(r));

// The src/ folder names the wiki pages claim.
function srcPackages(pages) {
  const out = new Set();
  for (const page of pages.values()) {
    for (const g of page.code) if (g.startsWith("src/") && g.split("/").length - 1 >= 1) out.add(g.split("/")[1]);
  }
  return out;
}

// Map a pre-src/ path (go2_llm_agent/x.py) to today's layout (src/go2_llm_agent/x.py).
//
// go2-fusion's packages moved under src/ on 2026-10-20; older branches still
// use the root layout, and their work should land on the same pages.
// `packages` is the set of src/ folder names the wiki pages claim.
function codePath(f, packages) {
  if (f.includes("/") && !isCode(f) && packages.has(f.split("/")[0])) return "src/" + f;
  return f;
}

// Pages each person has worked on, from git: {person id: [slug, ...]}.
//
// A commit counts for a page when it touches program code (CODE_ROOTS) that
// the page's code: paths cover. Docs, wiki edits and bulk moves don't count:
// writing about a program or moving folders isn't working on it. Pages are
// sorted by that person's commit count (ties by slug), top `limit`. The
// center page (README.md) is left out: everyone edits it.
function contributions(commits, pages, people, ctx, limit = 8) {
  const counts = new Map(people.map((p) => [p.id, new Map()]));
  const packages = srcPackages(pages);
  for (const c of commits) {
    const pid = matchPerson(people, { name: c.author, email: c.email });
    if (pid === null) continue;
    if (c.files.length > BULK_COMMIT_FILES) continue; // a repo-wide move or cleanup says nothing about who works on what
    const codeFiles = c.files.map((f) => codePath(f, packages)).filter(isCode);
    for (const page of pagesForFiles(codeFiles, pages, ctx)) {
      if (page !== CENTER) counts.get(pid).set(page, (counts.get(pid).get(page) || 0) + 1);
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
// files changed since the branch left it. Files in the pre-src/ layout land
// on today's pages, as in contributions().
function activeBranches(refs, pages, people, work, now, info, ctx, days = BRANCH_DAYS) {
  const cutoff = now - days * DAY_MS;
  const packages = srcPackages(pages);
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
      pages: pagesForFiles(files.map((f) => codePath(f, packages)), pages, ctx),
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
    ctx.warn(`no ${ctx.baseRef}; building without active branches.`);
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

// Every page of a GitHub API list, following the Link: rel="next" header.
async function getAll(token, repo, apiPath) {
  let url = `https://api.github.com/repos/${repo}/${apiPath}`;
  const out = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "hypatia-build" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}: ${res.statusText}`);
    out.push(...(await res.json()));
    const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") || "");
    url = m ? m[1] : null;
  }
  return out;
}

// Return { work, questions }. Empty lists without a token or on errors.
async function fetchGithub(pages, people, ctx) {
  const { token, repo } = ctx;
  if (!token || !repo) return { work: [], questions: [] };
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
    return { work: [], questions: [] };
  }
  work.sort((a, b) => cmp(b.updated_at, a.updated_at));
  questions.sort((a, b) => cmp(b.updated_at, a.updated_at));
  return { work, questions };
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
//   token    GitHub read token, or null (no work or questions then)
//   repo     owner/name; defaults to GITHUB_REPOSITORY, then the origin remote
//   env      environment for WIKI_BRANCH / GITHUB_REF_NAME (default process.env)
//   warn     called with each warning (default: printed to stderr)
function context(opts) {
  const root = path.resolve(opts.root);
  const env = opts.env || process.env;
  const ctx = {
    root,
    env,
    wiki: path.join(root, "docs", "wiki"),
    team: path.join(root, "docs", "team.yml"),
    token: opts.token || null,
    repo: opts.repo || env.GITHUB_REPOSITORY || repoSlug(root),
    baseRef: opts.baseRef || baseRef(root),
    warn: opts.warn || ((msg) => console.error(`hypatia: ${msg}`)),
    rel: (file) => path.relative(root, file).split(path.sep).join("/"),
  };
  return ctx;
}

async function buildGraph(opts) {
  const ctx = context(opts);
  if (!fs.existsSync(ctx.wiki) || !fs.statSync(ctx.wiki).isDirectory()) fail(`no wiki folder at ${ctx.rel(ctx.wiki)}.`);
  const pages = loadPages(ctx);
  const { edges, backlinks } = collectEdges(pages, ctx);
  const people = loadTeam(ctx);
  const { last, recent } = history(gitCommits(ctx), pages, people, ctx);
  const contributed = contributions(gitCommits(ctx, { allBranches: true }), pages, people, ctx);
  for (const p of people) {
    const unknown = p.past.filter((s) => !pages.has(s));
    if (unknown.length) ctx.warn(`${ctx.rel(ctx.team)}: ${p.id} has past pages that do not exist: ${unknown.join(", ")}.`);
    p.past = p.past.filter((s) => pages.has(s));
    p.contributed = contributed.get(p.id) || [];
    p.worked_on = [...new Set([...p.past, ...p.contributed])];
  }
  const { work, questions } = await fetchGithub(pages, people, ctx);
  const branches = fetchBranches(pages, people, work, ctx);

  const nodes = [];
  for (const [pid, page] of pages) {
    const [hub, depth] = hubAndDepth(pid, pages);
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
    });
  }
  const positions = layout(nodes);
  for (const n of nodes) [n.x, n.y] = positions[n.id];

  const [branch, published] = githubBranch(ctx);
  return {
    version: 2,
    branch,
    base: ctx.baseRef.split("/").pop(), // the main branch new work starts from
    published,
    generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    repo: ctx.repo,
    people,
    nodes,
    edges,
    work,
    questions,
    recent,
    branches,
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
  CENTER,
  WikiError,
  buildGraph,
  describe,
  repoSlug,
  // the parts below are exported for the tests
  parseFrontMatter,
  parseTeam,
  matchPerson,
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
  BULK_COMMIT_FILES,
};
