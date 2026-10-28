// The skill and workflow templates (skills/, templates/) and the
// placeholders in them, filled by `hypatia init` and `hypatia upgrade`.
//
// A placeholder is {{NAME}} in capitals, with no "$" in front (so GitHub
// Actions expressions such as ${{ github.token }} are left alone).
//
// An installed file carries a stamp: one comment line naming the Hypatia
// version that wrote it and a short hash of the rest of the file, e.g.
//   <!-- Made by Hypatia 0.3.0 (#1a2b3c4d). Run "hypatia upgrade" to update it. -->
// right after the skill's front matter, or the same as a "# " line at the top
// of a workflow. The version tells `hypatia check` the setup is old; the hash
// tells `hypatia upgrade` whether someone edited the file by hand.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

const PLACEHOLDERS = {
  REPO_SLUG: "owner/name on GitHub",
  DEFAULT_BRANCH: "the branch new work starts from and the site is built from",
  WIKI_DIR: "the folder of wiki pages, docs/wiki",
  CONFIG_FILE: "the optional Hypatia config, docs/hypatia.yml",
  HYPATIA: "how to run Hypatia in the repo, e.g. npx hypatia",
};

const TEMPLATES = [
  "skills/wiki-keeper/SKILL.md",
  "templates/workflows/wiki-site.yml",
  "templates/workflows/wiki-refresh.yml",
  "templates/workflows/wiki-check.yml",
  "templates/workflows/wiki-mirror.yml",
  "templates/workflows/wiki-ping.yml",
];

const PLACEHOLDER_RE = /(?<!\$)\{\{\s*([A-Z_]+)\s*\}\}/g;

// The placeholder names a template uses.
function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))].sort();
}

// The template with every placeholder filled; throws when one is unknown or
// has no value, so a half-filled file is never written.
function fill(text, values) {
  const missing = placeholders(text).filter((name) => !(name in PLACEHOLDERS) || !values[name]);
  if (missing.length) throw new Error(`no value for ${missing.join(", ")}`);
  return text.replace(PLACEHOLDER_RE, (_, name) => values[name]);
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The template without its note to Hypatia's own readers: the
// "<!-- Hypatia template ... -->" block in Markdown, or the "# Hypatia
// template" comment lines up to the first bare "#" in YAML.
function stripNote(text) {
  const md = text.replace(/\n<!--\s*Hypatia template[\s\S]*?-->\n\n?/, "\n");
  if (md !== text) return md;
  const lines = text.split("\n");
  if (!/^# Hypatia template/.test(lines[0])) return text;
  const end = lines.findIndex((l) => l.trim() === "#");
  return end < 0 ? text : lines.slice(end + 1).join("\n");
}

// A template ready to install: note removed, placeholders filled.
const render = (rel, values) => fill(stripNote(read(rel)), values);

// ---------------------------------------------------------------- stamps

const STAMP_RE = /^(?:<!--|#) Made by Hypatia (\S+) \(#([0-9a-f]{8})\)\..*$/m;
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 8);

// The file with its stamp added: after the front matter in Markdown, as the
// first line in YAML.
function stamp(text, rel, version) {
  const note = `Made by Hypatia ${version} (#${hash(text)}). Run "hypatia upgrade" to update it.`;
  if (!rel.endsWith(".md")) return `# ${note}\n${text}`;
  const front = /^---\n[\s\S]*?\n---\n/.exec(text);
  const at = front ? front[0].length : 0;
  return `${text.slice(0, at)}\n<!-- ${note} -->\n${text.slice(at)}`;
}

// The file without its stamp line: exactly what stamp() was given.
function unstamp(text) {
  const m = STAMP_RE.exec(text);
  if (!m) return text;
  const from = m[0].startsWith("#") ? m.index : Math.max(0, m.index - 1);
  return text.slice(0, from) + text.slice(m.index + m[0].length + 1);
}

// The stamp in a file: { version, edited } or null. edited is true when the
// rest of the file no longer matches the stamp's hash.
function readStamp(text) {
  const m = STAMP_RE.exec(text);
  return m ? { version: m[1], edited: hash(unstamp(text)) !== m[2] } : null;
}

// A template ready to install, stamped with the version installing it.
const renderStamped = (rel, values, version) => stamp(render(rel, values), rel, version);

module.exports = { PLACEHOLDERS, TEMPLATES, placeholders, fill, read, stripNote, render, stamp, unstamp, readStamp, renderStamped };
