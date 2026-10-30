// Hypatia works for any repo: nothing in what it ships, or in what it builds
// for a repo of its own, names the project it came from. And the skill and
// workflow templates are ready to be filled at install time. `npm test`.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { spawnSync } = require("child_process");
const templates = require("../lib/templates");
const { makeRepo } = require("./helpers");

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "bin", "hypatia.js");
// Words from the project Hypatia was extracted from. Discord is not one of
// them: `hypatia ping` posts there for any team.
const FORBIDDEN = /oak|go2|team 48|\bros\b|ros 2|robot|maxhawksby|check_wiki|python|feature-revisions/i;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

// Hypatia's own repo, raw-file and website addresses (package.json links, the
// install guide check points to) are not leftovers.
const OWN_REPO = /((raw\.githubusercontent|github)\.com\/maxhawksby|maxhawksby\.github\.io)\/hypatia\b/g;

function assertClean(file) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const bad = lines.map((l, i) => [i + 1, l]).filter(([, l]) => FORBIDDEN.test(l.replace(OWN_REPO, "")));
  assert.deepStrictEqual(bad.map(([n, l]) => `${path.relative(ROOT, file)}:${n}: ${l.trim().slice(0, 100)}`), []);
}

test("no project-specific text in anything Hypatia ships", () => {
  const shipped = ["bin", "lib", "site", "skills", "templates"].flatMap((d) => files(path.join(ROOT, d))).concat(path.join(ROOT, "package.json"));
  assert.ok(shipped.length > 10);
  shipped.forEach(assertClean);
});

test("no project-specific text in a site built for another repo", () => {
  const repo = makeRepo({ generic: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "hypatia-out-"));
  try {
    const env = { ...process.env };
    delete env.GITHUB_TOKEN;
    const r = spawnSync(process.execPath, [CLI, "build", "--out", out], { cwd: repo.root, env, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    files(out).forEach(assertClean);
    const g = JSON.parse(fs.readFileSync(path.join(out, "graph.json"), "utf8"));
    assert.strictEqual(g.title, "Acme Notes");
  } finally {
    repo.cleanup();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("templates use only known placeholders, and fill completely", () => {
  const values = { REPO_SLUG: "acme/app", DEFAULT_BRANCH: "main", WIKI_DIR: "docs/wiki", CONFIG_FILE: "docs/hypatia.yml", HYPATIA: "npx hypatia" };
  for (const rel of templates.TEMPLATES) {
    const text = templates.read(rel);
    const used = templates.placeholders(text);
    assert.ok(used.length, `${rel} has no placeholders`);
    for (const name of used) assert.ok(name in templates.PLACEHOLDERS, `${rel}: unknown {{${name}}}`);
    const filled = templates.fill(text, values);
    assert.deepStrictEqual(templates.placeholders(filled), [], rel);
    if (rel.endsWith(".yml")) assert.match(filled, /\$\{\{ github\./, "GitHub Actions expressions are left alone");
  }
  assert.throws(() => templates.fill("{{DEFAULT_BRANCH}} {{NOPE}}", values), /no value for NOPE/);
  assert.throws(() => templates.fill("{{REPO_SLUG}}", {}), /no value for REPO_SLUG/);
});

test("the skill tells agents to check pages with hypatia, and keeps people's data off pages", () => {
  const skill = templates.read("skills/wiki-keeper/SKILL.md");
  assert.match(skill, /^---\nname: wiki-keeper\n/);
  assert.match(skill, /\{\{HYPATIA\}\} check/);
  assert.match(skill, /Pages describe how the code works, never real records, user names, emails or keys\./);
  assert.match(skill, /private: true/);
  const app = fs.readFileSync(path.join(ROOT, "site", "app.js"), "utf8");
  assert.match(app, /Run `hypatia check` until it passes/);
});

test("the skill is a librarian handbook: check before each commit, reread, verify, and ask before deleting pages", () => {
  const skill = templates.read("skills/wiki-keeper/SKILL.md");
  assert.match(skill, /## Before every commit that touches code a page covers/);
  assert.match(skill, /\{\{HYPATIA\}\} check --base origin\/\{\{DEFAULT_BRANCH\}\}/);
  assert.match(skill, /\{\{HYPATIA\}\} verify \{\{WIKI_DIR\}\}\/<slug>\.md/);
  assert.match(skill, /Rewrite only the sections the change affects/);
  assert.match(skill, /Verify only after you actually reread the code/);
  assert.match(skill, /Never delete or merge pages without asking the human first/);
  assert.match(skill, /wiki: no change needed for \{\{WIKI_DIR\}\}\/<slug>\.md - <reason>/);
  assert.match(skill, /each page you updated and why, one line each/);
  assert.match(skill, /Only with their okay, run `\{\{HYPATIA\}\} upgrade --yes`/);
  // the old rule (a page must change whenever its code does) and the global skip line are gone
  assert.doesNotMatch(skill, /drift: true/);
  assert.doesNotMatch(skill, /^wiki: no change needed - <reason>$/m);
  assert.doesNotMatch(skill, /\u2014/, "no em dashes");
  assert.ok(skill.split("\n").length <= 110, "the skill stays short");
});

test("workflow templates never put a GitHub expression inside a shell script, and the mirror runs on the default branch only", () => {
  for (const rel of templates.TEMPLATES.filter((t) => t.endsWith(".yml"))) {
    const lines = templates.read(rel).split("\n");
    let runIndent = null; // indent of the current run: key, while inside its script
    lines.forEach((line, i) => {
      const indent = line.length - line.trimStart().length;
      if (runIndent !== null && line.trim() && indent <= runIndent) runIndent = null;
      const run = /^(\s*)(?:- )?run:\s*(.*)$/.exec(line);
      if (run) {
        assert.doesNotMatch(run[2], /\$\{\{/, `${rel}:${i + 1}`);
        if (run[2].trim() === "|" || run[2].trim() === ">") runIndent = run[1].length;
      } else if (runIndent !== null) assert.doesNotMatch(line, /\$\{\{/, `${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  const mirror = templates.read("templates/workflows/wiki-mirror.yml");
  assert.match(mirror, /if: github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.doesNotMatch(mirror, /ref_name/);
});
