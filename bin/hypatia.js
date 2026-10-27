#!/usr/bin/env node
// Hypatia: a graph-style team wiki for any git repo.
//
//   hypatia serve [--port <n>] [--no-open]   open this repo's wiki locally, with live reload
//   hypatia build [--out <folder>]           write the site and its data to a folder (default _site)
//   hypatia check                            check the pages and the privacy guard without writing anything
//   hypatia init [--yes] [--dry-run]         set Hypatia up in this repo
//
// Run it from anywhere inside the repo; it works on the repo's top folder.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { buildGraph, describe, WikiError } = require("../lib/build-graph");
const { serve, graphScript, SITE } = require("../lib/serve");
const { loadConfig } = require("../lib/team");
const privacy = require("../lib/privacy");
const { init } = require("../lib/init");
const { lint } = require("../lib/lint");

const HELP = `Hypatia - a graph-style team wiki for any git repo.

Usage, from inside a repo:
  hypatia init [--dry-run] [--yes] [--public | --private] [--runner "<command>"]
      Sets Hypatia up in this repo: a docs/wiki/ folder with a starter page,
      the wiki-keeper agent skill, and a way to open the wiki locally. A
      public repo also gets the GitHub Pages workflow and the website link in
      its About box, after you say yes. Never overwrites a file; safe to run
      again. --dry-run only prints the plan.
  hypatia serve [--port <number>] [--no-open]
      Builds the wiki for this repo, serves it at http://localhost:4410/,
      opens your browser and reloads it when README.md, docs/wiki/ or
      docs/hypatia.yml change. Stop it with Ctrl+C.
  hypatia build [--out <folder>]
      Writes the site and its data (graph.json, graph.js) to a folder,
      _site by default, ready for GitHub Pages or any static server. Pages
      marked "private: true" are left out. Stops, writing nothing, when the
      privacy guard finds an email, phone number, ID number or key.
  hypatia check
      Checks the wiki pages (front matter, parents, links, code: paths that
      match no file) and runs the privacy guard, and says what to fix. Also
      warns about hub pages README.md does not lead to, and counts TODO(
      markers. Writes nothing; exits with 1 when
      a page has a problem.

The team comes from git history, and from GitHub when it can be read. The
optional docs/hypatia.yml sets the title, names, colors and focus lines.

GitHub data (who is working on what, questions, logins) is read when
GITHUB_TOKEN is set or the GitHub CLI is signed in (gh auth login).`;

// The repo's top folder, or the current folder outside git.
function repoRoot(cwd) {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : path.resolve(cwd);
}

function parseBuildArgs(argv) {
  const opts = { out: "_site" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out" || a.startsWith("--out=")) {
      opts.out = a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[++i];
      if (!opts.out) throw new Error("--out needs a folder name.");
    } else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`Unknown option "${a}". Try --out <folder>.`);
  }
  return opts;
}

// `hypatia build`: the site files plus this repo's data, in one folder. The
// GitHub token comes from GITHUB_TOKEN only (as in GitHub Actions).
async function build(root, argv) {
  let opts;
  try {
    opts = parseBuildArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (opts.help) {
    console.log("hypatia build [--out <folder>]");
    return 0;
  }
  let graph;
  try {
    graph = await buildGraph({ root, token: process.env.GITHUB_TOKEN || null, publish: true });
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
    return 1;
  }
  const hits = privacy.scanSite(root, graph, { allow: loadConfig(root).allow });
  if (hits.length) {
    console.error(privacyReport(hits, "Nothing was written: the site would publish"));
    return 1;
  }
  const out = path.resolve(process.cwd(), opts.out);
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(SITE)) fs.copyFileSync(path.join(SITE, name), path.join(out, name));
  fs.writeFileSync(path.join(out, "graph.json"), JSON.stringify(graph, null, 1), "utf8");
  fs.writeFileSync(path.join(out, "graph.js"), graphScript(graph), "utf8");
  const shown = path.relative(process.cwd(), out);
  console.log(`Wrote ${shown && !shown.startsWith("..") ? shown : out}: ${describe(graph)}`);
  return 0;
}

// `hypatia check`: the same checks as a build, nothing written, no GitHub.
async function check(root, argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("hypatia check");
    return 0;
  }
  if (argv.length) {
    console.error(`Unknown option "${argv[0]}". hypatia check takes no options.`);
    return 2;
  }
  try {
    const excluded = [];
    const graph = await buildGraph({ root, token: null, publish: true, excluded, warn: (msg) => console.error(`hypatia: ${msg}`) });
    const { allow } = loadConfig(root);
    const hits = privacy.scanSite(root, graph, { allow });
    const logins = graph.people.map((p) => p.github);
    const local = privacy.scanFiles(root, excluded.map((e) => e.path), { allow, logins });
    if (local.length) {
      console.error(`hypatia: private pages (never published) mention:\n${privacy.describeHits(local).map((l) => "  " + l).join("\n")}`);
    }
    const found = lint(root, graph);
    for (const w of found.warnings) console.error(`hypatia: warning: ${w}`);
    for (const e of found.errors) console.error(`hypatia: ${e}`);
    const { count, pages } = found.todos;
    const todoLine = count ? `${count} TODO( ${count === 1 ? "marker" : "markers"} left in ${pages.length} ${pages.length === 1 ? "page" : "pages"}: ${pages.join(", ")}.` : "";
    if (hits.length) console.error(privacyReport(hits, "The wiki check failed: the public site would show"));
    if (hits.length || found.errors.length) {
      if (!hits.length) console.error("hypatia: the wiki check failed.");
      if (todoLine) console.log(todoLine);
      return 1;
    }
    const kept = excluded.length ? `, ${excluded.length} private ${excluded.length === 1 ? "page" : "pages"} left out` : "";
    console.log(`Wiki check passed: ${graph.nodes.length} pages, ${graph.edges.length} links and parents${kept}, no personal data or keys found.`);
    if (todoLine) console.log(todoLine);
    return 0;
  } catch (err) {
    if (!(err instanceof WikiError)) throw err;
    console.error(`hypatia: ${err.message}`);
    return 1;
  }
}

// What the privacy guard found, masked, and how to clear it.
function privacyReport(hits, lead) {
  return (
    `hypatia: ${lead} personal data or secrets:\n` +
    privacy.describeHits(hits).map((l) => "  " + l).join("\n") +
    "\n\nRemove them from the page (use made-up values like user@example.com), mark the page" +
    '\n"private: true" to keep it off the website, or, if a value is safe to publish, list it' +
    "\nunder allow: in docs/hypatia.yml." +
    (hits.some((h) => h.file.toLowerCase() === "readme.md") ? "\nREADME.md is the home page and is always published: edit it instead." : "") +
    (hits.some((h) => !h.page)
      ? "\nSite data (commit messages, branch names, issue titles) is published too. Git history can't be edited" +
        "\nsafely, so list a value already in it under allow: if it is safe, and keep it out of new ones."
      : "")
  );
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return command ? 0 : 2;
  }
  const root = repoRoot(process.cwd());
  if (command === "init") return init(root, rest);
  if (command === "serve") return serve(root, rest);
  if (command === "build") return build(root, rest);
  if (command === "check") return check(root, rest);
  console.error(`Unknown command "${command}".\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
);
