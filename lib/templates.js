// The skill and workflow templates (skills/, templates/) and the
// placeholders in them, filled by `hypatia init`.
//
// A placeholder is {{NAME}} in capitals, with no "$" in front (so GitHub
// Actions expressions such as ${{ github.token }} are left alone).
"use strict";

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

module.exports = { PLACEHOLDERS, TEMPLATES, placeholders, fill, read, stripNote, render };
