// The skill and workflow templates (skills/, templates/) and the
// placeholders in them, filled at install time (milestone 3).
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

const TEMPLATES = ["skills/wiki-keeper/SKILL.md", "templates/workflows/wiki-site.yml", "templates/workflows/wiki-refresh.yml"];

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

module.exports = { PLACEHOLDERS, TEMPLATES, placeholders, fill, read };
