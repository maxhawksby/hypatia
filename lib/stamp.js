// Stamps: a page's `verified:` line pins it to the code it explains.
//
// A stamp is 12 hex characters of a sha256 over every file the page's
// `code:` globs match (sorted by path; each path and its contents, with CRLF
// turned into LF so a Windows checkout gives the same stamp). Files git
// ignores never count. `hypatia verify <page>` writes the stamp after an
// agent (or person) rereads the page against its code; `hypatia check`
// recomputes it, and a page whose stamp no longer matches is stale.
//
// Node built-ins only.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { matches } = require("./globs");
const { readText } = require("./text");
const { repoFiles } = require("./lint");

const STAMP_LENGTH = 12;
const STAMP_RE = /^[0-9a-f]{12}$/;

// build-graph.js will read stamps for graph.json, so it is required lazily
// here to keep the two files from loading each other half done.
const frontMatter = (text, file) => require("./build-graph").parseFrontMatter(text, file);

// Every file in the repo (git's view: tracked plus new, ignored files left
// out), or a plain walk of the folder outside git.
function allFiles(root) {
  const files = repoFiles(root);
  if (files) return files;
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out;
}

// The files a page's globs match, sorted. A tracked file deleted from the
// working tree is gone, so it no longer counts.
function codeFiles(root, globs, files = allFiles(root)) {
  if (!globs || !globs.length) return [];
  const seen = new Set();
  for (const f of files) if (!seen.has(f) && matches(f, globs)) seen.add(f);
  return [...seen].filter((f) => fs.existsSync(path.join(root, f)) || isLink(path.join(root, f))).sort();
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// A file's bytes with CRLF as LF. A symlink counts as where it points.
function contents(file) {
  if (isLink(file)) return Buffer.from(`link:${fs.readlinkSync(file)}`, "utf8");
  const buf = fs.readFileSync(file);
  return buf.includes(13) ? Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1") : buf;
}

function hashFiles(root, files) {
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel, "utf8");
    h.update("\0");
    const body = contents(path.join(root, rel));
    h.update(String(body.length));
    h.update("\0");
    h.update(body);
  }
  return h.digest("hex").slice(0, STAMP_LENGTH);
}

// The stamp for the code these globs cover right now.
function codeStamp(root, globs, files) {
  return hashFiles(root, codeFiles(root, globs, files));
}

// The `verified:` value in a page's front matter, or "".
function storedStamp(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return "";
  const [fields] = frontMatter(readText(file), rel);
  const v = fields && typeof fields.verified === "string" ? fields.verified.trim().toLowerCase() : "";
  return v;
}

// pages: [{ path, code }] (repo-relative paths). Returns a Map from each
// page's path to { state, stored, actual }:
//   current     the stamp matches its code
//   stale       the code changed since the stamp was written
//   unverified  the page has code: but no verified: line
//   none        the page has no code:, so there is nothing to stamp
function pageStamps(root, pages) {
  const out = new Map();
  let files = null;
  for (const page of pages) {
    const code = page.code || [];
    const stored = storedStamp(root, page.path);
    if (!code.length) {
      out.set(page.path, { state: "none", stored, actual: "" });
      continue;
    }
    if (files === null) files = allFiles(root);
    const actual = codeStamp(root, code, files);
    const state = !stored ? "unverified" : stored === actual ? "current" : "stale";
    out.set(page.path, { state, stored, actual });
  }
  return out;
}

// The page text with its `verified:` line set to stamp, every other byte
// kept: the line is replaced in place, or added as the front matter's last
// line. null when the text has no front matter.
function setVerified(text, stamp) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = text.slice(0, end);
  const line = /^verified:[^\r\n]*/m;
  if (line.test(block)) return block.replace(line, `verified: ${stamp}`) + text.slice(end);
  const eol = block.endsWith("\r") ? "\r\n" : "\n";
  const head = block.endsWith("\r") ? block.slice(0, -1) : block;
  return `${head}${eol}verified: ${stamp}${block.endsWith("\r") ? "\r" : ""}${text.slice(end)}`;
}

// The wiki pages with code:, for `verify --all`: [{ path, code }].
function wikiCodePages(root) {
  const dir = path.join(root, "docs", "wiki");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const rel = `docs/wiki/${name}`;
    const page = readPage(root, rel);
    if (page && page.code.length) out.push(page);
  }
  return out;
}

// { path, code } for a page, or null when it has no front matter.
function readPage(root, rel) {
  const [fields] = frontMatter(readText(path.join(root, rel)), rel);
  if (!fields) return null;
  let code = fields.code || [];
  if (typeof code === "string") code = code ? [code] : [];
  return { path: rel, code };
}

const VERIFY_USAGE = "hypatia verify <page.md>... | --all";

// `hypatia verify`: write each page's stamp after it has been reread
// against its code. Edits only the verified: line.
function verifyCommand(root, argv, { cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  let all = false;
  const named = [];
  for (const a of argv) {
    if (a === "--all") all = true;
    else if (a === "--help" || a === "-h") {
      log(VERIFY_USAGE);
      return 0;
    } else if (a.startsWith("-")) {
      error(`Unknown option "${a}". Try ${VERIFY_USAGE}.`);
      return 2;
    } else named.push(a);
  }
  if (all === !!named.length) {
    error(`Name the pages you reread, or pass --all: ${VERIFY_USAGE}.`);
    return 2;
  }
  let pages;
  if (all) {
    pages = wikiCodePages(root);
    if (!pages.length) {
      log("No page has code:, so there is nothing to verify.");
      return 0;
    }
  } else {
    pages = [];
    for (const name of named) {
      const rel = path.relative(root, path.resolve(cwd, name)).split(path.sep).join("/");
      if (rel.startsWith("..") || !fs.existsSync(path.join(root, rel)) || !fs.statSync(path.join(root, rel)).isFile()) {
        error(`hypatia: ${name} is not a file in this repo. Name a wiki page, like docs/wiki/<name>.md.`);
        return 1;
      }
      let page;
      try {
        page = readPage(root, rel);
      } catch (err) {
        error(`hypatia: ${err.message}`);
        return 1;
      }
      if (!page) {
        error(`hypatia: ${rel} has no front matter, so it is not a wiki page.`);
        return 1;
      }
      if (!page.code.length) {
        log(`Skipped ${rel}: it has no code:, so there is no code to verify it against.`);
        continue;
      }
      pages.push(page);
    }
  }
  const files = allFiles(root);
  for (const page of pages) {
    const file = path.join(root, page.path);
    const text = fs.readFileSync(file, "utf8");
    const stamp = codeStamp(root, page.code, files);
    const count = codeFiles(root, page.code, files).length;
    const next = setVerified(text, stamp);
    const what = `${count} ${count === 1 ? "file" : "files"}`;
    if (next === text) {
      log(`${page.path} was already verified against its code (${what}, verified: ${stamp}).`);
      continue;
    }
    fs.writeFileSync(file, next);
    log(`Verified ${page.path} against its code (${what}): verified: ${stamp}.`);
  }
  return 0;
}

module.exports = { STAMP_LENGTH, STAMP_RE, codeStamp, codeFiles, pageStamps, setVerified, verifyCommand, allFiles };
