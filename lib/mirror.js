// `hypatia mirror`: copies the published wiki into a clone of the repo's
// GitHub Wiki (<repo>.wiki.git), so the Wiki tab shows the same pages.
//
// The repo stays the source of truth; the Wiki tab is a read-only copy. For
// each published page (private pages are never mirrored) it:
// - drops the front matter,
// - points links between wiki pages at GitHub Wiki page names (README.md is
//   Home, docs/wiki/object-search.md is "Object-search", from its title),
// - points links to other repo files at GitHub (images at their raw file),
// - ends with "Edit this page in the repo: <link>".
// Every .md file already in the folder is removed first, so a page deleted
// from the repo disappears from the Wiki tab too. Like a build, it writes
// nothing when the privacy guard finds personal data or a key.
//
// Node built-ins only.
"use strict";

const fs = require("fs");
const path = require("path");
const { buildGraph, WikiError } = require("./build-graph");
const { loadConfig } = require("./team");
const privacy = require("./privacy");

const HOME = "Home";
const UNSAFE_NAME = /[\\/:*?"<>|#%]/g;
// [text](target) and ![alt](target "title"); the target may sit in <>.
const LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const FENCE_RE = /^\s*(```|~~~)/;

// The repo path a relative link points to, or null for an outside link or
// an anchor on the same page.
function resolveLink(pagePath, target) {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith("//") || target.startsWith("#")) return null;
  const file = target.split("#")[0].split("?")[0];
  if (!file) return null;
  const joined = file.startsWith("/") ? file.replace(/^\/+/, "") : path.posix.join(path.posix.dirname(pagePath), file);
  return path.posix.normalize(joined);
}

// The GitHub Wiki name for a page: its title with spaces as hyphens.
function wikiName(node, center) {
  if (node.id === center) return HOME;
  return String(node.title || "").replace(UNSAFE_NAME, "").trim().replace(/\s+/g, "-") || node.id;
}

// repo path -> wiki page name. Pages whose titles clash use their file name
// instead (file names are already unique).
function nameMap(graph) {
  const wanted = new Map(graph.nodes.map((n) => [n.path, wikiName(n, graph.center)]));
  const counts = new Map();
  for (const name of wanted.values()) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) || 0) + 1);
  const out = new Map();
  for (const n of graph.nodes) {
    const name = wanted.get(n.path);
    out.set(n.path, n.id === graph.center || counts.get(name.toLowerCase()) === 1 ? name : n.id);
  }
  return out;
}

// The page's text with its links rewritten (code blocks and inline code left alone).
function rewriteLinks(body, pagePath, names, repo, branch) {
  const blob = `https://github.com/${repo}/blob/${branch}/`;
  const raw = `https://github.com/${repo}/raw/${branch}/`;
  const fix = (whole, target, offset) => {
    const resolved = resolveLink(pagePath, target);
    if (resolved === null) return whole;
    const hash = target.includes("#") ? "#" + target.split("#").slice(1).join("#") : "";
    const to = names.has(resolved) ? names.get(resolved) + hash : whole.startsWith("!") ? raw + resolved : blob + resolved + hash;
    const at = whole.indexOf(target, whole.indexOf("]("));
    return whole.slice(0, at) + to + whole.slice(at + target.length);
  };
  let inFence = false;
  return body
    .split("\n")
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) => (part.startsWith("`") ? part : part.replace(LINK_RE, fix)))
        .join("");
    })
    .join("\n");
}

// One page as GitHub Wiki markdown.
function renderPage(node, names, repo, branch) {
  const text = node.markdown.replace(/^---\n[\s\S]*?\n---\n+/, ""); // README.md may have front matter too
  const body = rewriteLinks(text, node.path, names, repo, branch).replace(/^\n+|\n+$/g, "");
  return `${body}\n\n---\n\n_Edit this page in the repo: <https://github.com/${repo}/blob/${branch}/${node.path}>_\n`;
}

// Writes every page of graph into out; returns the file names written.
function mirror(graph, out, { repo, branch }) {
  const names = nameMap(graph);
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) if (name.endsWith(".md")) fs.rmSync(path.join(out, name));
  const written = [];
  for (const node of graph.nodes) {
    const file = names.get(node.path) + ".md";
    fs.writeFileSync(path.join(out, file), renderPage(node, names, repo, branch), "utf8");
    written.push(file);
  }
  return written.sort();
}

function parseArgs(argv) {
  const opts = { out: null, repo: null, branch: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(out|repo|branch)(?:=(.*))?$/.exec(a);
    if (m) {
      opts[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
      if (!opts[m[1]]) throw new Error(`--${m[1]} needs a value.`);
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --out <folder>, --repo <owner/name> or --branch <name>.`);
  }
  return opts;
}

// `hypatia mirror --out <folder> [--repo owner/name] [--branch name]`
async function mirrorCommand(root, argv, { log = console.log, error = console.error, env = process.env } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    error(err.message);
    return 2;
  }
  if (opts.help || !opts.out) {
    (opts.help ? log : error)("hypatia mirror --out <folder> [--repo <owner/name>] [--branch <name>]");
    return opts.help ? 0 : 2;
  }
  let graph;
  try {
    graph = await buildGraph({ root, token: null, publish: true, env, repo: opts.repo || undefined, warn: (m) => error(`hypatia: ${m}`) });
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    error(`hypatia: ${err.message}`);
    return 1;
  }
  if (!graph.repo) {
    error("hypatia: no GitHub repo to link to. Pass --repo <owner/name>.");
    return 2;
  }
  const hits = privacy.scanSite(root, graph, { allow: loadConfig(root).allow }).filter((h) => h.page);
  if (hits.length) {
    error(`hypatia: Nothing was written: the Wiki tab would show personal data or secrets:\n${privacy.describeHits(hits).map((l) => "  " + l).join("\n")}\nRun hypatia check for how to clear them.`);
    return 1;
  }
  const branch = opts.branch || env.WIKI_BRANCH || env.GITHUB_REF_NAME || graph.base || "main";
  const written = mirror(graph, path.resolve(process.cwd(), opts.out), { repo: graph.repo, branch });
  log(`Wrote ${written.length} wiki ${written.length === 1 ? "page" : "pages"}: ${written.join(", ")}`);
  return 0;
}

module.exports = { mirrorCommand, mirror, nameMap, renderPage, rewriteLinks, resolveLink };
